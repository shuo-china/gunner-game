import { ArtLibrary, ImageSpec } from './ArtLibrary';
import { getWeapon, isWeaponId } from '../core/WeaponCatalog';
import type { MuzzleEffectSpec } from './OriginalMuzzleEffect';
import type { ParticleSpec } from './OriginalParticleSimulation';
import type { DamageNumberConfig } from './DamageNumbers';
import type { WeaponGradeEffectConfig } from './WeaponGradeEffectSimulation';
import { EffectAsset } from 'cc';
import type { CustomProjectileProfile } from './CustomProjectileMotion';
import type { BowStringSpec } from './WeaponAttackAnimation';
import { prepareNumberGlyphFrames } from './NumberGlyphAtlas';
export type { CustomProjectileProfile } from './CustomProjectileMotion';

export interface WeaponAppearanceSpec {
  id: number;
  image: ImageSpec;
  /** Separate string follows the drawing palm; artwork contains only the bow body. */
  bowString?: BowStringSpec;
  /** Front supporting palm, registered in top-left source sprite pixels. */
  supportGripPx?: [number, number];
  muzzle: { localPosition: [number, number]; localRotationDeg?: number; localScale?: [number, number] };
  recoil?: { duration: number; position: [number, number]; gunScale: [number, number] };
  projectileSkin: string;
  muzzleSkin: string;
  soundId: number;
  /** Grade-colored staff charge/release glow, already in linear RGB. */
  castColor?: number[];
}
export interface WeaponVisualConfig {
  weapons: WeaponAppearanceSpec[];
  projectileSkins: Record<string, ParticleSpec[]>;
  customProjectiles?: Record<string, CustomProjectileProfile>;
  muzzleSkins: Record<string, MuzzleEffectSpec>;
  images: Record<string, ImageSpec>;
  sounds: Record<string, string>;
  criticalDamage?: DamageNumberConfig;
  gradeEffects?: WeaponGradeEffectConfig;
  /** Generated category catalogs; authored data remains available to tools. */
  projectileGroups?: Record<string, string>;
}
interface ProjectileCatalog {
  version: number;
  data: Pick<WeaponVisualConfig, 'projectileSkins' | 'customProjectiles'>;
  meshGeometries: string[];
  meshes: { path: string[]; index: number }[];
}

/** Shared source assets; per-cat/per-emitter state belongs to views. */
export class WeaponVisualAssets {
  private readonly appearances = new Map<number, WeaponAppearanceSpec>();
  private readonly warnedMissingAppearances = new Set<number>();
  private readonly groupRequests = new Map<string, Promise<void>>();
  readonly loadedFramePaths = new Set<string>();
  customProjectileEffect?: EffectAsset;

  constructor(readonly config: WeaponVisualConfig, private readonly art?: ArtLibrary) {
    for (const weapon of config.weapons) {
      if (!Number.isInteger(weapon.id) || weapon.id < 0 || this.appearances.has(weapon.id))
        throw new Error(`Invalid or duplicate weapon appearance ${weapon.id}`);
      if ((!config.projectileSkins[weapon.projectileSkin] && !config.projectileGroups?.[weapon.projectileSkin]) || !config.muzzleSkins[weapon.muzzleSkin])
        throw new Error(`Missing projectile or release effect for weapon ${weapon.id}`);
      if (!weapon.image.path || !weapon.muzzle.localPosition.every(Number.isFinite))
        throw new Error(`Invalid weapon artwork or firing point ${weapon.id}`);
      if (weapon.supportGripPx && (!weapon.image.sizePx || weapon.supportGripPx.length !== 2 ||
        !weapon.supportGripPx.every((value, axis) => Number.isFinite(value) && value >= 0 && value <= weapon.image.sizePx[axis])))
        throw new Error(`Invalid support grip for weapon ${weapon.id}`);
      this.appearances.set(weapon.id, weapon);
    }
    if (!this.appearances.has(0)) throw new Error('Missing base weapon appearance 0');
    for (const [key, profile] of Object.entries(config.customProjectiles ?? {})) {
      if (!config.projectileSkins[key] || !profile.sprite.path ||
        ![profile.bodyLength, profile.sprite.aspect, profile.flightRamp.duration].every(value => Number.isFinite(value) && value > 0))
        throw new Error(`Invalid custom projectile profile ${key}`);
    }
  }

  appearance(id: number): WeaponAppearanceSpec {
    const weapon = this.appearances.get(id);
    if (weapon) return weapon;
    // A save may outlive the appearance table bundled by a preview or cached
    // client. Keep the weapon's gameplay data and render the nearest available
    // art of the same category; never fail the entire startup for missing art.
    let fallback: WeaponAppearanceSpec | undefined;
    if (isWeaponId(id)) {
      const definition = getWeapon(id);
      const candidates = Array.from(this.appearances.values());
      fallback = candidates.find(candidate => {
        const available = getWeapon(candidate.id);
        return available.category === definition.category && available.grade === definition.grade;
      }) ?? candidates.find(candidate => getWeapon(candidate.id).category === definition.category);
    }
    fallback ??= this.appearances.get(0)!;
    if (!this.warnedMissingAppearances.has(id)) {
      this.warnedMissingAppearances.add(id);
      console.warn(`[ForestGunner] Missing weapon appearance ${id}; using weapon ${fallback.id} artwork.`);
    }
    return fallback;
  }

