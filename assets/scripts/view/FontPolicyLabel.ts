import { Color, Label, LabelOutline, LabelShadow, Material } from 'cc';
import { ArtLibrary } from './ArtLibrary';
import { OriginalBitmapText, OriginalBitmapTextFactory } from './OriginalBitmapText';
import type { BitmapTextSpec, OriginalBitmapFont, OriginalInlineGlyph, SystemTextStyle } from './OriginalBitmapText';

export interface FontPolicyLabelOptions {
  /** Select an already-baked face/effect variant, for example by HUD font size. */
  selectFont?: (label: Label) => OriginalBitmapFont;
  inline?: Record<string, OriginalInlineGlyph>;
  inlinePaths?: Record<string, string>;
  spriteMaterial?: Material; graphicsMaterial?: Material; materialLayer?: number;
  systemStyle?: SystemTextStyle;
  fitGlyphBounds?: boolean;
  /** TMP character spacing, as a percentage of the displayed font size. */
  characterSpacing?: number;
}
export interface FontPolicyLabelHandle { sync(): void; destroy(): void; }

const rgba = (color: Color | undefined, fallback: number[] = [255, 255, 255, 255]): number[] =>
  color ? [color.r, color.g, color.b, color.a] : fallback;

/** Retains the caller's Label as a state holder and opacity owner. Call sync
 * after changing its text/style or its box; unchanged snapshots do no work.
 * Bitmap faces already include their authored effects, so only system glyphs
 * receive Label outlines/shadows. No TTF registration is needed for display. */
export function attachFontPolicyLabel(label: Label, art: ArtLibrary, font: OriginalBitmapFont,
  options: FontPolicyLabelOptions = {}): FontPolicyLabelHandle {
  const wasEnabled = label.enabled;
  let disposed = false, currentFont: OriginalBitmapFont | undefined, renderer: OriginalBitmapText | undefined;
  let factory: OriginalBitmapTextFactory | undefined;
  const spec: BitmapTextSpec = { size: 1, autosize: false, wrap: false, horizontal: 2, vertical: 512, color: rgba(label.color) };
  const sync = (): void => {
    if (disposed || label.node.isValid === false) return;
    label.enabled = false;
    label.font = null; label.useSystemFont = true; label.fontFamily = 'sans-serif';
    const selected = options.selectFont?.(label) ?? font;
    if (selected !== currentFont) {
      renderer?.destroy(); factory?.destroy(); currentFont = selected;
      factory = new OriginalBitmapTextFactory(art, { display: selected }, options.inline ?? {}, options.inlinePaths ?? {},
        options.spriteMaterial ?? label.customMaterial ?? undefined, options.graphicsMaterial, options.materialLayer);
      renderer = new OriginalBitmapText(label.node, spec, selected, factory);
    }
    const size = Math.max(.01, label.fontSize), scale = Math.max(.0001, selected.scale);
    spec.size = size / scale; spec.maxSize = spec.size; spec.minSize = Math.min(1 / scale, spec.size);
    spec.autosize = label.overflow === Label.Overflow.SHRINK;
    spec.wrap = label.enableWrapText;
    spec.fitGlyphBounds = options.fitGlyphBounds;
    spec.characterSpacing = options.characterSpacing;
    spec.horizontal = label.horizontalAlign === Label.HorizontalAlign.LEFT ? 1 : label.horizontalAlign === Label.HorizontalAlign.RIGHT ? 4 : 2;
    spec.vertical = label.verticalAlign === Label.VerticalAlign.TOP ? 256 : label.verticalAlign === Label.VerticalAlign.BOTTOM ? 1024 : 512;
    spec.lineHeight = Math.max(.01, label.lineHeight) / scale;
    spec.layoutHeight = spec.lineHeight;
    spec.color = rgba(label.color);
    const outline = label.node.getComponent(LabelOutline), shadow = label.node.getComponent(LabelShadow);
    const outlineEnabled = outline ? outline.enabled !== false : label.enableOutline;
    const shadowEnabled = shadow ? shadow.enabled !== false : label.enableShadow;
    const offset = shadowEnabled ? shadow?.offset ?? label.shadowOffset : undefined;
    spec.systemStyle = { bold: label.isBold, italic: label.isItalic,
      outlineWidth: outlineEnabled ? Math.max(0, outline?.width ?? label.outlineWidth ?? 0) / size : 0,
      outlineColor: rgba(outline?.color ?? label.outlineColor),
      shadowColor: shadowEnabled ? rgba(shadow?.color ?? label.shadowColor, [0, 0, 0, 0]) : [0, 0, 0, 0],
      shadowOffset: offset ? [offset.x / size, offset.y / size] : [0, 0],
      shadowBlur: shadowEnabled ? (shadow?.blur ?? label.shadowBlur ?? 0) / size : 0,
      ...options.systemStyle,
    };
    renderer!.setText(label.string ?? '', spec.color);
  };
  const destroy = (): void => {
    if (disposed) return; disposed = true;
    renderer?.destroy(); factory?.destroy();
    if (label.node.isValid !== false) label.enabled = wasEnabled;
  };
  sync(); return { sync, destroy };
}
