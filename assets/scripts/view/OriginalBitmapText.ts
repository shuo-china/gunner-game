import { Color, Graphics, Label, Material, Node, Rect, Size, Sprite, SpriteFrame, UITransform, Vec2 } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';

interface Variant { page: number; rect: number[]; }
interface Glyph {
  advance: number; bearingX?: number; bearingY?: number; width?: number; height?: number;
  empty?: boolean; variants: Record<string, Variant>;
}
export interface OriginalBitmapFont {
  pages: string[]; glyphs: Record<string, Glyph>; pointSize: number; scale: number;
  ascent: number; descent: number; lineHeight: number;
  kerning?: Record<string, number[][]>;
}
export interface OriginalInlineGlyph { width: number; height: number; bearingX: number; bearingY: number; advance: number; scale: number; pointSize: number; disabledStrike?: boolean; }
export interface BitmapTextSpec {
  size: number; minSize?: number; maxSize?: number; autosize: boolean; wrap: boolean;
  horizontal: number; vertical: number; color: number[]; characterSpacing?: number; wordSpacing?: number; lineSpacing?: number;
  margin?: number[]; kerning?: boolean; spriteAsset?: string;
  /** Optional single-line Label metrics, expressed in the same units as size. */
  lineHeight?: number; layoutHeight?: number;
  /** Include baked outlines/shadows when fitting and aligning a constrained row. */
  fitGlyphBounds?: boolean;
  /** Match Chinese UI copy even when the label contains only Latin characters. */
  useSystemFont?: boolean;
  systemStyle?: SystemTextStyle;
}
export interface SystemTextStyle {
  /** Effect distances are fractions of the displayed font size. */
  outlineWidth?: number; outlineColor?: number[]; shadowOffset?: [number, number];
  shadowColor?: number[]; shadowBlur?: number; bold?: boolean; italic?: boolean;
}
interface Token { glyph?: Glyph; code?: string; system?: string; sprite?: string; line?: true; color?: number[]; }

/** Standalone Western display text retains its authored face. A label containing
 * Chinese uses the platform font for all text, including its Latin and digits. */
export function usesOriginalFontCharacter(character: string): boolean {
  return /^[\x20-\x7e\u00b1\u00d7\u00f7\u2212\u221e\u2264\u2265]$/.test(character);
}

function glyphVariant(glyph: Glyph, color: number[]): [string, Variant] | undefined {
  const entries = Object.entries(glyph.variants), rgb = color.slice(0, 3).join(',') + ',';
  return entries.find(([key]) => key.startsWith(rgb))
    ?? entries.find(([key]) => key.startsWith('255,255,255,')) ?? entries[0];
}

// Numeric advances can be reused across panels without sharing Label nodes or
// textures. A new ArtLibrary starts a new session/device-font measurement set.
const systemWidthCaches = new WeakMap<ArtLibrary, Map<string, number>>();
const SYSTEM_WIDTH_CACHE_LIMIT = 2048;
const SYSTEM_WIDTH_CACHE_MAX_KEY_LENGTH = 288;

/** The original TMP atlas contours and metrics, shared by every label.
 * Frames are views over ArtLibrary textures; destroying them never destroys
 * those borrowed textures. No per-frame texture uploads or font service calls. */
