import { BlockInputEvents, Color, Font, Graphics, Label, LabelOutline, LabelShadow, Mask, Material, Node, RichText, Sprite, SpriteAtlas, TTFFont, UITransform, Vec2 } from 'cc';
import { ArtLibrary, ImageSpec, makeNode } from './ArtLibrary';
import { OriginalBitmapText, OriginalBitmapTextFactory } from './OriginalBitmapText';
import type { OriginalBitmapFont, OriginalInlineGlyph } from './OriginalBitmapText';
import { loadResourceBatch } from './ResourceBatch';

export type Pair = [number, number];
export interface UiBowStringSpec {
  upperPx: Pair; lowerPx: Pair; bracePx: Pair;
  color: [number, number, number, number]; widthPx: number;
}
export interface UiImageSpec extends ImageSpec {
  /** UI-only alpha bounds, [left, top, right, bottom] in source PNG pixels.
   * Weapon grips remain in the separate equipped ImageSpec.anchor. */
  uiVisibleBoundsPx?: [number, number, number, number];
  /** Uniform UI-only enlargement; the authored slot and its hit box stay fixed. */
  uiDisplayScale?: number;
  /** Convex hull of visible pixel cells in top-left PNG coordinates. */
  uiVisibleHullPx?: Pair[];
  /** Match this registered image's visible height at the same display angle. */
  uiHeightReference?: string;
  /** Frozen reference geometry keeps a shared UI scale stable after one sprite is redrawn. */
  uiHeightReferenceFrame?: { sizePx: Pair; uiVisibleHullPx: Pair[] };
  /** The same three resting string points as the equipped bow, in PNG pixels. */
  uiBowString?: UiBowStringSpec;
}

function bowString(image: UiImageSpec): UiBowStringSpec | undefined {
  const string = image.uiBowString;
  return string && Number.isFinite(string.widthPx) && string.widthPx > 0 &&
    [string.upperPx, string.lowerPx, string.bracePx].every(point => point.length === 2 && point.every(Number.isFinite)) ? string : undefined;
}

function projectedHull(image: UiImageSpec, rotationDeg: number): [number, number, number, number] | undefined {
  const points = image.uiVisibleHullPx, [width, height] = image.sizePx;
  if (!points || points.length < 3 || !points.every(point => point.length === 2 && point.every(Number.isFinite) &&
      point[0] >= 0 && point[0] <= width && point[1] >= 0 && point[1] <= height)) return undefined;
  const angle = rotationDeg * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
  // Convert top-left source coordinates to the UI's upward Y before rotation.
  const projected = points.map(([x, y]) => [cosine * x + sine * y, sine * x - cosine * y]);
  const bounds: [number, number, number, number] = [Math.min(...projected.map(point => point[0])), Math.min(...projected.map(point => point[1])),
    Math.max(...projected.map(point => point[0])), Math.max(...projected.map(point => point[1]))];
  return bounds[2] > bounds[0] && bounds[3] > bounds[1] ? bounds : undefined;
}

/** Place the visible centre in the slot with an optional UI-only enlargement.
 * This preserves the authored hit box and does not change any battle anchor. */
export function fitUiImage(image: UiImageSpec, box: Pair, anchor: Pair, rotationDeg = 0, reference?: UiImageSpec): { size: Pair; position: Pair } {
  const [width, height] = image.sizePx;
  const displayScale = Number.isFinite(image.uiDisplayScale) && image.uiDisplayScale! > 0 ? image.uiDisplayScale! : 1;
  const angle = Number.isFinite(rotationDeg) ? rotationDeg : 0;
  const referenceFrame = reference?.uiHeightReferenceFrame;
  const referenceImage = referenceFrame && reference ? { ...reference, ...referenceFrame } : reference;
  const projected = projectedHull(image, angle), referenceProjected = referenceImage && projectedHull(referenceImage, angle);
  const heightScale = projected && referenceProjected ? (referenceProjected[3] - referenceProjected[1]) / (projected[3] - projected[1]) : 1;
  const baseSize = referenceFrame?.sizePx ?? image.sizePx;
  const factor = Math.min(box[0] / baseSize[0], box[1] / baseSize[1]) * displayScale * heightScale;
  const size: Pair = [width * factor, height * factor];
  let bounds = image.uiVisibleBoundsPx;
  if (bounds && (bounds.length !== 4 || !bounds.every(Number.isFinite) ||
      bounds[0] < 0 || bounds[1] < 0 || bounds[2] > width || bounds[3] > height ||
      bounds[2] <= bounds[0] || bounds[3] <= bounds[1])) bounds = undefined;
  const string = bowString(image);
  if (string) {
    const [left, top, right, bottom] = bounds ?? [0, 0, width, height];
    const points = [string.upperPx, string.lowerPx, string.bracePx], radius = string.widthPx / 2;
    bounds = [Math.min(left, ...points.map(point => point[0] - radius)), Math.min(top, ...points.map(point => point[1] - radius)),
      Math.max(right, ...points.map(point => point[0] + radius)), Math.max(bottom, ...points.map(point => point[1] + radius))];
  }
  if (!bounds && !projected) return { size, position: [0, 0] };
  let centerX = bounds ? (bounds[0] + bounds[2]) / 2 : width / 2;
  let centerY = bounds ? height - (bounds[1] + bounds[3]) / 2 : height / 2;
  if (projected) {
    const cosine = Math.cos(angle * Math.PI / 180), sine = Math.sin(angle * Math.PI / 180);
    const x = (projected[0] + projected[2]) / 2, y = (projected[1] + projected[3]) / 2;
    centerX = cosine * x + sine * y;
    centerY = height - sine * x + cosine * y;
  }
  return { size, position: [
    (.5 - anchor[0]) * box[0] - (centerX - anchor[0] * width) * factor,
    (.5 - anchor[1]) * box[1] - (centerY - anchor[1] * height) * factor,
  ] };
}

