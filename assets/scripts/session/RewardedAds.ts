/** Shared rewarded-ad contract. Gameplay owns eligibility and durable rewards;
 * providers only report whether the player completed, cancelled or failed. */
export type RewardedAdOutcome = 'success' | 'cancel' | 'failure';
export type RewardedAdPlacement = import('./ContentConfig').ContentAdPlacement;
export interface RewardedAdPresenter {
  showRewardedAd(token: string, placement: RewardedAdPlacement, complete: (outcome: RewardedAdOutcome) => void): void;
  /** Silent cancellation: the caller separately cancels its gameplay token. */
  cancelRewardedAd(token: string): void;
}
export interface RewardedAdRequest { readonly id: string; readonly placement: RewardedAdPlacement; }
export interface RewardedAdProvider {
  /** Return request-scoped cleanup. Each platform provider maps video close
   * to success only when fully watched; load/show errors map to failure. */
  show(request: RewardedAdRequest, complete: (outcome: RewardedAdOutcome) => void): (() => void) | void;
  destroy?(): void;
}
interface PendingRequest {
  id: string; token: string; placement: RewardedAdPlacement; complete: (outcome: RewardedAdOutcome) => void;
  cleanup?: () => void;
}
let serviceSerial = 0;
const isOutcome = (value: unknown): value is RewardedAdOutcome => value === 'success' || value === 'cancel' || value === 'failure';

/** A single application-wide slot isolates callbacks from old views/providers.
 * Business tokens are deliberately not passed to an external advertising SDK. */
export class RewardedAdService implements RewardedAdPresenter {
  private readonly instanceId = ++serviceSerial;
  private requestSerial = 0;
  private pending: PendingRequest | null = null;
  private destroyed = false;
  constructor(private readonly provider: RewardedAdProvider, private readonly onChanged: () => void = () => {},
    private readonly isEnabled: (placement: RewardedAdPlacement) => boolean = () => true) {}
  get isPresenting(): boolean { return this.pending !== null; }

  showRewardedAd(token: string, placement: RewardedAdPlacement, complete: (outcome: RewardedAdOutcome) => void): void {
    if (this.destroyed || this.pending || !token || !this.isEnabled(placement)) { complete('failure'); return; }
    const pending: PendingRequest = { id: `rewarded:${this.instanceId}:${++this.requestSerial}`, token, placement, complete };
    this.pending = pending; this.onChanged();
    // onChanged may hide/destroy the owner before the provider opens.
    if (this.pending !== pending) return;
    if (!this.isEnabled(placement)) { this.finish(pending, 'cancel'); return; }
    try {
      const cleanup = this.provider.show({ id: pending.id, placement }, outcome => {
        this.finish(pending, isOutcome(outcome) ? outcome : 'failure');
      });
      if (cleanup) {
        if (this.pending === pending) pending.cleanup = cleanup;
        else cleanup(); // Also covers a synchronously completing provider.
      }
    } catch (_) { this.finish(pending, 'failure'); }
  }

  cancelRewardedAd(token: string): void {
    if (this.pending?.token === token) this.release(this.pending);
  }
  /** App hide/teardown resolves the business request as cancelled as well. */
  cancelAll(): void { if (this.pending) this.finish(this.pending, 'cancel'); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.cancelAll(); }
    finally { this.provider.destroy?.(); }
  }
  private finish(pending: PendingRequest, outcome: RewardedAdOutcome): void {
    if (this.pending !== pending) return;
    try { this.release(pending); }
    finally { pending.complete(this.isEnabled(pending.placement) ? outcome : 'cancel'); }
  }
  private release(pending: PendingRequest): void {
    this.pending = null;
    try { pending.cleanup?.(); }
    // SDK listener teardown must never strand a gameplay token or grant twice.
    catch (_) { /* This request is already invalidated. */ }
    finally { this.onChanged(); }
  }
}

/** Production remains unavailable until a real platform provider is connected. */
export class UnavailableRewardedAdProvider implements RewardedAdProvider {
  show(_request: RewardedAdRequest, complete: (outcome: RewardedAdOutcome) => void): void { complete('failure'); }
}

export interface SimulatedRewardedAdView { open(requestId: string): void; dismiss(): void; }
/** Test-only simulated implementation shared by the retained placements. */
export class SimulatedRewardedAdProvider implements RewardedAdProvider {
  private pending: { id: string; complete: (outcome: RewardedAdOutcome) => void } | null = null;
  constructor(private readonly view: SimulatedRewardedAdView) {}
  show(request: RewardedAdRequest, complete: (outcome: RewardedAdOutcome) => void): () => void {
    if (this.pending) throw new Error('A simulated rewarded ad is already open');
    const pending = { id: request.id, complete };
    this.pending = pending;
    try { this.view.open(request.id); }
    catch (error) { this.pending = null; this.view.dismiss(); throw error; }
    return () => {
      if (this.pending !== pending) return;
      this.pending = null; this.view.dismiss();
    };
  }
  resolve(requestId: string, outcome: RewardedAdOutcome): void {
    const pending = this.pending;
    if (!pending || pending.id !== requestId || !isOutcome(outcome)) return;
    this.pending = null; this.view.dismiss(); pending.complete(outcome);
  }
  destroy(): void { this.pending = null; this.view.dismiss(); }
}
