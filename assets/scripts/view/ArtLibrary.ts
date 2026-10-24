import { Color, Layers, Material, Node, Sprite, SpriteFrame, UITransform } from 'cc';
import { ORIGINAL_WORLD_LAYER } from './OriginalColorMath';
import { GameResourceLoader } from './GameResourceLoader';
import type { ResourceProfile } from './GameResourceLoader';
import { loadResourceBatch } from './ResourceBatch';
import { prepareNumberGlyphFrames } from './NumberGlyphAtlas';
import type { CatBonePose, CatClip, CatDynamics } from './OriginalCatAnimation';
import type { WeaponVisualAssets } from './WeaponVisualAssets';
import type { SkinVisualAssets } from './SkinVisualAssets';

export interface ImageSpec {
  path: string;
  sizePx: [number, number];
  sizeUnits: [number, number];
  anchor: [number, number];
  ppu?: number;
  localPosition?: [number, number];
  localRotationDeg?: number;
  localScale?: [number, number];
  color?: [number, number, number, number];
}

export type BonePose = CatBonePose;
export interface BoneSpec {
  id: string | number; name: string; parent: string | number | null;
  position: [number, number]; rotationDeg: number; scale: [number, number];
}
export interface RigPart extends ImageSpec { id: string; bone: string | number; drawOrder?: number }
export type RigAnimation = CatClip;
export interface RigData {
  bones: BoneSpec[];
  parts: RigPart[];
  animations: { idle: RigAnimation; walk: RigAnimation };
  dynamics: CatDynamics;
  attachments: Record<string, any>;
  display: { scale: number; pivotOffset: [number, number]; projectionScaleY: number };
}

/** Loads only the small V1 art bundle. Combat never receives these paths. */
export class ArtLibrary {
  // Runtime catalogs can arrive before the base art finishes loading. Keep a
  // stable owner without adding those catalogs to the base resource scan.
  catalog: any = {};
  rig!: RigData;
  weaponVisuals?: WeaponVisualAssets;
  skinVisuals?: SkinVisualAssets;
  linearSpriteMaterial?: Material;
  linearGraphicsMaterial?: Material;
  originalHealthFillMaterial?: Material;
  readonly frames = new Map<string, SpriteFrame>();
  private readonly frameRequests = new Map<string, Promise<SpriteFrame>>();
  private readonly jsonRequests = new Map<string, Promise<any>>();
  onAssetLoaded?: (completed: number) => void;
  private completedLoads = 0;
  private disposed = false;

  constructor(readonly resourceLoader = new GameResourceLoader()) {}

  private reportLoaded(): void {
    this.completedLoads++;
    this.onAssetLoaded?.(this.completedLoads);
  }

  async load(): Promise<void> {
    const baseCatalog = { ...await this.json('art/catalog') };
    Object.assign(this.catalog, baseCatalog);
    [this.rig, baseCatalog.feedback] = await Promise.all([
      this.json(baseCatalog.characters.cat_basic.rig), this.json('art/effects/original-feedback'),
    ]);
    this.catalog.feedback = baseCatalog.feedback;
    const paths = new Set<string>();
    const numberGlyphs:Record<string,ImageSpec> = baseCatalog.feedback.damage.glyphs;
    const walk = (value: any): void => {
      if (!value || typeof value !== 'object' || value === numberGlyphs) return;
      if (typeof value.path === 'string' && value.sizeUnits) paths.add(value.path);
      for (const item of Object.values(value)) walk(item);
    };
    walk(baseCatalog); walk(this.rig.parts); walk(this.rig.attachments);
    // Creator's loose iterable transform does not reliably spread ES6 Sets.
    await Promise.all([
      loadResourceBatch(Array.from(paths, path => () => this.loadFrame(path))),
      prepareNumberGlyphFrames(this, Object.values(numberGlyphs).map(spec => spec.path)),
    ]);
  }