/** Apply the shared equipment proportions before fitting either image. Never
 * multiply the current scale: cards are reused when changing weapon or grade. */
export function applyWeaponUiDisplay(config: WeaponUiConfig,
  role: { type: string; Gun_img: string; Shadow_img: string }, weaponId: number,
  nodeFor: (key: string) => Node): void {
  const display = config.inventoryWeaponDisplays?.[role.type as WeaponUiSurface]?.[weaponId];
  if (!display) return;
  const gun = nodeFor(role.Gun_img), shadow = nodeFor(role.Shadow_img);
  shadow.setScale(display.scale, display.scale, 1); shadow.angle = display.angle;
  if (display.foregroundPosition) {
    gun.setScale(1, 1, 1); gun.angle = 0;
    gun.setPosition(...display.foregroundPosition, 0);
  } else {
    gun.setScale(display.scale, display.scale, 1); gun.angle = display.angle;
  }
}

export type WeaponUiSurface = 'Gun_Item' | 'Gun_Slot' | 'Gun_Info_UI' | 'NewGun_UI' | 'Gun_Item_Demo' | 'Raid_GunSlot';

/** A card displays one grade at a time. Keep its first label as a stable target
 * and rebind the original grade's complete styling when the item changes. */
export class OriginalGradeBadgePool {
  private readonly excluded = new Set<string>();
  private readonly targets = new Set<string>();
  private readonly sources = new Map<string, string>();
  constructor(roles: readonly { Degree_objs?: readonly string[] }[]) {
    for (const role of roles) if (role.Degree_objs && role.Degree_objs.length > 1) {
      this.targets.add(role.Degree_objs[0]);
      role.Degree_objs.slice(1).forEach(key => this.excluded.add(key));
    }
  }
  readonly include = (key: string): boolean => !this.excluded.has(key);
  update(ui: Pick<OriginalWeaponUi, 'show' | 'rebindTree'>, keys: readonly string[] | undefined, grade: number): boolean {
    const target = keys?.[0];
    if (!target || !this.targets.has(target)) return false;
    if (grade < 0) { ui.show(target, false); return true; }
    const source = keys![grade] ?? target;
    if (this.sources.get(target) !== source) {
      ui.rebindTree(target, source); this.sources.set(target, source);
    }
    ui.show(target, true);
    return true;
  }
}

export interface OriginalUiNode {
  id: string; transform: string; name: string; active: boolean; components: string[]; children: string[];
  rect: { min: Pair; max: Pair; position: Pair; size: Pair; pivot: Pair; scale: Pair; angle: number };
  image?: { sprite: string | null; color: number[]; sliced?: boolean; tiled?: boolean; tileSize?: number; preserveAspect?: boolean; raycast?: boolean };
  text?: { value: string; size: number; color: number[]; horizontal: number; vertical: number; autosize: boolean; wrap: boolean; outline: boolean; font: string; term: string; spriteAsset?: string; profile?: string; minSize?: number; maxSize?: number; characterSpacing?: number; wordSpacing?: number; lineSpacing?: number; margin?: number[]; kerning?: boolean; raycast?: boolean; useSystemFont?: boolean };
  button?: { target: string; method: string; arguments: Record<string, any> }[];
  mask?: boolean; maskShowGraphic?: boolean; layoutType?: string; layout?: Record<string, any>;
  contentSizeFitter?: { horizontalFit: number; verticalFit: number };
  bounceButton?: { scale: number; duration: number; source: string };
  clickSound?: number;
}
export interface OriginalTextProfile {
  font: string; pointSize: number; scale: number; ascent: number; descent: number;
  advances: Record<string, number>; faceDilate: number; outlineWidth: number; outlineColor: number[];
  shadowOffset: Pair; shadowColor: number[];
}
export interface WeaponUiConfig {
  version: number; referenceWidth: number; roots: Record<string, string>;
  nodes: Record<string, OriginalUiNode>; roles: Record<string, any>;
  images: Record<string, UiImageSpec>;
  /** Bitmap-only panels have no TTF resource dependencies. */
  fonts?: { chinese: string; original: string; numbers: string };
  gunIcons: string[]; degreeColors: number[][]; translations: Record<string, string>;
  /** Shared equipment proportions for all dynamic UI previews. The historical
   * field name is retained; collection cards bake the same fixed baselines. */
  inventoryWeaponDisplays?: Partial<Record<WeaponUiSurface, {
    scale: number; angle: number; foregroundPosition?: Pair;
  }[]>>;
  inlineSprites?: Record<string, string>;
  textProfiles?: Record<string, OriginalTextProfile>;
  fontVariants?: Record<string, string>;
  bitmapFonts?: Record<string, OriginalBitmapFont>;
  inlineSpriteMetrics?: Record<string, OriginalInlineGlyph>;
  newGunAnimation?: { duration: number; tracks: { node: string; curves: { time: number; coefficients: number[] }[][] }[]; glowRotationSpeed: number };
  starConfetti?: { node: string; source: Record<string, any> }[];
  mergeTutorial?: { node: string; root: string; moveDuration: number; pauseAtTarget: number; scaleSmall: number; scaleDuration: number; offset: Pair; source: string };
}
export interface WeaponHudAssets { config: WeaponUiConfig; chineseFont: Font | null; originalFont: Font; numberFont: Font; fontVariants?: Record<string, Font>; collectionImagesDeferred?: boolean; }
export interface OriginalUiMaterials { sprite?: Material; graphics?: Material; layer?: number; }
/** The owner schedules these small steps across frames and rejects on cancellation. */
export type UiLayout = [number, number, number, number];
export interface UiPreparation {
  (steps: Generator<void>): Promise<void>;
  /** Scene-owned construction stays hidden until its measured commit step. */
  managed?: boolean;
  layout?: () => UiLayout;
  trace?: (phase: string, workMs: number) => void;
}
export function initialUiLayout(prepare?: UiPreparation): UiLayout { return prepare?.layout?.() ?? [1080, 1920, 0, 0]; }
export function* uiPreparationPhase(prepare: UiPreparation | undefined, phase: string, steps: Generator<void>): Generator<void> {
  const now = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
  let workMs = 0;
  try {
    for (;;) {
      const started = now(); const next = steps.next(); const elapsed = Math.max(0, now() - started);
      workMs += elapsed;
      if (elapsed >= 1) prepare?.trace?.(phase + ':slowStep', elapsed);
      if (next.done) break;
      yield;
    }
  } finally { steps.return(undefined); prepare?.trace?.(phase, workMs); }
}

