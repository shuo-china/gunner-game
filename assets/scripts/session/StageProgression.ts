/** Tree_manager's Main-mode progression, independent of Cocos and map generation. */
export const MAIN_ROUND_SECONDS = 180;
export type StagePhase = 'playing' | 'won' | 'failed' | 'loading' | 'reveal';
export interface StagePosition { stageIndex: number; waveIndex: number; }
export interface StageRound extends StagePosition { roundId: number; movementMultiplier: 1 | 2; }
export interface StageTransition {
  id: number; kind: 'win' | 'fail'; elapsed: number; loadingElapsed: number | null;
}
export interface StageSkip { id: number; elapsed: number; }
export interface StageModifiers { skipPercent: number; }
export interface StageProgressionOptions extends Partial<StageModifiers> { rng?: () => number; }

export function stageValue(position: StagePosition): number { return position.stageIndex * 10 + position.waveIndex; }
export function validateStagePosition(value: unknown): StagePosition {
  const candidate = value as Partial<StagePosition> | null;
  if (!candidate || !Number.isSafeInteger(candidate.stageIndex) || candidate.stageIndex! < 0 ||
      !Number.isInteger(candidate.waveIndex) || candidate.waveIndex! < 0 || candidate.waveIndex! > 4 ||
      !Number.isSafeInteger(candidate.stageIndex! * 10 + candidate.waveIndex!)) throw new Error('Invalid stage position');
  return { stageIndex: candidate.stageIndex!, waveIndex: candidate.waveIndex! };
}
export function nextStagePosition(position: StagePosition): StagePosition {
  return validateStagePosition(position.waveIndex === 4
    ? { stageIndex: position.stageIndex + 1, waveIndex: 0 }
    : { stageIndex: position.stageIndex, waveIndex: position.waveIndex + 1 });
}

export class StageProgression {
  private target: StagePosition;
  private activeRound: StageRound = { stageIndex: 0, waveIndex: 0, roundId: 0, movementMultiplier: 1 };
  private phaseValue: StagePhase = 'playing';
  private transitionValue?: StageTransition;
  private skipValue?: StageSkip;
  private transitionSerial = 0;
  private skipSerial = 0;
  private resultWait = 2;
  private loadingWait = 1.5;
  private revealElapsed = 0;
  private pendingSkip = false;
  private settledThisFrame = false;
  private remaining = MAIN_ROUND_SECONDS;
  private elapsedValue = 0;
  private options: Required<StageProgressionOptions>;

  constructor(position: StagePosition = { stageIndex: 0, waveIndex: 0 }, options: StageProgressionOptions = {}) {
    this.target = validateStagePosition(position);
    this.options = { skipPercent: options.skipPercent ?? 0, rng: options.rng ?? Math.random };
    this.configure(options);
  }
  get round(): StageRound { return { ...this.activeRound }; }
  get phase(): StagePhase { return this.phaseValue; }
  get canFight(): boolean { return this.phaseValue === 'playing' || this.phaseValue === 'reveal'; }
  get durationSeconds(): number { return MAIN_ROUND_SECONDS; }
  /** The ordinary Main round uses the source base 180-second divisor. */
  get timerBarSeconds(): number { return MAIN_ROUND_SECONDS; }
  get remainingSeconds(): number { return Math.max(0, this.remaining); }
  get elapsed(): number { return this.elapsedValue; }
  get transition(): StageTransition | undefined { return this.transitionValue ? { ...this.transitionValue } : undefined; }
  get skip(): StageSkip | undefined { return this.skipValue ? { ...this.skipValue } : undefined; }
  serialize(): StagePosition { return { ...this.target }; }

  configure(options: StageProgressionOptions): void {
    if (options.skipPercent !== undefined && (!Number.isFinite(options.skipPercent) || options.skipPercent < 0 || options.skipPercent > 100)) throw new Error('Invalid skip chance');
    if (options.skipPercent !== undefined) this.options.skipPercent = options.skipPercent;
    if (options.rng !== undefined) this.options.rng = options.rng;
  }
  setPosition(position: StagePosition): void { this.target = validateStagePosition(position); }

