import { BlockInputEvents, Color, EventTouch, Graphics, Label, Node, UITransform } from 'cc';
import type { RewardedAdOutcome } from '../session/RewardedAds';
import { makeNode } from './ArtLibrary';

/** Shared simulation view. Providers own requests; sessions own rewards. */
export class RewardedAdModal {
  readonly node: Node;
  private requestId: string | null = null;
  private generation = 0;
  private destroyed = false;
  private readonly touches = new Map<Node, { pointer: number; requestId: string; generation: number }>();

  constructor(parent: Node, private readonly onResult: (requestId: string, outcome: RewardedAdOutcome) => void) {
    this.node = this.panel('RewardedAdModal', parent, 1080, 1920, [0, 0, 0, 150]);
    this.node.addComponent(BlockInputEvents);
    const body = this.panel('AdPanel', this.node, 920, 490, [69, 49, 34, 255]);
    this.label(body, '模拟广告', 820, 190, 42).setPosition(0, 95);
    (['成功', '取消', '失败'] as const).forEach((caption, index) => {
      const button = this.panel(`Ad${index}`, body, 230, 98,
        index === 0 ? [119, 195, 89, 255] : [178, 131, 84, 255]);
      button.setPosition((index - 1) * 270, -130);
      this.label(button, caption, 220, 88, 36);
      button.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
        event.propagationStopped = true;
        if (!this.visible() || this.requestId === null || this.touches.has(button)) return;
        this.touches.set(button, { pointer: event.getID() ?? -1, requestId: this.requestId, generation: this.generation });
      });
      button.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => {
        event.propagationStopped = true;
        if (this.touches.get(button)?.pointer === (event.getID() ?? -1)) this.touches.delete(button);
      });
      button.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
        event.propagationStopped = true;
        const gesture = this.touches.get(button);
        if (gesture?.pointer !== (event.getID() ?? -1)) return;
        this.touches.delete(button);
        if (!this.visible() || this.requestId !== gesture.requestId || this.generation !== gesture.generation ||
            !button.getComponent(UITransform)!.getBoundingBoxToWorld().contains(event.getUILocation())) return;
        const id = gesture.requestId;
        this.dismiss();
        this.onResult(id, (['success', 'cancel', 'failure'] as const)[index]);
      });
    });
    this.dismiss();
  }

  get isOpen(): boolean { return !this.destroyed && this.requestId !== null; }
  open(requestId: string): void {
    if (this.destroyed) return;
    this.dismiss(); this.requestId = requestId; this.node.active = true;
    this.node.setSiblingIndex(this.node.parent!.children.length - 1);
  }
  dismiss(): void { this.generation++; this.requestId = null; this.touches.clear(); this.node.active = false; }
  cancelInteractions(): void { this.touches.clear(); }
  resize(width: number, height: number): void {
    if (this.destroyed || width <= 0 || height <= 0) return;
    this.cancelInteractions();
    const scale = width / 1080, virtualHeight = height / scale;
    this.node.setScale(scale, scale, 1);
    this.node.getComponent(UITransform)!.setContentSize(1080, virtualHeight);
    const graphic = this.node.getComponent(Graphics)!;
    graphic.clear(); graphic.rect(-540, -virtualHeight / 2, 1080, virtualHeight); graphic.fill();
  }
  destroy(): void { if (this.destroyed) return; this.dismiss(); this.destroyed = true; this.node.destroy(); }

  private visible(): boolean {
    if (this.destroyed) return false;
    for (let node: Node | null = this.node; node; node = node.parent) if (!node.active) return false;
    return true;
  }
  private panel(name: string, parent: Node, width: number, height: number, color: number[]): Node {
    const node = makeNode(name, parent); node.getComponent(UITransform)!.setContentSize(width, height);
    const graphic = node.addComponent(Graphics); graphic.fillColor = new Color(...color as [number, number, number, number]);
    graphic.rect(-width / 2, -height / 2, width, height); graphic.fill(); return node;
  }
  private label(parent: Node, value: string, width: number, height: number, size: number): Node {
    const node = makeNode('Caption', parent); node.getComponent(UITransform)!.setContentSize(width, height);
    const label = node.addComponent(Label); label.useSystemFont = true; label.fontSize = size; label.lineHeight = size * 1.14;
    label.string = value; label.color = Color.WHITE;
    label.horizontalAlign = Label.HorizontalAlign.CENTER; label.verticalAlign = Label.VerticalAlign.CENTER;
    return node;
  }
}
