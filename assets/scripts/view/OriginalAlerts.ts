import { Color, Font, Graphics, Label, Node, UITransform } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import type { OriginalBitmapFont } from './OriginalBitmapText';
import { attachFontPolicyLabel } from './FontPolicyLabel';

interface AlertCurveKey { time: number; coefficients: number[]; }
interface OriginalAlertConfig {
  version: number; referenceWidth: number; poolSize: number; duration: number; fontPath: string;
  bitmapFont: OriginalBitmapFont;
  layout: { x: number; height: number; textHeight: number; fullCanvas: boolean };
  font: { family: string; scale: number; pointSize: number; ascent: number; descent: number;
    lineHeight: number; sizeMin: number; sizeMax: number; advances: Record<string, number> };
  messages: Record<string, string>;
  animation: { clipDuration: number; y: AlertCurveKey[]; backgroundAlpha: AlertCurveKey[]; textAlpha: AlertCurveKey[] };
}
export interface OriginalAlertAssets { config: OriginalAlertConfig; font: Font; }

export async function loadOriginalAlertAssets(art: ArtLibrary): Promise<OriginalAlertAssets> {
  const config = await art.json<OriginalAlertConfig>('art/ui-alert/config');
  if (config.version !== 1 || config.poolSize !== 1 || !config.layout.fullCanvas) throw new Error('Invalid original Alert');
  await Promise.all(config.bitmapFont.pages.map(path => art.loadFrame(path)));
  return { config, font: new Font() };
}

/** Unity's streamed clips store polynomial coefficients, not tween names. */
function sample(keys: AlertCurveKey[], time: number): number {
  let key = keys[0];
  for (let index = 1; index < keys.length && keys[index].time <= time; index++) key = keys[index];
  const t = Math.max(0, time - key.time), c = key.coefficients;
  return ((c[0] * t + c[1]) * t + c[2]) * t + c[3];
}

/** The original shared UI_manager.Alert pool contains one restartable message.
 * Keep this on the full Canvas: weapon popups and other callers share it. */
export class OriginalAlerts {
  readonly node: Node;
  private readonly background: Graphics;
  private readonly label: Label;
  private readonly assets: OriginalAlertAssets;
  private elapsed = 0;
  private width = 1080;
  private destroyed = false;
  private readonly textView: ReturnType<typeof attachFontPolicyLabel>;

  constructor(parent: Node, art: ArtLibrary, assets: OriginalAlertAssets) {
    this.assets = assets;
    this.node = makeNode('OriginalAlerts', parent);
    // Renderer colors affect descendants in Cocos. Use sibling renderers so
    // the black band's alpha is never multiplied into the text alpha.
    this.background = makeNode('Background', this.node).addComponent(Graphics);
    this.label = makeNode('Message', this.node).addComponent(Label);
    this.label.font = assets.font;
    this.label.color = new Color(255, 255, 255, 255);
    this.label.horizontalAlign = Label.HorizontalAlign.CENTER;
    this.label.verticalAlign = Label.VerticalAlign.CENTER;
    this.label.overflow = Label.Overflow.SHRINK;
    this.label.enableWrapText = true;
    this.textView = attachFontPolicyLabel(this.label, art, assets.config.bitmapFont);
    this.resize(1080, 1920);
    this.clear();
  }

  text(key: string, ...values: (string | number)[]): string {
    return (this.assets.config.messages[key] ?? key).replace(/\{(\d+)\}/g,
      (token, index: string) => values[Number(index)] === undefined ? token : String(values[Number(index)]));
  }

  showLocalized(key: string, ...values: (string | number)[]): void { this.show(this.text(key, ...values)); }

  show(text: string): void {
    if (this.destroyed) return;
    this.node.active = false;
    this.elapsed = 0;
    this.label.string = text.replace(/\\n/g, '\n');
    this.fitText();
    this.paint();
    this.node.active = true;
    this.node.setSiblingIndex((this.node.parent?.children.length ?? 1) - 1);
  }

  update(dt: number): void {
    if (this.destroyed || !this.node.active || !Number.isFinite(dt) || dt <= 0) return;
    this.elapsed += dt;
    // Destroy_Time is shorter than the 2.3167-second clip in the source.
    if (this.elapsed >= this.assets.config.duration) { this.clear(); return; }
    this.paint();
  }

  resize(width: number, height: number): void {
    if (this.destroyed || width <= 0 || height <= 0) return;
    const config = this.assets.config, scale = width / config.referenceWidth;
    this.width = width / scale;
    this.node.setScale(scale, scale, 1);
    this.node.getComponent(UITransform)!.setContentSize(this.width, config.layout.height);
    this.background.node.getComponent(UITransform)!.setContentSize(this.width, config.layout.height);
    this.label.node.getComponent(UITransform)!.setContentSize(this.width, config.layout.textHeight);
    this.fitText();
    this.paint();
  }

  clear(): void {
    if (this.destroyed) return;
    this.node.active = false;
    this.elapsed = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.clear();
    this.destroyed = true;
    this.textView.destroy();
    this.node.destroy();
  }

  private fitText(): void {
    const config = this.assets.config, font = config.font;
    // Mixed text measures the actual system glyphs; the old Chinese TTF
    // advances must not decide wrapping or shrink the Latin run as a whole.
    this.label.fontSize = font.sizeMax * font.scale;
    this.label.lineHeight = this.label.fontSize * font.lineHeight / font.pointSize;
  }

  private paint(): void {
    const config = this.assets.config, animation = config.animation;
    // The parent is the unscaled full Canvas. Scale the offset as well as the
    // child geometry; do not use the weapon HUD's SafeArea center.
    const scale = this.node.scale.x;
    this.node.setPosition(config.layout.x * scale, sample(animation.y, this.elapsed) * scale);
    this.background.clear();
    this.background.fillColor = new Color(0, 0, 0, Math.round(sample(animation.backgroundAlpha, this.elapsed) * 255));
    this.background.rect(-this.width / 2, -config.layout.height / 2, this.width, config.layout.height);
    this.background.fill();
    this.label.color = new Color(255, 255, 255, Math.round(sample(animation.textAlpha, this.elapsed) * 255));
    this.textView.sync();
  }
}