/** Only collection-exclusive images may leave the backpack dependency set.
 * Dynamic inventory previews and inline currencies remain available immediately. */
export function weaponHudImagePaths(config: WeaponUiConfig, includeCollection = false): string[] {
  const collection = new Set<string>(), common = new Set<string>();
  const visit = (id: string, paths: Set<string>): void => {
    const node = config.nodes[id], image = node.image?.sprite && config.images[node.image.sprite];
    if (image) paths.add(image.path);
    node.children.forEach(child => visit(child, paths));
  };
  for (const [name, id] of Object.entries(config.roots)) visit(id, name === 'collection' ? collection : common);
  for (const key of [...config.gunIcons, ...Object.values(config.inlineSprites ?? {})]) if (config.images[key]) common.add(config.images[key].path);
  const paths = Object.values(config.images).map(image => image.path)
    .filter(path => includeCollection || !collection.has(path) || common.has(path));
  for (const font of Object.values(config.bitmapFonts ?? {})) paths.push(...font.pages);
  return Array.from(new Set(paths));
}

/** Includes the partially visible rows and one spare row on either side. */
export function weaponCollectionWindow(count: number, columns: number, rowHeight: number, padding: number, offset: number, height: number): number[] {
  const rows = Math.ceil(count / columns), top = offset - padding;
  const first = Math.max(0, Math.floor(top / rowHeight) - 1);
  const last = Math.min(rows - 1, Math.floor((top + Math.max(0, height) - .001) / rowHeight) + 1);
  const result: number[] = [];
  for (let index = first * columns; index < Math.min(count, (last + 1) * columns); index++) result.push(index);
  return result;
}

export async function loadWeaponCollectionAssets(art: ArtLibrary, config: WeaponUiConfig): Promise<void> {
  const common = new Set(weaponHudImagePaths(config));
  await loadResourceBatch(weaponHudImagePaths(config, true).filter(path => !common.has(path)).map(path => () => art.loadFrame(path)));
}

export async function loadWeaponHudAssets(art: ArtLibrary): Promise<WeaponHudAssets> {
  const config = await art.json<WeaponUiConfig>('art/weapon-system/config');
  const collection = Object.values(config.roles).find(role => role.type === 'Gun_Collection_UI');
  const ids = collection?.Gun_Item_list?.map((key: string) => config.roles[key]?.GunNum) as unknown[] | undefined;
  const count = config.gunIcons.length;
  if (config.version !== 1 || !config.bitmapFonts || count === 0 || !ids || ids.length !== count ||
    ids.some(id => typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= count) ||
    new Set(ids).size !== count || config.gunIcons.some(key => !config.images[key]))
    throw new Error('Invalid weapon UI catalog');
  const imagePaths = weaponHudImagePaths(config);
  await loadResourceBatch([
    ...Array.from(new Set(imagePaths)).map(path => () => art.loadFrame(path)),
  ]);
  const placeholder = new Font();
  return { config, chineseFont: null, originalFont: placeholder, numberFont: placeholder, collectionImagesDeferred: true };
}

export function sourceColor(value: number[]): Color { return new Color(value[0], value[1], value[2], value[3] ?? 255); }

/** The original RectTransform hierarchy is retained, including inactive grade badges.
 * This is deliberately a source renderer, not a replacement card layout. */
export class OriginalWeaponUi {
  private destroyed = false;
  readonly nodes = new Map<string, Node>();
  private readonly specs = new Map<Node, OriginalUiNode>();
  private readonly baseSizes = new Map<Node, Pair>();
  private readonly imageChildren = new Map<Node, Node>();
  private readonly currentImages = new Map<Node, UiImageSpec>();
  private readonly fittedImages = new Map<Node, { image: UiImageSpec; reference?: UiImageSpec; geometry: string;
    width: number; height: number; x: number; y: number }>();
  private readonly bowStrings = new Map<Node, Graphics>();
  private readonly inlineText = new Map<Node, RichText>();
  private readonly textValues = new Map<Node, string>();
  private readonly textDirty = new Set<Node>();
  private managedPreparationStep = false;
  private readonly unlaidText = new Set<Node>();
  private inlineAtlas: SpriteAtlas | null = null;
  private readonly bitmapTexts = new Map<Node, OriginalBitmapText>();
  private readonly bitmapFactory: OriginalBitmapTextFactory | null;
  constructor(readonly art: ArtLibrary, readonly assets: WeaponHudAssets, private readonly materials: OriginalUiMaterials = {}) {
    const config = assets.config;
    const inlinePaths: Record<string, string> = {};
    for (const [key, image] of Object.entries(config.inlineSprites ?? {})) inlinePaths[key] = config.images[image].path;
    this.bitmapFactory = config.bitmapFonts ? new OriginalBitmapTextFactory(art, config.bitmapFonts,
      config.inlineSpriteMetrics ?? {}, inlinePaths, materials.sprite, materials.graphics, materials.layer) : null;
  }