  loadFrame(path: string, profile: ResourceProfile = 'foreground'): Promise<SpriteFrame> {
    if (this.disposed) return Promise.reject(new Error('Art library disposed'));
    const cached = this.frames.get(path);
    if (cached && cached.isValid !== false) return Promise.resolve(cached);
    if (cached) { this.frames.delete(path); this.resourceLoader.invalidate(`${path}/spriteFrame`, 'spriteFrame'); }
    const pending = this.frameRequests.get(path);
    if (pending) return pending;
    const request = this.resourceLoader.load(`${path}/spriteFrame`, 'spriteFrame', profile)
      .then(frame => {
        if (!this.disposed) { frame.addRef?.(); this.frames.set(path, frame); }
        this.frameRequests.delete(path); return frame;
      }, error => {
        this.frameRequests.delete(path); throw error;
      });
    const tracked = request.then(frame => { this.reportLoaded(); return frame; });
    this.frameRequests.set(path, tracked);
    return tracked;
  }

  json<T = any>(path: string): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Art library disposed'));
    const pending = this.jsonRequests.get(path);
    if (pending) return pending;
    const request = this.resourceLoader.loadJson<T>(path)
      .then(value => { this.reportLoaded(); return value; }, error => { this.jsonRequests.delete(path); throw error; });
    this.jsonRequests.set(path, request);
    return request;
  }

  /** Only pass paths belonging to a closed, idle module. retained must contain
   * every path still needed by core gameplay or another live view. Cocos Sprite
   * assignments do not retain dynamic assets, so guessing ownership is unsafe.
   * Reference-counted release preserves textures shared by retained frames. */
  evictFrames(candidates: readonly string[], retained: ReadonlySet<string>): number {
    let released = 0;
    for (const path of Array.from(new Set(candidates))) {
      if (retained.has(path) || this.frameRequests.has(path)) continue;
      const frame = this.frames.get(path); if (!frame) continue;
      this.frames.delete(path); this.resourceLoader.invalidate(`${path}/spriteFrame`, 'spriteFrame');
      frame.decRef?.(); released++;
    }
    return released;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.skinVisuals?.dispose();
    this.frames.forEach(frame => frame.decRef?.());
    this.frames.clear(); this.frameRequests.clear(); this.jsonRequests.clear(); this.resourceLoader.invalidate();
  }

  image(name: string, spec: ImageSpec, parent: Node): Node {
    if (!spec || !this.frames.has(spec.path)) throw new Error(`Missing art: ${name} / ${spec?.path}`);
    const node = makeNode(name, parent);
    const tr = node.getComponent(UITransform)!;
    const sprite = node.addComponent(Sprite);
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    sprite.spriteFrame = this.frames.get(spec.path)!;
    if (node.layer === ORIGINAL_WORLD_LAYER && this.linearSpriteMaterial) sprite.customMaterial = this.linearSpriteMaterial;
    sprite.trim = false;
    // SpriteFrame assignment can resize UITransform unless CUSTOM is set first.
    // Keep the final authoring size in world units, never source bitmap pixels.
    tr.setContentSize(spec.sizeUnits[0], spec.sizeUnits[1]);
    tr.setAnchorPoint(spec.anchor[0], spec.anchor[1]);
    sprite.color = Color.WHITE;
    if (spec.localPosition) node.setPosition(...spec.localPosition, 0);
    if (spec.localRotationDeg) node.angle = spec.localRotationDeg;
    if (spec.localScale) node.setScale(spec.localScale[0], spec.localScale[1], 1);
    if (spec.color) sprite.color = new Color(spec.color[0], spec.color[1], spec.color[2], spec.color[3]);
    return node;
  }
}

export function makeNode(name: string, parent?: Node): Node {
  const node = new Node(name);
  node.layer = parent?.layer ?? Layers.Enum.UI_2D;
  node.addComponent(UITransform);
  if (parent) parent.addChild(node);
  return node;
}