  private ensureGroup(path: string): Promise<void> {
    const pending = this.groupRequests.get(path);
    if (pending) return pending;
    const request = this.art!.json<ProjectileCatalog>(path).then(catalog => {
      if (catalog.version !== 1 || !catalog.data?.projectileSkins || !Array.isArray(catalog.meshes) || !Array.isArray(catalog.meshGeometries))
        throw new Error('Invalid projectile catalog ' + path);
      // Do not mutate Cocos' cached JSON. Every authored effect receives its own
      // geometry arrays, preserving the previous isolation and exact numbers.
      const data = { ...catalog.data, projectileSkins: { ...catalog.data.projectileSkins } };
      const copied = new Set<string>();
      for (const reference of catalog.meshes) {
        if (reference.path.length !== 4 || reference.path[0] !== 'projectileSkins' || reference.path[3] !== 'mesh' ||
          !Number.isInteger(reference.index) || typeof catalog.meshGeometries[reference.index] !== 'string')
          throw new Error('Invalid projectile mesh reference ' + path);
        const key = reference.path[1], index = Number(reference.path[2]);
        if (!Number.isInteger(index) || !data.projectileSkins[key]?.[index]?.mesh) throw new Error('Invalid projectile mesh target ' + path);
        if (!copied.has(key)) { data.projectileSkins[key] = data.projectileSkins[key].slice(); copied.add(key); }
        const spec = data.projectileSkins[key][index], geometry = JSON.parse(catalog.meshGeometries[reference.index]);
        if (!Array.isArray(geometry.positions) || !Array.isArray(geometry.uv) || !Array.isArray(geometry.indices))
          throw new Error('Invalid projectile geometry ' + path);
        data.projectileSkins[key][index] = { ...spec, mesh: { ...spec.mesh!, ...geometry } };
      }
      for (const [key, specs] of Object.entries(data.projectileSkins)) {
        if (this.config.projectileGroups?.[key] !== path || !Array.isArray(specs)) throw new Error('Unexpected projectile key ' + key);
      }
      for (const [key, profile] of Object.entries(data.customProjectiles ?? {})) {
        if (!data.projectileSkins[key] || !profile.sprite.path ||
          ![profile.bodyLength, profile.sprite.aspect, profile.flightRamp.duration].every(value => Number.isFinite(value) && value > 0))
          throw new Error('Invalid custom projectile profile ' + key);
      }
      Object.assign(this.config.projectileSkins, data.projectileSkins);
      Object.assign(this.config.customProjectiles!, data.customProjectiles);
    }).catch(error => { this.groupRequests.delete(path); throw error; });
    this.groupRequests.set(path, request); return request;
  }

  /** The initial squad needs only its categories. Equipment/Raid preparation
   * calls prepareAll before viewReady, so choosing any weapon never downloads. */
  async prepareWeapons(ids: readonly number[]): Promise<void> {
    if (!this.art) return;
    const weapons = Array.from(new Set(ids), id => this.appearance(id));
    const groups = new Set(weapons.map(weapon => this.config.projectileGroups?.[weapon.projectileSkin]).filter((path): path is string => !!path));
    await Promise.all(Array.from(groups, path => this.ensureGroup(path)));
    const paths = new Set<string>();
    for (const weapon of weapons) {
      paths.add(weapon.image.path);
      const systems = this.config.projectileSkins[weapon.projectileSkin];
      if (!systems) throw new Error('Missing prepared projectile ' + weapon.projectileSkin);
      for (const spec of systems) paths.add(spec.image.path);
      for (const spec of this.config.muzzleSkins[weapon.muzzleSkin].particleSystems) paths.add(this.config.images[spec.spriteId].path);
      const profile = this.config.customProjectiles?.[weapon.projectileSkin];
      if (profile) {
        paths.add(profile.sprite.path);
        if (profile.airFlow) paths.add(profile.airFlow.image.path);
        if (profile.cometTrail) paths.add(profile.cometTrail.image.path);
      }
    }
    for (const spec of Object.values(this.config.gradeEffects?.images ?? {})) paths.add(spec.path);
    await Promise.all([
      Promise.all(Array.from(paths, async path => { await this.art!.loadFrame(path); this.loadedFramePaths.add(path); })),
      prepareNumberGlyphFrames(this.art,Object.values(this.config.criticalDamage?.glyphs ?? {}).map(spec=>spec.path))
        .then(paths=>{for(const path of paths)this.loadedFramePaths.add(path);}),
    ]);
    if (!this.customProjectileEffect && weapons.some(weapon => this.config.customProjectiles?.[weapon.projectileSkin]))
      this.customProjectileEffect = await this.art.resourceLoader.load('art/rendering/custom-projectile', 'effect');
  }

  prepareAll(): Promise<void> { return this.prepareWeapons(this.config.weapons.map(weapon => weapon.id)); }

  static async load(art: ArtLibrary, initialWeaponIds: readonly number[] = [0]): Promise<WeaponVisualAssets> {
    const [config, criticalDamage, gradeEffects] = await Promise.all([
      art.json<WeaponVisualConfig>('art/weapon-runtime/index'),
      art.json<DamageNumberConfig>('art/weapon-system/critical/config'),
      art.json<WeaponGradeEffectConfig>('art/weapon-grade-effects/config'),
    ]);
    const assets = new WeaponVisualAssets({ ...config, projectileSkins: {}, customProjectiles: {}, criticalDamage, gradeEffects }, art);
    // CatView constructs weapon 0 before applying the saved squad loadout.
    // Weapon/Raid HUD loaders prepare all preview images before equipment UI opens.
    await assets.prepareWeapons(Array.from(new Set([0, ...initialWeaponIds])));
    art.weaponVisuals = assets;
    return assets;
  }
}