  /** Keep an unfinished HUD hidden and release every partially-created resource
   * if its frame scheduler, owning scene, or initialization fails. */
  prepare(owner: Node, parent: Node, steps: Generator<void>, schedule?: UiPreparation, cleanup?: () => void): Promise<void> {
    const release = (): void => {
      try { steps.return(undefined); }
      finally { try { cleanup?.(); } finally { this.destroy(); owner.destroy(); } }
    };
    if (!schedule) {
      try { for (const _ of steps) { /* preserve synchronous construction */ } }
      catch (error) { release(); throw error; }
      return Promise.resolve();
    }
    const active = owner.active; owner.active = false;
    const valid = (): void => {
      if (this.destroyed || !owner.isValid || !parent.isValid) throw new Error('UI preparation cancelled: owner destroyed');
    };
    const ui = this;
    const guarded = function* (): Generator<void> {
      for (;;) {
        valid();
        const previous = ui.managedPreparationStep;
        let next: IteratorResult<void>;
        ui.managedPreparationStep = !!schedule.managed;
        try { next = steps.next(); } finally { ui.managedPreparationStep = previous; }
        if (next.done) break;
        yield;
      }
      // Layout normally flushes every label. Any custom root omitted from that
      // traversal still finishes its text before prepared resolves/viewReady.
      for (const node of ui.unlaidText) {
        valid(); ui.unlaidText.delete(node); ui.textDirty.add(node);
        ui.setText(ui.specs.get(node)!.id, ui.textValues.get(node) ?? '');
        yield;
      }
      // Activation can invoke engine lifecycle work. Keep it inside the budget,
      // never in a Promise continuation. Managed HUDs are activated by the scene.
      if (!schedule.managed) { valid(); owner.active = active; }
    };
    return Promise.resolve().then(() => schedule(guarded())).catch(error => { release(); throw error; });
  }

  create(id: string, parent: Node): Node {
    const steps = this.createSteps(id, parent);
    for (;;) { const step = steps.next(); if (step.done) return step.value; }
  }

  /** One authored node per step, including its own image/text renderers. */
  *createSteps(id: string, parent: Node, active?: boolean, include: (id: string) => boolean = () => true): Generator<void, Node> {
    const spec = this.assets.config.nodes[id];
    const node = makeNode(spec.name, parent);
    if (active !== undefined) node.active = active;
    const materials = this.materials.layer === undefined || node.layer === this.materials.layer ? this.materials : {};
    this.nodes.set(id, node); this.nodes.set(spec.transform, node);
    spec.components.forEach(key => this.nodes.set(key, node)); this.specs.set(node, spec);
    const tr = node.getComponent(UITransform)!;
    tr.setAnchorPoint(...spec.rect.pivot);
    node.setScale(spec.rect.scale[0], spec.rect.scale[1], 1); node.angle = spec.rect.angle;
    if (spec.image) {
      // Unity Graphic alpha affects only its own vertices. Cocos instead
      // multiplies a renderer's alpha into its descendants, so isolate artwork
      // from the original child hierarchy (including fully transparent scrolls).
      const imageNode = makeNode('OriginalImage', node);
      this.imageChildren.set(node, imageNode); imageNode.getComponent(UITransform)!.setAnchorPoint(...spec.rect.pivot);
      if (spec.mask && !spec.maskShowGraphic) imageNode.active = false;
      const image = spec.image.sprite && this.assets.config.images[spec.image.sprite];
      if (image) {
        this.currentImages.set(node, image);
        const sprite = imageNode.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        if (materials.sprite) sprite.customMaterial = materials.sprite;
        sprite.spriteFrame = this.art.frames.get(image.path)!; sprite.trim = false;
        sprite.type = spec.image.sliced ? Sprite.Type.SLICED : spec.image.tiled ? Sprite.Type.TILED : Sprite.Type.SIMPLE;
        sprite.color = sourceColor(spec.image.color);
      } else {
        const graphic = imageNode.addComponent(Graphics); graphic.fillColor = sourceColor(spec.image.color);
        if (materials.graphics) graphic.customMaterial = materials.graphics;
      }
    }
    if (spec.text) {
      const label = node.addComponent(Label);
      if (materials.sprite) label.customMaterial = materials.sprite;
      label.font = spec.text.font === 'numbers' ? this.assets.numberFont : this.assets.originalFont;
      label.fontSize = spec.text.size;
      label.lineHeight = label.fontSize * 1.14; label.color = sourceColor(spec.text.color);
      label.horizontalAlign = spec.text.horizontal === 1 ? Label.HorizontalAlign.LEFT : spec.text.horizontal === 4 ? Label.HorizontalAlign.RIGHT : Label.HorizontalAlign.CENTER;
      label.verticalAlign = spec.text.vertical === 256 ? Label.VerticalAlign.TOP : spec.text.vertical === 1024 ? Label.VerticalAlign.BOTTOM : Label.VerticalAlign.CENTER;
      label.overflow = spec.text.autosize ? Label.Overflow.SHRINK : Label.Overflow.CLAMP;
      label.enableWrapText = spec.text.wrap;
      const bitmapFont = spec.text.profile && this.assets.config.bitmapFonts?.[spec.text.profile];
      if (bitmapFont && this.bitmapFactory) {
        label.enabled = false;
        const bitmap = this.createBitmapText(node, spec.text, bitmapFont); this.bitmapTexts.set(node, bitmap);
        // Authored children must retain their order after the initial glyphs.
        if (this.managedPreparationStep && spec.children.length === 0 && bitmap.canStageInitialText(spec.text.value)) this.unlaidText.add(node);
      }
      this.setText(id, spec.text.value);
      if (spec.text.outline && !bitmapFont) {
        const outline = node.addComponent(LabelOutline); outline.color = new Color(101, 69, 45, 255); outline.width = 2.8;
      }
      const currency = /<sprite=(\d+)>/.exec(spec.text.value);
      if (currency && this.assets.config.inlineSprites && !bitmapFont) {
        // Source TMP sprite tags occur inside sentences, including rebirth's
        // second explanatory line. Let RichText lay them out inline instead of
        // placing a currency icon at a fixed point over the text.
        label.enabled = false;
        const rich = makeNode('OriginalInlineText', node).addComponent(RichText);
        if (!this.inlineAtlas) {
          this.inlineAtlas = new SpriteAtlas();
          for (const [index, imageKey] of Object.entries(this.assets.config.inlineSprites)) {
            this.inlineAtlas.spriteFrames[index] = this.art.frames.get(this.assets.config.images[imageKey].path)!;
          }
        }
        rich.imageAtlas = this.inlineAtlas; rich.handleTouchEvent = false;
        rich.horizontalAlign = label.horizontalAlign;
        this.inlineText.set(node, rich); this.setText(id, spec.text.value);
      } else if (currency && !bitmapFont) {
        const image = this.assets.config.images[currency[1] === '1' ? 's904' : 's375'];
        const icon = this.art.image('InlineCurrency', { ...image, sizeUnits: [spec.text.size * 1.1, spec.text.size * 1.1], anchor: [.5, .5] }, node);
        icon.setPosition(-spec.text.size * 1.22, 0); label.string = `   ${label.string}`;
      }
    }
    if (spec.mask) node.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
    yield;
    for (const child of spec.children) if (include(child)) yield* this.createSteps(child, node, undefined, include);
    node.active = active ?? spec.active;
    return node;
  }

