import { Color, JsonAsset, Layers, Material, Node, resources, Sprite, SpriteFrame, UITransform } from 'cc';
import { ORIGINAL_WORLD_LAYER } from './OriginalColorMath';
import type { CatBonePose, CatClip, CatDynamics } from './OriginalCatAnimation';

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
  catalog: any;
  rig!: RigData;
  linearSpriteMaterial?: Material;
  linearGraphicsMaterial?: Material;
  originalHealthFillMaterial?: Material;
  readonly frames = new Map<string, SpriteFrame>();
  private readonly frameRequests = new Map<string, Promise<SpriteFrame>>();

  async load(): Promise<void> {
    this.catalog = await this.json('art/catalog');
    this.rig = await this.json(this.catalog.characters.cat_basic.rig);
    this.catalog.feedback = await this.json('art/effects/original-feedback');
    const paths = new Set<string>();
    const walk = (value: any): void => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.path === 'string' && value.sizeUnits) paths.add(value.path);
      for (const item of Object.values(value)) walk(item);
    };
    walk(this.catalog); walk(this.rig.parts); walk(this.rig.attachments);
    // Creator's loose iterable transform does not reliably spread ES6 Sets.
    await Promise.all(Array.from(paths).map(path => this.loadFrame(path)));
  }

  loadFrame(path: string): Promise<SpriteFrame> {
    const cached = this.frames.get(path);
    if (cached) return Promise.resolve(cached);
    const pending = this.frameRequests.get(path);
    if (pending) return pending;
    const request = new Promise<SpriteFrame>((resolve, reject) =>
      resources.load(`${path}/spriteFrame`, SpriteFrame, (error, frame) => error ? reject(error) : resolve(frame)))
      .then(frame => {
        this.frames.set(path, frame); this.frameRequests.delete(path); return frame;
      }, error => {
        this.frameRequests.delete(path); throw error;
      });
    this.frameRequests.set(path, request);
    return request;
  }

  async json<T = any>(path: string): Promise<T> {
    return new Promise((resolve, reject) => resources.load(path, JsonAsset,
      (err, asset) => err ? reject(err) : asset.json === null
        ? reject(new Error(`Empty JSON asset: ${path}`)) : resolve(asset.json as T)));
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
