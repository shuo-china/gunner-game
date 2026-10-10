import type { UpgradeType } from '../session/UpgradeEconomy';

/** Unity's pointer-down starts a delayed coroutine; Button.onClick buys on release.
 * Only one pointer owns a gesture. A cancelled gesture never becomes a click. */
export class UpgradeInput {
  private active?: { type: UpgradeType; pointer: number; elapsed: number; next: number; repeating: boolean };
  private enabled = false;

  constructor(private readonly buy: (type: UpgradeType) => boolean,
    private readonly delay = .4, private readonly interval = .1) {}

  get pressedType(): UpgradeType | undefined { return this.active?.type; }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  press(type: UpgradeType, pointer: number): boolean {
    if (!this.enabled || this.active) return false;
    this.active = { type, pointer, elapsed: 0, next: this.delay, repeating: true };
    return true;
  }

  release(pointer: number): boolean {
    if (!this.active || this.active.pointer !== pointer) return false;
    const type = this.active.type;
    this.active = undefined;
    return this.enabled && this.buy(type);
  }

  cancel(pointer?: number): void {
    if (pointer === undefined || this.active?.pointer === pointer) this.active = undefined;
  }

  update(dt: number): void {
    const active = this.active;
    if (!active || !this.enabled || !active.repeating || !Number.isFinite(dt) || dt <= 0) return;
    active.elapsed += dt;
    // Unity coroutines resume at most once per rendered frame, including after a
    // long frame; never replay a backlog of purchases after backgrounding.
    if (active.elapsed + 1e-8 < active.next) return;
    if (!this.buy(active.type)) active.repeating = false;
    active.next = active.elapsed + this.interval;
  }
}