  private createBitmapText(node: Node, text: NonNullable<OriginalUiNode['text']>, font: OriginalBitmapFont): OriginalBitmapText {
    const profile = text.profile && this.assets.config.textProfiles?.[text.profile];
    return new OriginalBitmapText(node, { ...text, systemStyle: {
      outlineWidth: text.outline ? profile ? (profile.faceDilate + profile.outlineWidth) / profile.pointSize : 2.8 / (text.size * font.scale) : 0,
      outlineColor: profile ? profile.outlineColor : [101, 69, 45, 255],
      shadowColor: profile ? profile.shadowColor : undefined,
      shadowOffset: profile ? [profile.shadowOffset[0] / profile.pointSize, profile.shadowOffset[1] / profile.pointSize] : undefined,
    } }, font, this.bitmapFactory!);
  }

  /** Reuse an authored card with another card's complete geometry. Stable target
   * aliases keep input handlers bound once; source data is never mutated. */
  rebindTree(targetId: string, sourceId: string, overrides: ReadonlyMap<string, string> = new Map()): void {
    const apply = (targetId: string, sourceId: string): void => {
      const target = this.assets.config.nodes[targetId], source = this.assets.config.nodes[sourceId], node = this.node(targetId);
      const sourceFont = source.text?.profile && this.assets.config.bitmapFonts?.[source.text.profile];
      const canChangeFont = !!this.bitmapTexts.get(node) && !!sourceFont;
      if (target.children.length !== source.children.length || !!target.image !== !!source.image || !!target.text !== !!source.text ||
        (target.text?.profile !== source.text?.profile && !canChangeFont))
        throw new Error('Incompatible pooled UI card: ' + sourceId);
      const spec = { ...source, id: target.id, transform: target.transform, components: target.components, children: target.children };
      this.specs.set(node, spec);
      node.active = source.active; node.angle = source.rect.angle; node.setScale(...source.rect.scale, 1);
      node.getComponent(UITransform)!.setAnchorPoint(...source.rect.pivot);
      this.imageChildren.get(node)?.getComponent(UITransform)!.setAnchorPoint(...source.rect.pivot);
      if (source.image) {
        if (source.image.sprite) this.image(targetId, source.image.sprite);
        this.tint(targetId, source.image.color);
      }
      if (source.text) {
        const bitmap = this.bitmapTexts.get(node);
        if (bitmap && sourceFont && bitmap.font !== sourceFont) {
          // Some original grades use separate baked font profiles. Retire the
          // old glyphs before publishing the replacement, retaining the label
          // node, its input aliases and the factory's shared atlas frames.
          bitmap.destroy();
          this.bitmapTexts.set(node, this.createBitmapText(node, source.text, sourceFont));
        } else if (bitmap) Object.assign(bitmap.spec, source.text);
        this.textDirty.add(node); this.tint(targetId, source.text.color); this.setText(targetId, source.text.value);
      }
      target.children.forEach((child, index) => { if (this.get(child)) apply(child, overrides.get(child) ?? source.children[index]); });
    };
    apply(targetId, sourceId);
    const node = this.node(targetId), spec = this.specs.get(node)!, parent = node.parent!.getComponent(UITransform)!;
    const r = spec.rect, width = Math.max(0, parent.width * (r.max[0] - r.min[0]) + r.size[0]), height = Math.max(0, parent.height * (r.max[1] - r.min[1]) + r.size[1]);
    node.getComponent(UITransform)!.setContentSize(width, height); this.baseSizes.set(node, [width, height]);
    node.setPosition((r.min[0] + (r.max[0] - r.min[0]) * r.pivot[0] - parent.anchorX) * parent.width + r.position[0],
      (r.min[1] + (r.max[1] - r.min[1]) * r.pivot[1] - parent.anchorY) * parent.height + r.position[1]);
    this.layoutChildren(node);
  }

  /** Content uses the safe-area height. Modal backdrops and their input blocker
   * extend into the excluded screen edges; overflow values are in local units. */
  layout(rootId: string, width: number, height: number, topOverflow = 0, bottomOverflow = 0): void {
    for (const _ of this.layoutSteps(rootId, width, height, topOverflow, bottomOverflow)) { /* synchronous callers */ }
  }