export class OriginalBitmapTextFactory {
  private readonly frames = new Map<string, SpriteFrame>();
  readonly systemWidthCache: Map<string, number>;
  constructor(readonly art: ArtLibrary, readonly fonts: Record<string, OriginalBitmapFont>,
    readonly inline: Record<string, OriginalInlineGlyph>, readonly inlinePaths: Record<string, string>,
    readonly spriteMaterial?: Material, readonly graphicsMaterial?: Material, readonly materialLayer?: number) {
    let widths = systemWidthCaches.get(art);
    if (!widths) { widths = new Map(); systemWidthCaches.set(art, widths); }
    this.systemWidthCache = widths;
  }
  rememberSystemWidth(key: string, width: number): void {
    // User-entered and changing numeric strings must not grow the session cache
    // indefinitely. Oversize runs still use the exact measurement, uncached.
    if (key.length > SYSTEM_WIDTH_CACHE_MAX_KEY_LENGTH) return;
    if (this.systemWidthCache.size >= SYSTEM_WIDTH_CACHE_LIMIT && !this.systemWidthCache.has(key))
      this.systemWidthCache.delete(this.systemWidthCache.keys().next().value!);
    this.systemWidthCache.set(key, width);
  }
  frame(font: OriginalBitmapFont, glyph: Glyph, color: number[]): SpriteFrame | null {
    const variant = glyphVariant(glyph, color)?.[1];
    if (!variant) return null;
    const key = font.pages[variant.page] + ':' + variant.rect.join(',');
    let frame = this.frames.get(key);
    if (!frame) {
      const source = this.art.frames.get(font.pages[variant.page]);
      if (!source) return null;
      frame = new SpriteFrame();
      const [x, y, width, height] = variant.rect;
      frame.reset({ texture: source.texture, rect: new Rect(x, y, width, height), originalSize: new Size(width, height), offset: new Vec2(0, 0) });
      this.frames.set(key, frame);
    }
    return frame;
  }
  destroy(): void { for (const frame of this.frames.values()) frame.destroy(); this.frames.clear(); }
}

/** Reuses glyph nodes when rewards/levels change; source RectTransforms still
 * determine the text box. TMP sprite glyphs share the same baseline and wrap. */
export class OriginalBitmapText {
  private readonly glyphNodes: Sprite[] = [];
  private readonly systemNodes: Label[] = [];
  private measuringLabel: Label | null = null;
  private readonly disabledStrikes = new Map<Sprite, Graphics>();
  private value = '';
  private color: number[];
  private revision = '';
  private destroyed = false;
  fontSize = 0;
  constructor(readonly node: Node, readonly spec: BitmapTextSpec, readonly font: OriginalBitmapFont,
    readonly factory: OriginalBitmapTextFactory) { this.color = spec.color; }