  /** Game_Exit stops an already scheduled Main restart before entering another
   * mode. Keep the durable position, but do not replay its transient skip FX. */
  cancelTransition(): void {
    this.transitionValue = undefined; this.skipValue = undefined; this.pendingSkip = false;
    this.settledThisFrame = false;
  }

  /** Rebirth clears both the displayed round and an already selected next wave.
   * In particular a pending relic skip must not leak into the new first round. */
  resetForRebirth(history: number): StageRound {
    this.target = { stageIndex: 0, waveIndex: 0 };
    this.pendingSkip = false;
    this.transitionValue = undefined; this.skipValue = undefined;
    this.resultWait = 2; this.loadingWait = 1.5;
    return this.startRound(history);
  }

  startRound(history: number, retainTransition = false): StageRound {
    this.activeRound = { ...this.target, roundId: this.activeRound.roundId + 1,
      movementMultiplier: stageValue(this.target) < history ? 2 : 1 };
    this.remaining = this.durationSeconds;
    this.elapsedValue = 0;
    this.settledThisFrame = false;
    this.phaseValue = retainTransition ? 'reveal' : 'playing';
    this.revealElapsed = 0;
    if (!retainTransition) { this.transitionValue = undefined; this.skipValue = undefined; }
    if (this.pendingSkip) { this.skipValue = { id: ++this.skipSerial, elapsed: 0 }; this.pendingSkip = false; }
    return this.round;
  }

  win(history: number): number | null {
    if (!this.canFight) return null;
    let next = nextStagePosition(this.target);
    this.pendingSkip = false;
    if (this.options.skipPercent > 0) {
      const random = this.options.rng();
      if (!Number.isFinite(random) || random < 0 || random >= 1) throw new Error('Stage RNG must return [0,1)');
      if (random * 100 < this.options.skipPercent) {
        const skipped = nextStagePosition(next);
        if (stageValue(skipped) < history) { next = skipped; this.pendingSkip = true; }
      }
    }
    this.target = next;
    const maximum = Math.max(history, stageValue(next));
    this.settle('win', maximum);
    return maximum;
  }

  private settle(kind: 'win' | 'fail', history: number): void {
    this.phaseValue = kind === 'win' ? 'won' : 'failed';
    this.transitionValue = { id: ++this.transitionSerial, kind, elapsed: 0, loadingElapsed: null };
    const replay = stageValue(this.target) < history;
    this.resultWait = replay ? 1 : 2;
    this.loadingWait = replay ? .75 : 1.5;
    this.settledThisFrame = true;
  }

  /** Call after combat and its events. Unity's coroutine fails on the next resume
   * after crossing zero; a last kill processed before that resume still wins. */
  advanceFrame(dt: number, history: number, paused = false, freezeTimer = false): StageRound | null {
    if (paused || !Number.isFinite(dt) || dt <= 0) return null;
    if (this.settledThisFrame) { this.settledThisFrame = false; return null; }
    if (this.skipValue) {
      this.skipValue.elapsed += dt;
      if (this.skipValue.elapsed >= 1.8) this.skipValue = undefined;
    }
    if (this.canFight) {
      // Game_Cor tests an already expired timer before checking is_Play.
      // Confirming rebirth after the preceding frame crossed zero still starts
      // Game_Fail/Loading_Then_Start; FX only prevents further time deduction.
      if (this.remaining <= 0) { this.settle('fail', history); this.settledThisFrame = false; return null; }
      if (!freezeTimer) {
        this.remaining -= dt;
        this.elapsedValue += dt;
      }
    }
    const transition = this.transitionValue;
    if (!transition) return null;
    transition.elapsed += dt;
    if (this.phaseValue === 'won' || this.phaseValue === 'failed') {
      if (transition.elapsed + 1e-10 >= this.resultWait) {
        this.phaseValue = 'loading'; transition.loadingElapsed = 0;
      }
    } else if (this.phaseValue === 'loading') {
      transition.loadingElapsed! += dt;
      if (transition.loadingElapsed! + 1e-10 >= this.loadingWait) return this.startRound(history, true);
    } else if (this.phaseValue === 'reveal') {
      transition.loadingElapsed! += dt;
      this.revealElapsed += dt;
      if (this.revealElapsed + 1e-10 >= .2) { this.transitionValue = undefined; this.phaseValue = 'playing'; }
    }
    return null;
  }
}