  *layoutSteps(rootId: string, width: number, height: number, topOverflow = 0, bottomOverflow = 0,
    descend?: (id: string) => boolean): Generator<void> {
    const root = this.node(rootId); root.getComponent(UITransform)!.setContentSize(width, height);
    root.setPosition(0, 0); this.baseSizes.set(root, [width, height]);
    yield* this.layoutChildrenSteps(root, descend);
    const overflow = topOverflow + bottomOverflow;
    if (overflow <= 0) return;
    // Only root-level, screen-stretched images are backdrops. Never expand
    // panels, scroll masks, battle HUDs or feature-entry buttons.
    const backdrops = root.children.filter(child => {
      const spec = this.specs.get(child), r = spec?.rect;
      return spec?.image && !spec.mask && r && r.min[0] === 0 && r.min[1] === 0 &&
        r.max[0] === 1 && r.max[1] === 1 && r.size[0] >= 0 && r.size[1] >= 0 &&
        r.position[0] === 0 && r.position[1] === 0 && r.scale[0] === 1 && r.scale[1] === 1 && r.angle === 0;
    });
    for (const backdrop of backdrops) {
      const tr = backdrop.getComponent(UITransform)!;
      tr.setContentSize(tr.width, tr.height + overflow); this.baseSizes.set(backdrop, [tr.width, tr.height]);
      backdrop.setPosition(backdrop.position.x, backdrop.position.y + overflow * tr.anchorY - bottomOverflow);
      // Also redraw solid Graphics and stretch nested loading textures/clips.
      yield* this.layoutChildrenSteps(backdrop, descend);
      // The safe-area root's hit box does not include the screen edges.
      if (this.specs.get(backdrop)!.image!.raycast !== false && !backdrop.getComponent(BlockInputEvents)) backdrop.addComponent(BlockInputEvents);
    }
  }

  private layoutChildren(parent: Node): void {
    for (const _ of this.layoutChildrenSteps(parent)) { /* synchronous callers */ }
  }

  private *layoutChildrenSteps(parent: Node, descend?: (id: string) => boolean): Generator<void> {
    const pt = parent.getComponent(UITransform)!, positions = this.fitHorizontalGroup(parent);
    this.redraw(parent);
    yield;
    if (descend && !descend(this.specs.get(parent)!.id)) return;
    for (const child of parent.children) {
      const spec = this.specs.get(child); if (!spec) continue;
      const r = spec.rect, ct = child.getComponent(UITransform)!;
      const width = Math.max(0, pt.width * (r.max[0] - r.min[0]) + r.size[0]);
      const height = Math.max(0, pt.height * (r.max[1] - r.min[1]) + r.size[1]);
      ct.setContentSize(width, height); this.baseSizes.set(child, [width, height]);
      const position = positions.get(child);
      child.setPosition(position?.[0] ?? (r.min[0] + (r.max[0] - r.min[0]) * r.pivot[0] - pt.anchorX) * pt.width + r.position[0],
        position?.[1] ?? (r.min[1] + (r.max[1] - r.min[1]) * r.pivot[1] - pt.anchorY) * pt.height + r.position[1]);
      yield* this.layoutChildrenSteps(child, descend);
    }
  }

  /** Original Draw uses fixed-size children in a HorizontalLayoutGroup, with
   * a PreferredSize fitter on its width. Serialized width is only the last
   * layout result (daily ad hidden), not the width when both buttons appear. */
  private fitHorizontalGroup(parent: Node): Map<Node, Pair> {
    const positions = new Map<Node, Pair>(), spec = this.specs.get(parent);
    if (spec?.layoutType !== 'HorizontalLayoutGroup' || !spec.contentSizeFitter) return positions;
    const group = spec.layout!, pt = parent.getComponent(UITransform)!;
    const padding = group.m_Padding, spacing = group.m_Spacing;
    const children = parent.children.filter(child => child.active && this.specs.has(child));
    if (group.m_ReverseArrangement) children.reverse();
    const width = padding.m_Left + padding.m_Right + Math.max(0, children.length - 1) * spacing +
      children.reduce((sum, child) => sum + this.specs.get(child)!.rect.size[0], 0);
    const height = padding.m_Top + padding.m_Bottom + Math.max(0, ...children.map(child => this.specs.get(child)!.rect.size[1]));
    if (spec.contentSizeFitter.horizontalFit) pt.setContentSize(width, pt.height);
    if (spec.contentSizeFitter.verticalFit) pt.setContentSize(pt.width, height);
    this.baseSizes.set(parent, [pt.width, pt.height]);
    const horizontalAlign = (group.m_ChildAlignment % 3) / 2, verticalAlign = Math.floor(group.m_ChildAlignment / 3) / 2;
    let x = -pt.width * pt.anchorX + padding.m_Left + Math.max(0, pt.width - width) * horizontalAlign;
    for (const child of children) {
      const r = this.specs.get(child)!.rect;
      positions.set(child, [x + r.size[0] * r.pivot[0], (1 - pt.anchorY) * pt.height - padding.m_Top -
        (pt.height - padding.m_Top - padding.m_Bottom - r.size[1]) * verticalAlign - r.size[1] * (1 - r.pivot[1])]);
      x += r.size[0] + spacing;
    }
    return positions;
  }

  private redraw(node: Node): void {
    this.fittedImages.delete(node); this.textDirty.add(node); this.unlaidText.delete(node);
    const spec = this.specs.get(node)!; const tr = node.getComponent(UITransform)!; const graphic = node.getComponent(Graphics);
    const imageChild = this.imageChildren.get(node);
    if (imageChild) {
      const image = this.currentImages.get(node);
      const sx = spec.image?.tiled && image ? (spec.image.tileSize || 300) / image.sizePx[0] : 1;
      const sy = spec.image?.tiled && image ? (spec.image.tileSize || 300) / image.sizePx[1] : 1;
      imageChild.setScale(sx, sy, 1); imageChild.getComponent(UITransform)!.setContentSize(tr.width / sx, tr.height / sy);
      const childGraphic = imageChild.getComponent(Graphics);
      if (childGraphic) { childGraphic.clear(); childGraphic.rect(-tr.anchorX * tr.width, -tr.anchorY * tr.height, tr.width, tr.height); childGraphic.fill(); }
    }
    if (graphic && !spec.mask) {
      graphic.clear(); graphic.rect(-tr.anchorX * tr.width, -tr.anchorY * tr.height, tr.width, tr.height); graphic.fill();
    }
    const currentImage = this.currentImages.get(node);
    if (currentImage && (spec.image?.preserveAspect || currentImage.uiVisibleBoundsPx || currentImage.uiBowString)) this.fit(node, currentImage);
    const inline = this.inlineText.get(node);
    if (inline) {
      inline.maxWidth = tr.width;
      inline.node.setPosition((.5 - tr.anchorX) * tr.width, (.5 - tr.anchorY) * tr.height);
    }
    if (spec.text?.profile) this.setText(spec.id, this.textValues.get(node) ?? spec.text.value);
  }