  /** Mixed bitmap/system runs retain their existing initial pool order. */
  canStageInitialText(value: string): boolean {
    const inline = /<sprite=\d+>/.test(value), visible = value.replace(/\\+n/g, '\n').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/\r/g, '');
    if (this.spec.useSystemFont || /[\u3400-\u9fff]/.test(visible)) return !inline;
    let bitmap = inline, system = false;
    for (const character of Array.from(visible)) {
      if (character === '\n') continue;
      if (usesOriginalFontCharacter(character) && this.font.glyphs[String(character.codePointAt(0))]) bitmap = true;
      else system = true;
      if (bitmap && system) return false;
    }
    return true;
  }

  /** Managed UI creation may stage text until its final text box is laid out. */
  setText(value: string, color?: number[], draw = true): void { this.value = value; if (color) this.color = color; if (draw) this.redraw(); }
  tint(color: number[], draw = true): void { this.color = color; if (draw) this.redraw(); }
  redraw(): void {
    if (this.destroyed) return;
    const tr = this.node.getComponent(UITransform)!;
    const margin = this.spec.margin ?? [0, 0, 0, 0], boxWidth = tr.width - margin[0] - margin[2], boxHeight = tr.height - margin[1] - margin[3];
    const revision = [this.value, this.color.join(','), tr.width, tr.height, tr.anchorX, tr.anchorY, JSON.stringify(this.spec)].join('|');
    if (revision === this.revision) return;
    this.revision = revision;
    const tokens: Token[] = [];
    const normalized = this.value.replace(/\\+n/g, '\n').replace(/<br\s*\/?\s*>/gi, '\n').replace(/\r/g, '');
    // Decide from visible text once per update, so changing progress, versions
    // and rich-text spans stay in the same face as their Chinese sentence.
    const systemText = this.spec.useSystemFont || /[\u3400-\u9fff]/.test(normalized.replace(/<[^>]*>/g, ''));
    const colors: number[][] = [];
    for (const chunk of normalized.split(/(<sprite=\d+>|<color=[^>]+>|<\/color>)/gi)) {
      const color = /^<color=["']?([^>"']+)["']?>$/i.exec(chunk);
      if (color) { colors.push(bitmapTagColor(color[1]) ?? colors[colors.length - 1] ?? this.color); continue; }
      if (/^<\/color>$/i.test(chunk)) { colors.pop(); continue; }
      const match = /^<sprite=(\d+)>$/.exec(chunk);
      if (match) tokens.push({ sprite: this.spec.spriteAsset ? `${this.spec.spriteAsset}-${match[1]}` : match[1] });
      else for (const ch of Array.from(chunk.replace(/<[^>]*>/g, ''))) {
        if (ch === '\n') tokens.push({ line: true });
        else {
          const code = String(ch.codePointAt(0)), glyph = !systemText && usesOriginalFontCharacter(ch) ? this.font.glyphs[code] : undefined;
          // Missing glyphs must remain readable, including user-entered Unicode.
          tokens.push({ glyph, code, system: glyph ? undefined : ch, color: colors[colors.length - 1] });
        }
      }
    }
    const measure = (size: number) => {
      const scale = size * this.font.scale / this.font.pointSize;
      // TMP characterSpacing/wordSpacing are expressed as a percentage of em.
      const spacing = (this.spec.characterSpacing ?? 0) * size * this.font.scale / 100;
      const rows: { tokens: { token: Token; x: number; y: number; scale: number }[]; width: number }[] = [{ tokens: [], width: 0 }];
      let systemRun = '', systemRunWidth = 0, systemRunColor = '';
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.line) { rows.push({ tokens: [], width: 0 }); systemRun = ''; systemRunWidth = 0; continue; }
        const inline = token.sprite && this.factory.inline[token.sprite];
        const tokenScale = inline ? (inline.pointSize ? size / inline.pointSize : this.font.ascent * scale / inline.height) * inline.scale : scale;
        if (token.sprite && !inline) continue;
        const before = this.spec.kerning && token.glyph && tokens[index - 1]?.glyph && this.font.kerning?.[tokens[index - 1]?.code + ':' + token.code]?.[1];
        const after = this.spec.kerning && token.glyph && tokens[index + 1]?.glyph && this.font.kerning?.[token.code + ':' + tokens[index + 1]?.code]?.[0];
        const adjust = [0, 1, 2].map(channel => (before ? before[channel] : 0) + (after ? after[channel] : 0));
        const systemColor = this.tokenColor(token).join(',');
        if (token.system === undefined || systemRunColor !== systemColor || spacing !== 0) { systemRun = ''; systemRunWidth = 0; }
        let width = token.system === undefined ? 0 : this.systemWidth(systemRun + token.system) * size * this.font.scale;
        let advance = token.system !== undefined ? width - systemRunWidth
          : ((inline ? inline.advance : token.glyph!.advance) + adjust[2]) * tokenScale;
        let row = rows[rows.length - 1];
        if (this.spec.wrap && row.tokens.length && row.width + advance > boxWidth) {
          row = { tokens: [], width: 0 }; rows.push(row); systemRun = ''; systemRunWidth = 0;
          if (token.system !== undefined) advance = width = this.systemWidth(token.system) * size * this.font.scale;
        }
        row.tokens.push({ token, x: row.width + adjust[0] * tokenScale, y: adjust[1] * tokenScale, scale: tokenScale });
        row.width += advance + spacing + (token.code === '32' ? (this.spec.wordSpacing ?? 0) * size * this.font.scale / 100 : 0);
        if (token.system !== undefined) { systemRun += token.system; systemRunWidth = width; systemRunColor = systemColor; }
      }
      const fittedRows = rows.map(row => {
        if (row.tokens.length) row.width -= spacing;
        let left = 0, right = row.width;
        if (this.spec.fitGlyphBounds) for (const item of row.tokens) {
          const glyph = item.token.glyph ?? (item.token.sprite ? this.factory.inline[item.token.sprite] : undefined);
          if (!glyph || ('empty' in glyph && glyph.empty)) continue;
          const x = item.x + (glyph.bearingX ?? 0) * item.scale;
          left = Math.min(left, x); right = Math.max(right, x + (glyph.width ?? 0) * item.scale);
        }
        return { ...row, left, fitWidth: right - left };
      });
      const lineHeight = (this.spec.lineHeight === undefined ? this.font.lineHeight * scale
        : this.spec.lineHeight * size / this.spec.size * this.font.scale) + (this.spec.lineSpacing ?? 0) * size / 100;
      const height = (this.font.ascent - this.font.descent) * scale + Math.max(0, rows.length - 1) * lineHeight;
      const fitHeight = this.spec.layoutHeight === undefined ? height
        : this.spec.layoutHeight * size / this.spec.size * this.font.scale + Math.max(0, rows.length - 1) * lineHeight;
      return { rows: fittedRows, height, fitHeight, lineHeight, scale };
    };
    let size = this.spec.size;
    if (this.spec.autosize && tr.width > 0 && tr.height > 0) {
      let low = this.spec.minSize ?? 1, high = this.spec.maxSize ?? size;
      const fits = (candidate: number) => { const box = measure(candidate); return box.fitHeight <= boxHeight + .001 && box.rows.every(row => row.fitWidth <= boxWidth + .001); };
      if (fits(high)) size = high;
      else { for (let i = 0; i < 16; i++) { const mid = (low + high) / 2; if (fits(mid)) low = mid; else high = mid; } size = Math.floor(low * 20) / 20; }
    }
    this.fontSize = size * this.font.scale;
    const layout = measure(size);
    const top = (1 - tr.anchorY) * tr.height - margin[1];
    const textTop = this.spec.vertical === 256 ? top : this.spec.vertical === 1024 ? top - boxHeight + layout.height : top - (boxHeight - layout.height) / 2;
    let used = 0, systemUsed = 0;
    layout.rows.forEach((row, line) => {
      const left = -tr.anchorX * tr.width + margin[0] - row.left + (this.spec.horizontal === 1 ? 0 : this.spec.horizontal === 4 ? boxWidth - row.fitWidth : (boxWidth - row.fitWidth) / 2);
      const baseline = textTop - this.font.ascent * layout.scale - line * layout.lineHeight;
      for (let index = 0; index < row.tokens.length; index++) {
        const item = row.tokens[index];
        if (item.token.system !== undefined) {
          let text = item.token.system;
          // System text becomes one draw per same-color line. Keep
          // authored character spacing on the per-character path when present.
          if (!this.spec.characterSpacing) {
            const colorKey = this.tokenColor(item.token).join(',');
            while (row.tokens[index + 1]?.token.system !== undefined && this.tokenColor(row.tokens[index + 1].token).join(',') === colorKey) {
              text += row.tokens[++index].token.system;
            }
          }
          const label = this.systemNodes[systemUsed++] ?? this.makeSystemLabel(false);
          this.drawSystemLabel(label, text, this.fontSize, this.tokenColor(item.token), left + item.x, baseline + item.y);
          continue;
        }
        const glyph = item.token.glyph, inline = item.token.sprite && this.factory.inline[item.token.sprite];
        if (glyph?.empty) continue;
        let frame: SpriteFrame | null, width: number, height: number, x: number, y: number;
        if (inline) {
          frame = this.factory.art.frames.get(this.factory.inlinePaths[item.token.sprite!])!;
          width = inline.width; height = inline.height; x = inline.bearingX; y = inline.bearingY;
        } else {
          frame = this.factory.frame(this.font, glyph!, this.tokenColor(item.token)); if (!frame) continue;
          width = glyph!.width!; height = glyph!.height!; x = glyph!.bearingX!; y = glyph!.bearingY!;
        }
        let sprite = this.glyphNodes[used++];
        if (!sprite) {
          const glyphNode = makeNode('OriginalGlyph', this.node); glyphNode.getComponent(UITransform)!.setAnchorPoint(0, 1);
          sprite = glyphNode.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM; sprite.trim = false;
          if (this.factory.spriteMaterial && (this.factory.materialLayer === undefined || glyphNode.layer === this.factory.materialLayer)) sprite.customMaterial = this.factory.spriteMaterial;
          this.glyphNodes.push(sprite);
        }
        sprite.node.active = true; sprite.spriteFrame = frame;
        const color = this.tokenColor(item.token), selected = glyph && glyphVariant(glyph, color);
        const source = selected?.[0].split(',').map(Number) ?? [255, 255, 255, 255];
        const rgb = glyph ? color.slice(0, 3).map((value, index) => Math.min(255, source[index] ? value * 255 / source[index] : 255)) : [255, 255, 255];
        sprite.color = new Color(rgb[0], rgb[1], rgb[2], this.localAlpha(color[3] ?? 255));
        sprite.node.getComponent(UITransform)!.setContentSize(width * item.scale, height * item.scale);
        sprite.node.setPosition(left + item.x + x * item.scale, baseline + item.y + y * item.scale);
        this.updateDisabledStrike(sprite, width * item.scale, height * item.scale, !!inline && !!inline.disabledStrike);
      }
    });
    for (let i = used; i < this.glyphNodes.length; i++) this.glyphNodes[i].node.active = false;
    for (let i = systemUsed; i < this.systemNodes.length; i++) this.systemNodes[i].node.active = false;
  }

  private tokenColor(token: Token): number[] {
    return token.color ? [...token.color.slice(0, 3), (token.color[3] ?? 255) * (this.color[3] ?? 255) / 255] : this.color;
  }

  private localAlpha(alpha: number): number {
    // A disabled Cocos Label still owns node._uiProps.uiComp: its opacity is
    // cascaded by Batcher2D even though it does not submit its own geometry.
    const parentAlpha = this.node.getComponent(Label)?.color?.a;
    return parentAlpha === undefined || parentAlpha === 255 ? alpha : parentAlpha > 0 ? Math.min(255, alpha * 255 / parentAlpha) : 255;
  }

  private makeSystemLabel(measuring: boolean): Label {
    const node = makeNode(measuring ? 'FontPolicyMeasure' : 'SystemGlyph', this.node);
    node.getComponent(UITransform)!.setAnchorPoint(0, 1);
    const label = node.addComponent(Label);
    label.font = null; label.useSystemFont = true; label.fontFamily = 'sans-serif';
    label.horizontalAlign = Label.HorizontalAlign.LEFT; label.verticalAlign = Label.VerticalAlign.TOP;
    label.overflow = Label.Overflow.NONE; label.enableWrapText = false;
    if (this.factory.spriteMaterial && (this.factory.materialLayer === undefined || node.layer === this.factory.materialLayer)) label.customMaterial = this.factory.spriteMaterial;
    if (measuring) { label.enabled = false; this.measuringLabel = label; }
    else this.systemNodes.push(label);
    return label;
  }

  private systemWidth(value: string): number {
    const style = this.spec.systemStyle, key = `sans-serif:100:${!!style?.bold}:${!!style?.italic}:${value}`;
    const cached = this.factory.systemWidthCache.get(key); if (cached !== undefined) return cached;
    const label = this.measuringLabel ?? this.makeSystemLabel(true), tr = label.node.getComponent(UITransform)!;
    label.fontSize = 100; label.lineHeight = 100; label.string = value;
    label.isBold = !!style?.bold; label.isItalic = !!style?.italic;
    tr.setContentSize(0, 0);
    // Public Creator API computes the actual device system-font advance now,
    // rather than reusing metrics from the removed Chinese font.
    label.updateRenderData?.(true);
    const width = typeof label.updateRenderData === 'function' && Number.isFinite(tr.width) ? Math.max(0, tr.width) / 100 : 1;
    this.factory.rememberSystemWidth(key, width); return width;
  }

  private drawSystemLabel(label: Label, value: string, size: number, color: number[], x: number, baseline: number): void {
    const style = this.spec.systemStyle;
    label.node.active = true; label.string = value; label.fontSize = size; label.lineHeight = size;
    label.isBold = !!style?.bold; label.isItalic = !!style?.italic;
    label.color = new Color(color[0], color[1], color[2], this.localAlpha(color[3] ?? 255));
    label.enableOutline = (style?.outlineWidth ?? 0) > 0; label.outlineWidth = (style?.outlineWidth ?? 0) * size;
    const outline = style?.outlineColor ?? [101, 69, 45, 255]; label.outlineColor = new Color(outline[0], outline[1], outline[2], outline[3] ?? 255);
    const shadow = style?.shadowColor ?? [0, 0, 0, 0], offset = style?.shadowOffset ?? [0, 0];
    label.enableShadow = shadow[3] > 0 && (offset.some(component => component !== 0) || (style?.shadowBlur ?? 0) > 0);
    label.shadowColor = new Color(shadow[0], shadow[1], shadow[2], shadow[3] ?? 255);
    label.shadowOffset = new Vec2(offset[0] * size, offset[1] * size); label.shadowBlur = (style?.shadowBlur ?? 0) * size;
    label.updateRenderData?.(true);
    // Creator exposes its measured canvas baseline. Convert its canvas pixels
    // back to UI units, including the padding added by outline and shadow.
    const data = (label as Label & { textLayoutData?: { canvasSize: { height: number }; startPosition: { x: number; y: number } } }).textLayoutData;
    const tr = label.node.getComponent(UITransform)!;
    const ratio = data && data.canvasSize.height > 0 ? tr.height / data.canvasSize.height : 1;
    const rise = data && data.startPosition.y > 0 ? data.startPosition.y * ratio : size * .87;
    const inset = data && data.startPosition.x > 0 ? data.startPosition.x * ratio : 0;
    label.node.setPosition(x - inset, baseline + rise);
  }

  destroy(): void {
    if (this.destroyed) return; this.destroyed = true;
    for (const component of [...this.glyphNodes, ...this.systemNodes, ...(this.measuringLabel ? [this.measuringLabel] : [])]) {
      component.node.active = false;
      if (component.node.isValid !== false) component.node.destroy();
    }
    this.glyphNodes.length = 0; this.systemNodes.length = 0; this.measuringLabel = null;
    this.disabledStrikes.clear();
  }

  /** Compose an optional prohibition mark over the existing stat sprite. The
   * underlying shared artwork is unchanged, including on equipment cards. */
  private updateDisabledStrike(sprite: Sprite, width: number, height: number, disabled: boolean): void {
    let graphic = this.disabledStrikes.get(sprite);
    if (!disabled) { if (graphic) graphic.node.active = false; return; }
    if (!graphic) {
      graphic = makeNode('DisabledStrike', sprite.node).addComponent(Graphics);
      if (this.factory.graphicsMaterial && (this.factory.materialLayer === undefined || graphic.node.layer === this.factory.materialLayer)) graphic.customMaterial = this.factory.graphicsMaterial;
      this.disabledStrikes.set(sprite, graphic);
    }
    const length = Math.hypot(width, height) * .86, thickness = Math.min(width, height) * .13, border = Math.min(width, height) * .06;
    graphic.node.active = true;
    graphic.node.setPosition(width / 2, -height / 2);
    graphic.node.angle = Math.atan2(height, width) * 180 / Math.PI;
    graphic.node.getComponent(UITransform)!.setContentSize(length, thickness + border);
    graphic.clear();
    graphic.fillColor = new Color(98, 65, 42, 255);
    graphic.roundRect(-length / 2, -(thickness + border) / 2, length, thickness + border, (thickness + border) / 2); graphic.fill();
    graphic.fillColor = new Color(255, 30, 20, 255);
    graphic.roundRect(-(length - border) / 2, -thickness / 2, length - border, thickness, thickness / 2); graphic.fill();
  }
}

/** TMP rich colors select a baked face variant; outline/underlay stay authored. */
function bitmapTagColor(value: string): number[] | null {
  const named: Record<string, string> = { black: '000000', white: 'ffffff', red: 'ff0000', green: '00ff00', blue: '0000ff', yellow: 'ffff00', cyan: '00ffff', magenta: 'ff00ff' };
  const hex = named[value.toLowerCase()] ?? value.replace(/^#/, '');
  if (!/^(?:[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return null;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255];
}
