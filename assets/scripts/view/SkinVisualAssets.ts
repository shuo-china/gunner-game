import { Material, Vec4 } from 'cc';
import type { ArtLibrary, RigPart } from './ArtLibrary';

export interface SkinVisual {
  id: number;
  source: string;
  parts: RigPart[];
  handColor: [number, number, number, number];
  /** sRGB fur palette, shared by battle parts, holding hand and the live skin menu. */
  furColor?: [number, number, number, number];
  /** Top-down UVs: unchanged collar bottom, source artwork bottom, visible artwork bottom. */
  bodyArtworkFit?: [number, number, number];
  /** Fabric reference UV and horizontal column blend; excludes baked lower outlines. */
  bodyArtworkHem?: [number, number, number];
  validation: { boneCount: number; vertices: number; triangles: number;
    allVerticesRigidWeightOne: boolean; allTrianglesSingleBone: boolean };
}
export interface SkinVisualConfig { version: number; bodyContour: { path: string; sizePx: [number, number] }; skins: SkinVisual[]; }

/** Source meshes share the cat bind pose; only their rigid triangle groups differ. */
export class SkinVisualAssets {
  private readonly loaded = new Set<number>();
  private readonly pending = new Map<number, Promise<void>>();
  private readonly palettes = new Map<Material, Map<number, Material>>();
  private readonly bodies = new Map<Material, Map<string, Material>>();

  constructor(readonly config: SkinVisualConfig, private readonly art?: ArtLibrary) {
    if (config.version !== 1 || !config.bodyContour?.path || config.skins.length !== 25 || config.skins.some((skin, id) =>
      skin.id !== id || skin.parts.length === 0 || skin.validation.boneCount !== 9 ||
      !skin.validation.allVerticesRigidWeightOne || !skin.validation.allTrianglesSingleBone)) {
      throw new Error('Invalid original skin artwork');
    }
  }

  static async load(art: ArtLibrary, selectedId = 0): Promise<SkinVisualAssets> {
    const assets = new SkinVisualAssets(await art.json<SkinVisualConfig>('art/skin-system/visuals'), art);
    // CatView constructs the default skin before applying the saved selection.
    // The skin menu prepares the remaining bodies when its module is loaded.
    await Promise.all(Array.from(new Set([0, selectedId]), id => assets.ensureLoaded(id)));
    art.skinVisuals = assets;
    return assets;
  }

  isLoaded(id: number): boolean { return this.loaded.has(id); }

  /** Reuse materials by artwork fit and pass, keeping the original contour for all skins. */
  bodyMaterial(base?: Material, id = 0): Material | undefined {
    if (!base || !this.art) return base;
    const skin = this.appearance(id), fit = skin.bodyArtworkFit, hem = skin.bodyArtworkHem;
    const key = fit ? `${fit.join(',')}:${hem?.join(',') ?? 'fabric'}` : 'native';
    let cache = this.bodies.get(base);
    if (!cache) { cache = new Map(); this.bodies.set(base, cache); }
    let material = cache.get(key);
    if (!material) {
      // Original torso alpha/rim matches the unchanged original foot roots.
      // Costume PNGs supply color only; none may redefine the shared junction.
      const frame = this.art.frames.get(this.config.bodyContour.path);
      if (!frame) throw new Error('Canonical skin body must be loaded before rendering');
      material = new Material();
      material.initialize({ effectAsset: base.effectAsset!, defines: { SKIN_BODY_TEMPLATE: true, SKIN_BODY_ART_FIT: !!fit } });
      material.setProperty('skinBodyTemplate', frame.texture);
      if (fit) material.setProperty('skinBodyArtworkFit', new Vec4(fit[0], fit[1], fit[2], 0));
      if (fit && hem) material.setProperty('skinBodyHemReference', new Vec4(hem[0], hem[1], hem[2], 0));
      cache.set(key, material);
    }
    return material;
  }

  /** Reuse one material per skin/pass across the squad; never tint clothing. */
  paletteMaterial(id: number, base?: Material): Material | undefined {
    const color = this.appearance(id).furColor;
    if (!base || !color || id === 0) return base;
    let cache = this.palettes.get(base);
    if (!cache) { cache = new Map(); this.palettes.set(base, cache); }
    let material = cache.get(id);
    if (!material) {
      material = new Material();
      material.initialize({ effectAsset: base.effectAsset!, defines: { SKIN_FUR_PALETTE: true } });
      material.setProperty('skinFurColor', new Vec4(color[0] / 255, color[1] / 255, color[2] / 255, 1));
      cache.set(id, material);
    }
    return material;
  }

  dispose(): void {
    this.bodies.forEach(cache => cache.forEach(material => material.destroy()));
    this.bodies.clear();
    this.palettes.forEach(cache => cache.forEach(material => material.destroy()));
    this.palettes.clear();
  }

  ensureLoaded(id: number): Promise<void> {
    const skin = this.appearance(id);
    if (this.loaded.has(id)) return Promise.resolve();
    const existing = this.pending.get(id);
    if (existing) return existing;
    const art = this.art;
    if (!art) return Promise.reject(new Error('Skin artwork has no resource loader'));
    const paths = new Set([this.config.bodyContour.path, ...skin.parts.map(part => part.path)]);
    const request = Promise.all(Array.from(paths, path => art.loadFrame(path))).then(() => {
      this.loaded.add(id); this.pending.delete(id);
    }, error => { this.pending.delete(id); throw error; });
    this.pending.set(id, request);
    return request;
  }

  appearance(id: number): SkinVisual {
    const skin = Number.isInteger(id) && this.config.skins[id];
    if (!skin) throw new Error(`Unknown original skin: ${id}`);
    return skin;
  }
}
