import { _decorator, EventMouse, Node, ScrollView, Touch, Vec3 } from 'cc';

const { ccclass } = _decorator;

/** Collection ScrollRect physics, expressed in the source's seconds and local
 * canvas units. Cocos supplies hit testing, capture and child-click cancellation.
 * Unity uGUI ScrollRect.OnDrag/LateUpdate and Mathf.SmoothDamp are the reference:
 * https://github.com/Unity-Technologies/uGUI/blob/main/com.unity.ugui/Runtime/UGUI/UI/Core/ScrollRect.cs
 * https://github.com/Unity-Technologies/UnityCsReference/blob/master/Runtime/Export/Math/Mathf.cs */
@ccclass('OriginalWeaponScroll')
export class OriginalWeaponScroll extends ScrollView {
  /** Pooled cards follow drag and inertia in this same frame, before rendering. */
  onPositionChanged?: () => void;
  private decay = .135;
  private elasticity = .1;
  private sensitivity = 1;
  private movementType = 1;
  private dragging = false;
  private wheel = false;
  private velocity = 0;
  private dragStart = 0;
  private dragDistance = 0;
  private previousPosition = 0;
  private readonly localDelta = new Vec3();

  configure(source: Record<string, any>): void {
    this.horizontal = false; this.vertical = !!source.m_Vertical;
    this.inertia = !!source.m_Inertia; this.elastic = source.m_MovementType === 1;
    this.decay = source.m_DecelerationRate; this.elasticity = source.m_Elasticity;
    this.movementType = source.m_MovementType; this.sensitivity = source.m_ScrollSensitivity;
  }
  stopAutoScroll(): void {
    super.stopAutoScroll(); this.velocity = 0; this.dragging = false; this.dragDistance = 0; this.wheel = false;
  }
  protected _handlePressLogic(): void {
    super._handlePressLogic(); this.velocity = 0; this.dragging = true; this.dragDistance = 0;
    this.dragStart = this.previousPosition = this.content?.position.y || 0;
  }
  protected _handleMoveLogic(touch: Touch): void {
    if (!this.content || !this.dragging) return;
    this._getLocalAxisAlignDelta(this.localDelta, touch); this.dragDistance += this.localDelta.y;
    let position = this.dragStart + this.dragDistance;
    if (this.movementType !== 0) {
      const offset = this.offsetAt(position); position += offset;
      if (this.elastic && offset) {
        const size = this.view?.height || 1;
        position -= Math.sign(offset) * size * (1 - 1 / (Math.abs(offset) * .55 / size + 1));
      }
    }
    this.moveTo(position);
  }
  protected _handleReleaseLogic(_touch: Touch): void { this.dragging = false; this._onScrollBarTouchEnded(); }
  protected _onMouseWheel(event: EventMouse, captureListeners?: Node[]): void {
    if (!this.enabledInHierarchy || !this.content || this._hasNestedViewGroup(event, captureListeners)) return;
    // Keep Cocos's platform wheel-unit conversion; source ScrollSensitivity is
    // applied afterwards. Wheel movement does not seed a touch-drag velocity.
    let position = this.content.position.y - event.getScrollY() * .1 * this.sensitivity;
    if (this.movementType === 2) position += this.offsetAt(position);
    this.moveTo(position); this.wheel = true; this._stopPropagationIfTargetIsMe(event);
  }
  update(dt: number): void {
    if (!this.content || !(dt > 0)) return;
    let position = this.content.position.y;
    const offset = this.movementType === 0 ? 0 : this.offsetAt(position);
    if (!this.dragging) {
      if (this.elastic && offset) {
        const time = Math.max(.0001, this.elasticity * (this.wheel ? 3 : 1)), omega = 2 / time, x = omega * dt;
        const attenuation = 1 / (1 + x + .48 * x * x + .235 * x * x * x);
        const target = position + offset, change = -offset, temporary = (this.velocity + omega * change) * dt;
        this.velocity = (this.velocity - omega * temporary) * attenuation;
        const next = target + (change + temporary) * attenuation;
        if ((target > position) === (next > target)) { position = target; this.velocity = 0; }
        else position = next;
      } else if (this.inertia) {
        this.velocity *= Math.pow(this.decay, dt);
        if (Math.abs(this.velocity) < 1) this.velocity = 0;
        position += this.velocity * dt;
      } else this.velocity = 0;
      if (Math.abs(this.velocity) < 1) this.velocity = 0;
      if (this.movementType === 2) position += this.offsetAt(position);
      this.moveTo(position);
    } else if (this.inertia) {
      const instantaneous = (position - this.previousPosition) / dt;
      this.velocity += (instantaneous - this.velocity) * Math.min(1, dt * 10);
    }
    this.previousPosition = this.content.position.y; this.wheel = false;
  }
  private offsetAt(position: number): number {
    return this._getHowMuchOutOfBoundary(new Vec3(0, position - this.content!.position.y, 0)).y;
  }
  private moveTo(position: number): void {
    this._moveContent(new Vec3(0, position - this.content!.position.y, 0), false);
    this.onPositionChanged?.();
  }
}
