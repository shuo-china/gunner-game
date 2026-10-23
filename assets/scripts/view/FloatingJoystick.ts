import { EventTouch, Input, input, Node, UITransform, Vec3 } from 'cc';
import type { ScreenPoint } from '../core/types';
import { clampMovementInput } from '../core/ManualMovement';
import { ArtLibrary, makeNode } from './ArtLibrary';
import type { OriginalHudConfig } from './OriginalHudAssets';

export type MovementInputHandler = (direction: Readonly<ScreenPoint>, cancelled: boolean) => void;

/** Original SafeArea's first child: only empty battlefield pixels receive a start.
 * One captured pointer owns the gesture until release, even outside the safe rect. */
export class FloatingJoystick {
  readonly node: Node;
  private readonly background: Node;
  private readonly handle: Node;
  private pointer: number | null = null;
  private enabled = false;
  private destroyed = false;
  private center: ScreenPoint = { x: 0, y: 0 };

  constructor(parent: Node, art: ArtLibrary, private readonly config: OriginalHudConfig,
    private readonly onInput: MovementInputHandler) {
    this.node = makeNode('Floating Joystick', parent);
    this.background = art.image('Background', config.images.joystick_background, this.node);
    this.handle = art.image('Handle', config.images.joystick_handle, this.background);
    this.background.active = false;
    this.node.active = false;
    this.node.on(Node.EventType.TOUCH_START, this.start, this);
    this.node.on(Node.EventType.TOUCH_MOVE, this.move, this);
    this.node.on(Node.EventType.TOUCH_END, this.end, this);
    this.node.on(Node.EventType.TOUCH_CANCEL, this.cancel, this);
    // Also catches releases outside the originating node. Only the owning ID ends it.
    input.on(Input.EventType.TOUCH_END, this.end, this);
    input.on(Input.EventType.TOUCH_CANCEL, this.cancel, this);
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', this.cancelInteractions);
      window.addEventListener('mouseup', this.outsideMouseUp);
    }
  }

  resize(width: number, height: number, topInset: number, bottomInset: number): void {
    this.cancelInteractions();
    const scale = width / this.config.referenceWidth;
    this.node.setScale(scale, scale, 1);
    this.node.setPosition(0, (bottomInset - topInset) / 2, 0);
    this.node.getComponent(UITransform)!.setContentSize(width / scale, Math.max(0, height - topInset - bottomInset) / scale);
  }

  setEnabled(enabled: boolean): void {
    if (this.destroyed) return;
    if (!enabled && this.enabled) this.cancelInteractions();
    this.enabled = enabled; this.node.active = enabled;
  }

  readonly cancelInteractions = (): void => this.release(true);

  destroy(): void {
    if (this.destroyed) return;
    this.cancelInteractions(); this.destroyed = true;
    input.off(Input.EventType.TOUCH_END, this.end, this);
    input.off(Input.EventType.TOUCH_CANCEL, this.cancel, this);
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', this.cancelInteractions);
      window.removeEventListener('mouseup', this.outsideMouseUp);
    }
    this.node.destroy();
  }

  private point(event: EventTouch): ScreenPoint {
    const point = event.getUILocation();
    return this.node.getComponent(UITransform)!.convertToNodeSpaceAR(new Vec3(point.x, point.y, 0));
  }

  private start(event: EventTouch): void {
    event.propagationStopped = true;
    if (!this.enabled || this.destroyed || this.pointer !== null) return;
    this.pointer = event.getID() ?? -1;
    this.center = this.point(event);
    this.background.setPosition(this.center.x, this.center.y, 0);
    this.background.active = true;
    this.handle.setPosition(0, 0, 0);
    this.onInput({ x: 0, y: 0 }, false);
  }

  private move(event: EventTouch): void {
    if (this.pointer === null || this.pointer !== (event.getID() ?? -1)) return;
    event.propagationStopped = true;
    const point = this.point(event), radius = this.config.joystick.backgroundSize / 2;
    const direction = clampMovementInput({ x: (point.x - this.center.x) / radius, y: (point.y - this.center.y) / radius });
    const travel = radius * this.config.joystick.handleRange;
    this.handle.setPosition(direction.x * travel, direction.y * travel, 0);
    this.onInput(direction, false);
  }

  private end(event: EventTouch): void {
    if (this.pointer !== null && this.pointer === (event.getID() ?? -1)) this.release(false);
  }

  private cancel(event: EventTouch): void {
    if (this.pointer !== null && this.pointer === (event.getID() ?? -1)) this.release(true);
  }

  private readonly outsideMouseUp = (event: MouseEvent): void => {
    // Cocos routes normal canvas release through TOUCH_END. Browser releases
    // outside the canvas need an additional path, without cancelling touch IDs.
    if (event.button === 0 && (typeof HTMLCanvasElement === 'undefined' || !(event.target instanceof HTMLCanvasElement))) this.release(true);
  };

  private release(cancelled: boolean): void {
    if (this.destroyed) return;
    const captured = this.pointer !== null;
    this.pointer = null;
    this.background.active = false;
    this.handle.setPosition(0, 0, 0);
    if (captured || cancelled) this.onInput({ x: 0, y: 0 }, cancelled);
  }
}