  node(key: string): Node { const node = this.nodes.get(key); if (!node) throw new Error(`Original UI node missing: ${key}`); return node; }
  get(key: string | undefined): Node | undefined { return key ? this.nodes.get(key) : undefined; }
  show(key: string | undefined, visible: boolean): void {
    const node = this.get(key); if (!node || node.active === visible) return;
    node.active = visible;
    // Reflow only the affected layout group. A daily-button toggle must not
    // reset an unrelated weapon card that is being dragged or auto-merged.
    if (node.parent && this.specs.get(node.parent)?.contentSizeFitter) this.layoutChildren(node.parent);
  }
  setText(key: string | undefined, value: string): void {
    const node = this.get(key), label = node?.getComponent(Label); if (!label) return;
    const previous = this.textValues.get(node!);
    if (previous === value && !this.textDirty.has(node!)) return;
    // Changing an unfinished label may switch between bitmap and system runs.
    // Retain its original pool order before applying that dynamic transition.
    if (previous !== undefined && previous !== value && this.unlaidText.delete(node!)) this.bitmapTexts.get(node!)!.redraw();
    this.textDirty.delete(node!);
    label.string = value.replace(/\\+n/g, '\n').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '');
    const spec = this.specs.get(node!)?.text;
    this.textValues.set(node!, value);
    const bitmap = this.bitmapTexts.get(node!);
    if (bitmap) {
      const draw = !this.unlaidText.has(node!);
      bitmap.setText(value, undefined, draw); if (draw) label.fontSize = bitmap.fontSize; return;
    }
    const systemText = !!spec?.useSystemFont || /[\u3400-\u9fff]/.test(value);
    label.font = (spec && this.assets.fontVariants?.[spec.font]) || (systemText ? this.assets.chineseFont : spec?.font === 'numbers' ? this.assets.numberFont : this.assets.originalFont);
    label.useSystemFont = systemText; if (systemText) { label.font = null; label.fontFamily = 'sans-serif'; }
    if (spec) { label.fontSize = spec.size * (systemText ? .8 : 1); label.lineHeight = label.fontSize * 1.14; }
    const profile = spec?.profile && this.assets.config.textProfiles?.[spec.profile];
    if (spec && profile) this.applyTextProfile(node!, label, spec, profile);
    const rich = this.inlineText.get(node!);
    if (rich && spec) {
      rich.font = label.font as TTFFont; rich.fontSize = label.fontSize; rich.lineHeight = label.lineHeight;
      const color = [label.color.r, label.color.g, label.color.b].map(v => v.toString(16).padStart(2, '0')).join('');
      let text = value.replace(/\\+n/g, '<br/>').replace(/\n/g, '<br/>')
        // TMP sprite indices belong to each label's sprite asset. In particular,
        // index 0 is a slot gem on Upgrade, but a diamond on the reward label.
        .replace(/<sprite=(\d+)>/g, (_, index: string) => `<img src="${spec.spriteAsset ? `${spec.spriteAsset}-${index}` : index}" width=${label.fontSize} height=${label.fontSize} align=center/>`);
      const outer = profile ? (profile.faceDilate + profile.outlineWidth) * label.fontSize / profile.pointSize : 2.8;
      const border = profile ? profile.outlineColor.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('') : '65452d';
      rich.string = `<color=#${color}>${spec.outline ? `<outline color=#${border} width=${outer}>${text}</outline>` : text}</color>`;
    }
  }
  tint(key: string | undefined, value: number[]): void {
    const node = this.get(key); const sprite = node && (this.imageChildren.get(node) || node).getComponent(Sprite);
    const same = (color: Color) => color.r === value[0] && color.g === value[1] && color.b === value[2] && color.a === (value[3] ?? 255);
    const textLabel = node?.getComponent(Label);
    if ((!sprite || same(sprite.color)) && (!textLabel || same(textLabel.color)) && (sprite || textLabel)) return;
    if (sprite) sprite.color = sourceColor(value);
    const currentImage = node && this.currentImages.get(node);
    if (node && currentImage && this.bowStrings.has(node)) this.drawBowString(node, currentImage);
    const label = node?.getComponent(Label); if (label) label.color = sourceColor(value);
    if (node) this.bitmapTexts.get(node)?.tint(value, !this.unlaidText.has(node));
    if (node && this.inlineText.has(node)) { this.textDirty.add(node); this.setText(key, this.textValues.get(node) ?? ''); }
  }
  image(key: string | undefined, imageKey: string, material?: Material): void {
    const node = this.get(key), spec = this.assets.config.images[imageKey]; if (!node || !spec) return;
    const sprite = (this.imageChildren.get(node) || node).getComponent(Sprite); if (!sprite) return;
    if (material) sprite.customMaterial = material;
    this.currentImages.set(node, spec);
    const frame = this.art.frames.get(spec.path)!;
    if (sprite.spriteFrame !== frame) sprite.spriteFrame = frame;
    this.fit(node, spec);
  }
  private fit(node: Node, image: UiImageSpec): void {
    const box = this.baseSizes.get(node); if (!box) return;
    const imageNode = this.imageChildren.get(node) || node, tr = imageNode.getComponent(UITransform)!;
    let rotationDeg = 0;
    for (let ancestor: Node | null = imageNode; ancestor; ancestor = ancestor.parent) rotationDeg += ancestor.angle;
    const reference = image.uiHeightReference ? this.assets.config.images[image.uiHeightReference] : undefined;
    // Image specs are authored data; include mutable scalar/array geometry so
    // preview tooling, resized slots and accumulated parent rotations invalidate.
    const geometry = [box[0], box[1], tr.anchorX, tr.anchorY, rotationDeg, image.sizePx.join(','), image.uiDisplayScale,
      image.uiVisibleBoundsPx?.join(','), image.uiVisibleHullPx?.join(';'), image.uiBowString && JSON.stringify(image.uiBowString),
      reference && JSON.stringify([reference.sizePx, reference.uiVisibleHullPx, reference.uiHeightReferenceFrame])].join('|');
    const cached = this.fittedImages.get(node);
    if (cached?.image === image && cached.reference === reference && cached.geometry === geometry &&
      tr.width === cached.width && tr.height === cached.height && imageNode.position.x === cached.x && imageNode.position.y === cached.y) return;
    const layout = fitUiImage(image, box, [tr.anchorX, tr.anchorY], rotationDeg, reference);
    tr.setContentSize(...layout.size);
    imageNode.setPosition(...layout.position, 0);
    this.drawBowString(node, image);
    this.fittedImages.set(node, { image, reference, geometry, width: tr.width, height: tr.height, x: imageNode.position.x, y: imageNode.position.y });
  }

  private drawBowString(node: Node, image: UiImageSpec): void {
    const string = bowString(image), existing = this.bowStrings.get(node);
    if (!string) { if (existing) existing.node.active = false; return; }
    const imageNode = this.imageChildren.get(node) || node, tr = imageNode.getComponent(UITransform)!;
    const line = existing ?? makeNode('OriginalBowString', imageNode).addComponent(Graphics);
    if (!existing) {
      this.bowStrings.set(node, line);
      if (this.materials.graphics && (this.materials.layer === undefined || node.layer === this.materials.layer)) line.customMaterial = this.materials.graphics;
    }
    line.node.active = true;
    const sx = tr.width / image.sizePx[0], sy = tr.height / image.sizePx[1];
    const point = (p: Pair): Pair => [(p[0] - tr.anchorX * image.sizePx[0]) * sx, (image.sizePx[1] * (1 - tr.anchorY) - p[1]) * sy];
    const tint = imageNode.getComponent(Sprite)!.color, color = string.color;
    // Sprite alpha already propagates down this image subtree; multiply RGB only.
    line.strokeColor = new Color(color[0] * tint.r / 255, color[1] * tint.g / 255, color[2] * tint.b / 255, color[3]);
    line.lineWidth = string.widthPx * Math.min(sx, sy);
    line.clear(); line.moveTo(...point(string.upperPx)); line.lineTo(...point(string.bracePx)); line.lineTo(...point(string.lowerPx)); line.stroke();
  }

  private applyTextProfile(node: Node, label: Label, spec: NonNullable<OriginalUiNode['text']>, profile: OriginalTextProfile): void {
    const tr = node.getComponent(UITransform)!, emHeight = (profile.ascent - profile.descent) / profile.pointSize;
    let size = spec.size * profile.scale;
    if (spec.autosize && tr.width > 0 && tr.height > 0) {
      const max = (spec.maxSize ?? spec.size) * profile.scale, min = (spec.minSize ?? 1) * profile.scale;
      const lines = label.string.split('\n');
      const advance = (line: string) => Array.from(line).reduce((sum, ch) => sum + (profile.advances[String(ch.codePointAt(0))] ?? 1), 0);
      const fits = (fontSize: number): boolean => {
        const widths = lines.map(line => advance(line) * fontSize);
        const count = spec.wrap ? widths.reduce((sum, width) => sum + Math.max(1, Math.ceil(width / tr.width)), 0) : lines.length;
        return (spec.wrap || Math.max(...widths) <= tr.width) && count * fontSize * emHeight <= tr.height + .001;
      };
      let low = min, high = max;
      if (fits(max)) size = max;
      else {
        for (let i = 0; i < 16; i++) { const mid = (low + high) / 2; if (fits(mid)) low = mid; else high = mid; }
        size = Math.floor(low * 20) / 20;
      }
    }
    label.fontSize = size; label.lineHeight = size * emHeight; label.overflow = Label.Overflow.CLAMP;
    const outline = node.getComponent(LabelOutline);
    // Preserve TMP's outer contour on a single glyph layer. Layering a white
    // stroked Label over this one is not equivalent to SDF face dilation:
    // Cocos lays out the two outline/shadow textures separately and produces
    // doubled strokes that obscure the border. Keep the original font face.
    if (outline) { outline.color = sourceColor(profile.outlineColor); outline.width = (profile.faceDilate + profile.outlineWidth) * size / profile.pointSize; }
    if (profile.shadowOffset.some(value => value !== 0)) {
      const shadow = node.getComponent(LabelShadow) || node.addComponent(LabelShadow);
      shadow.color = sourceColor(profile.shadowColor); shadow.blur = 0;
      shadow.offset = new Vec2(profile.shadowOffset[0] * size / profile.pointSize, profile.shadowOffset[1] * size / profile.pointSize);
    }
  }

  /** The HUD owns its nodes; this renderer owns only the runtime atlas wrapper.
   * RichText.onDestroy does not release imageAtlas. Its frames are borrowed
   * from ArtLibrary and must remain usable by other HUDs and the next session. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const text of this.bitmapTexts.values()) text.destroy();
    this.bitmapFactory?.destroy(); this.bitmapTexts.clear();
    if (this.inlineAtlas) {
      this.inlineAtlas.spriteFrames = {};
      this.inlineAtlas.destroy(); this.inlineAtlas = null;
    }
    this.inlineText.clear(); this.textValues.clear(); this.textDirty.clear(); this.unlaidText.clear(); this.fittedImages.clear(); this.nodes.clear(); this.specs.clear();
    this.baseSizes.clear(); this.imageChildren.clear(); this.currentImages.clear(); this.bowStrings.clear();
  }
}
