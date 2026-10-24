import { BlockInputEvents, Color, EventTouch, Graphics, Label, Node, UITransform } from 'cc';
import { makeNode } from './ArtLibrary';
import type { CloudSaveStatus } from '../session/CloudSaveStorage';

/** No downloaded art: account/save decisions must work before resource preparation. */
export class CloudSavePanel {
  private readonly root: Node;
  private readonly cover: Node;
  private readonly card: Node;
  private readonly title: Label;
  private readonly body: Label;
  private readonly status: Label;
  private readonly buttons: Node[] = [];
  private finish?: (index: number) => void;

  constructor(parent: Node, private readonly canInteract: () => boolean) {
    this.root = makeNode('CloudSaveUi', parent);
    this.status = this.label('CloudSaveStatus', this.root, 20);
    this.cover = makeNode('CloudSaveCover', this.root);
    this.cover.addComponent(BlockInputEvents); this.cover.addComponent(Graphics);
    this.card = makeNode('CloudSaveCard', this.cover); this.card.addComponent(Graphics);
    this.title = this.label('CloudSaveTitle', this.card, 32); this.title.isBold = true;
    this.body = this.label('CloudSaveBody', this.card, 25);
    for (let i = 0; i < 2; i++) {
      const button = makeNode('CloudSaveChoice' + i, this.card); button.addComponent(Graphics);
      this.label('Text', button, 27).isBold = true;
      button.on(Node.EventType.TOUCH_END, (event: EventTouch) => { event.propagationStopped = true; if (this.canInteract()) this.finish?.(i); });
      this.buttons.push(button);
    }
    this.cover.active = false; this.status.node.active = false; this.resize(720, 1280);
  }

  prompt(title: string, body: string, choices: readonly string[]): Promise<number> {
    if (this.finish) throw new Error('存档提示已打开');
    this.title.string = title; this.body.string = body;
    this.buttons.forEach((button, i) => { button.active = i < choices.length; button.getChildByName('Text')!.getComponent(Label)!.string = choices[i] ?? ''; });
    this.cover.active = true; this.root.setSiblingIndex(this.root.parent!.children.length - 1);
    return new Promise(resolve => { this.finish = index => { this.finish = undefined; this.cover.active = false; resolve(index); }; });
  }

  showProgress(title: string, body: string): void {
    this.title.string = title; this.body.string = body;
    this.buttons.forEach(button => { button.active = false; });
    this.cover.active = true; this.root.setSiblingIndex(this.root.parent!.children.length - 1);
  }

  sync(status: CloudSaveStatus, ready: boolean): void {
    const labels: Record<CloudSaveStatus, string> = { saved: '', pending: '', syncing: '正在同步进度…', offline: '进度已存本机 · 等待云端同步', conflict: '', blocked: '存档同步暂停' };
    if (this.status.string !== labels[status]) this.status.string = labels[status];
    this.status.node.active = ready && !!this.status.string;
    const siblings = this.root.parent!.children;
    if ((this.cover.active || this.status.node.active) && siblings[siblings.length - 1] !== this.root) this.root.setSiblingIndex(siblings.length - 1);
  }

  resize(width: number, height: number, topInset = 0): void {
    const s = Math.min(width / 720, height / 950), w = Math.min(width - 48 * s, 640 * s), h = 580 * s;
    this.cover.getComponent(UITransform)!.setContentSize(width, height);
    const bg = this.cover.getComponent(Graphics)!; bg.clear(); bg.fillColor = new Color(12, 23, 18, 225); bg.rect(-width / 2, -height / 2, width, height); bg.fill();
    this.card.getComponent(UITransform)!.setContentSize(w, h);
    const card = this.card.getComponent(Graphics)!; card.clear(); card.fillColor = new Color(34, 55, 43); card.roundRect(-w / 2, -h / 2, w, h, 24 * s); card.fill();
    this.place(this.title, w - 48 * s, 64 * s, 0, h / 2 - 65 * s, 32 * s);
    this.place(this.body, w - 56 * s, 240 * s, 0, 45 * s, 25 * s);
    this.buttons.forEach((button, i) => {
      const bw = w - 64 * s, bh = 74 * s;
      button.getComponent(UITransform)!.setContentSize(bw, bh); button.setPosition(0, -h / 2 + (i === 0 ? 158 : 66) * s);
      const g = button.getComponent(Graphics)!; g.clear(); g.fillColor = i === 0 ? new Color(88, 128, 64) : new Color(65, 81, 72); g.roundRect(-bw / 2, -bh / 2, bw, bh, 16 * s); g.fill();
      this.place(button.getChildByName('Text')!.getComponent(Label)!, bw - 20 * s, bh, 0, 0, 27 * s);
    });
    this.place(this.status, width - 30 * s, 38 * s, 0, height / 2 - topInset - 100 * s, 20 * s);
  }

  destroy(): void { this.finish?.(-1); this.root.destroy(); }
  private label(name: string, parent: Node, size: number): Label {
    const label = makeNode(name, parent).addComponent(Label);
    label.useSystemFont = true; label.fontFamily = 'Microsoft YaHei'; label.fontSize = size;
    label.color = new Color(255, 247, 222); label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER; label.enableWrapText = true; label.overflow = Label.Overflow.SHRINK;
    return label;
  }
  private place(label: Label, w: number, h: number, x: number, y: number, size: number): void {
    label.node.getComponent(UITransform)!.setContentSize(w, h); label.node.setPosition(x, y); label.fontSize = size; label.lineHeight = size * 1.45;
  }
}
