export type StartupPhase = 'login' | 'cloudRead' | 'offline' | 'cloudWrite' | 'core' | 'panels';
export type StartupOutcome = 'success' | 'failed' | 'cancelled';

interface PhaseTotals {
  attempts: number;
  active: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  totalMs: number;
}
interface PhaseState extends PhaseTotals { activeStartedMs: number; lastSequence: number; }
interface Attempt {
  phase: StartupPhase;
  attempt: number;
  startedAtMs: number;
  finishedAtMs: number | null;
  status: 'active' | StartupOutcome;
}
const PHASES: readonly StartupPhase[] = ['login', 'cloudRead', 'offline', 'cloudWrite', 'core', 'panels'];
const ATTEMPT_CAPACITY = 64;

/** Wall-clock startup diagnostics, anchored once to game.js (or bootstrap in
 * preview). Independent phases may overlap: summed phase time is not launch
 * time. Retry waits remain in elapsedMs without being attributed to a request.
 * Only phase names, counts and timings are retained, never account/error data. */
export class StartupTimeline {
  readonly bootStartedAt: number;
  private readonly phases = {} as Record<StartupPhase, PhaseState>;
  private readonly attempts: Attempt[] = [];
  private attemptCount = 0;
  private lastNow: number;
  private completedAt?: number;

  constructor(bootStartedAt: number, private readonly now: () => number = Date.now) {
    const fallback = Number.isFinite(bootStartedAt) ? bootStartedAt : this.now();
    this.bootStartedAt = Number.isFinite(fallback) ? fallback : 0;
    this.lastNow = this.bootStartedAt;
    for (const phase of PHASES) this.phases[phase] = {
      attempts: 0, active: 0, succeeded: 0, failed: 0, cancelled: 0, totalMs: 0,
      activeStartedMs: 0, lastSequence: 0,
    };
  }

  /** Each call is one attempt. The returned completion is idempotent, including
   * late callbacks. Concurrent attempts in the same phase are counted apart. */
  begin(phase: StartupPhase): (outcome?: StartupOutcome) => void {
    if (this.completedAt !== undefined) return () => {};
    const state = this.phases[phase], startedAtMs = this.elapsed();
    const attempt: Attempt = { phase, attempt: ++state.attempts, startedAtMs, finishedAtMs: null, status: 'active' };
    state.active++; state.activeStartedMs += startedAtMs; state.lastSequence = ++this.attemptCount;
    this.attempts.push(attempt);
    if (this.attempts.length > ATTEMPT_CAPACITY) this.attempts.shift();
    return (outcome = 'success'): void => {
      if (attempt.status !== 'active') return;
      attempt.finishedAtMs = this.elapsed(); attempt.status = outcome;
      state.active--; state.activeStartedMs -= startedAtMs;
      if (state.active === 0) state.activeStartedMs = 0;
      state.totalMs += attempt.finishedAtMs - startedAtMs;
      if (outcome === 'success') state.succeeded++;
      else if (outcome === 'failed') state.failed++;
      else state.cancelled++;
    };
  }

  async measureAsync<T>(phase: StartupPhase, work: () => T | PromiseLike<T>): Promise<T> {
    const finish = this.begin(phase);
    try { const result = await work(); finish(); return result; }
    catch (error) { finish('failed'); throw error; }
  }

  /** Freeze total launch time when gameplay becomes interactive. Later menu
   * dwell or background loading must not make the initial launch look slower. */
  complete(): void {
    if (this.completedAt === undefined) this.completedAt = this.readNow();
  }

  snapshot() {
    const capturedAt = this.readNow(), elapsedMs = (this.completedAt ?? capturedAt) - this.bootStartedAt;
    const phases = {} as Record<StartupPhase, PhaseTotals & { activeMs: number }>;
    const activePhases: StartupPhase[] = [];
    let currentPhase: StartupPhase | null = null, latest = 0;
    for (const phase of PHASES) {
      const { activeStartedMs, lastSequence, ...totals } = this.phases[phase];
      phases[phase] = { ...totals, activeMs: Math.max(0, totals.active * elapsedMs - activeStartedMs) };
      if (totals.active) {
        activePhases.push(phase);
        if (lastSequence > latest) { currentPhase = phase; latest = lastSequence; }
      }
    }
    return { bootStartedAt: this.bootStartedAt, capturedAt, elapsedMs, completed: this.completedAt !== undefined,
      currentPhase, activePhases, phases,
      attempts: this.attempts.map(attempt => ({ ...attempt,
        durationMs: (attempt.finishedAtMs ?? elapsedMs) - attempt.startedAtMs })),
      attemptCapacity: ATTEMPT_CAPACITY, droppedAttempts: Math.max(0, this.attemptCount - ATTEMPT_CAPACITY),
      clock: 'Date.now; fixed game.js boot epoch when available; excludes platform launch before game.js' };
  }

  private elapsed(): number { return (this.completedAt ?? this.readNow()) - this.bootStartedAt; }
  private readNow(): number {
    const value = this.now();
    if (Number.isFinite(value)) this.lastNow = Math.max(this.lastNow, value);
    return this.lastNow;
  }
}
