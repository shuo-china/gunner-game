import { RESOURCE_LOADING_POLICY } from './ResourceLoadingPolicy';

/** Admission control only. Already issued engine requests may still finish;
 * foreground requests never depend on this speculative-work clock. */
export class BackgroundPreparationScheduler {
  private nextAt = 0;
  private stable = 0;
  private reason = 'startup';
  private admitted = 0;
  private deferred = 0;
  private initialAt = 0;
  private lastAdmissionAt = 0;
  private forced = false;
  private forcedAdmissions = 0;

  constructor(private readonly now: () => number) { this.reset(); }

  reset(delayMs: number = RESOURCE_LOADING_POLICY.backgroundScheduling.startupDelayMs): void {
    const now = this.now();
    this.initialAt = this.nextAt = now + delayMs; this.lastAdmissionAt = now;
    this.stable = 0; this.reason = 'settling'; this.forced = false;
  }

  hasFrameHeadroom(dt: number, updateWorkMs: number): boolean {
    const policy = RESOURCE_LOADING_POLICY.backgroundScheduling;
    if (!Number.isFinite(dt) || dt < 0 || dt * 1000 > policy.slowFrameMs ||
      !Number.isFinite(updateWorkMs) || updateWorkMs < 0) return false;
    const frameMs = Math.max(policy.minFrameMs, Math.min(policy.maxFrameMs, dt * 1000));
    return updateWorkMs + RESOURCE_LOADING_POLICY.uiPreparation.frameBudgetMs + policy.frameReserveMs < frameMs;
  }

  allow(dt: number, updateWorkMs: number): boolean {
    const policy = RESOURCE_LOADING_POLICY.backgroundScheduling, now = this.now();
    this.forced = false;
    // A low-end device or periodic GC must not defer preparation forever.
    // This admission is exactly one small step; the caller must not spend its
    // normal multi-step UI budget when lastAdmissionForced is true.
    const validFrame = Number.isFinite(dt) && dt >= 0 && Number.isFinite(updateWorkMs) && updateWorkMs >= 0;
    if (validFrame && now >= this.initialAt && now - this.lastAdmissionAt >= policy.maxDeferralMs) {
      this.nextAt = now + policy.intervalMs; this.lastAdmissionAt = now;
      this.reason = 'progress'; this.forced = true; this.forcedAdmissions++; this.admitted++; return true;
    }
    // A 9 ms gameplay update still leaves room for the bounded 1 ms UI slice
    // at 30/60 Hz. A single hitch must not reset a half-second cooldown every
    // few frames and reduce an entire panel to one construction step/second.
    if (!this.hasFrameHeadroom(dt, updateWorkMs)) {
      this.nextAt = Math.max(this.nextAt, now + policy.busyFrameDelayMs); this.stable = 0;
      this.reason = 'busy-frame'; this.deferred++; return false;
    }
    this.stable = Math.min(this.stable + 1, policy.stableFrames);
    if (now < this.nextAt || this.stable < policy.stableFrames) {
      this.reason = this.stable < policy.stableFrames ? 'settling' : 'interval'; this.deferred++; return false;
    }
    this.nextAt = now + policy.intervalMs; this.lastAdmissionAt = now; this.reason = 'ready'; this.admitted++; return true;
  }

  get lastAdmissionForced(): boolean { return this.forced; }
  snapshot() { return { reason: this.reason, stableFrames: this.stable, admitted: this.admitted, deferred: this.deferred,
    forcedAdmissions: this.forcedAdmissions, idleMs: Math.max(0, this.now() - this.lastAdmissionAt) }; }
}
