import type { ResourceKind } from './GameResourceLoader';

export type BackgroundFeature = typeof MODULE_DEFINITIONS[number]['name'];
export type BackgroundGroup = BackgroundFeature | 'maps' | 'bgm' | 'sfx';
export interface BackgroundResource { path: string; kind: ResourceKind; }
export interface BackgroundConfig { path: string; group: BackgroundGroup; offset: number; }

export interface ResourceModuleDefinition {
  name: BackgroundFeature;
  config: string;
  entry?: string;
  eligibility: 'always' | 'unlocked' | 'demand';
  startup: 'always' | 'unlocked' | 'demand';
}

/** The order applies to startup, asset preparation and hidden view construction.
 * Encounter rigs, whole map catalogs and cosmetic variants are deliberately not
 * panel dependencies. Their owners request the current/next item explicitly. */
const MODULE_DEFINITIONS = [
  { name: 'weapons', config: 'weapon', eligibility: 'always' },
  { name: 'speedrun', config: 'speedrun', eligibility: 'always' },
  { name: 'settings', config: 'settings', eligibility: 'always' },
  { name: 'rebirth', config: 'rebirth', eligibility: 'unlocked' },
  { name: 'raid', config: 'raid', eligibility: 'unlocked' },
  { name: 'boss', config: 'boss', eligibility: 'unlocked' },
  { name: 'hunt', config: 'hunt', eligibility: 'unlocked' },
  { name: 'mine', config: 'mine', eligibility: 'unlocked' },
  { name: 'skins', config: 'skin', eligibility: 'unlocked' },
  { name: 'pets', config: 'pet', eligibility: 'unlocked' },
  { name: 'fish', config: 'fish', eligibility: 'unlocked' },
  { name: 'adventure', config: 'adventure', eligibility: 'unlocked' },
  { name: 'dailyCheck', config: 'daily-check', eligibility: 'demand' },
  { name: 'offline', config: 'offline', eligibility: 'demand' },
] as const;

export const RESOURCE_MODULES: readonly ResourceModuleDefinition[] = MODULE_DEFINITIONS.map(item => ({ ...item,
  // Locked weapons/challenge wait until gameplay, then lead automatic preparation.
  startup: item.name === 'settings' ? 'always' : item.name === 'offline' ? 'demand' : 'unlocked',
  config: `art/${item.config}-system/config`,
  entry: item.name === 'settings' || item.name === 'offline' ? undefined : `art/feature-entries/${item.name}` }));

export const RESOURCE_MODULE_ORDER: readonly BackgroundFeature[] = RESOURCE_MODULES.map(item => item.name);
export const BACKGROUND_FEATURES = RESOURCE_MODULE_ORDER;
export function isStartupModule(name: BackgroundFeature, unlocked: boolean, demanded = false): boolean {
  const item = RESOURCE_MODULES.find(module => module.name === name)!;
  return item.startup === 'always' || (item.startup === 'unlocked' ? unlocked : demanded);
}
export function isAutomaticModule(name: BackgroundFeature, unlocked: boolean): boolean {
  const item = RESOURCE_MODULES.find(module => module.name === name)!;
  return item.eligibility === 'always' || (item.eligibility === 'unlocked' && unlocked);
}

/** Keep in sync with weaponHudImagePaths' UI validation. This pure manifest
 * helper avoids importing the Cocos UI implementation into the preloader. */
export function weaponPanelImagePaths(config: any): string[] {
  const collection = new Set<string>(), common = new Set<string>();
  const visit = (id: string, paths: Set<string>): void => {
    const node = config.nodes[id], image = node.image?.sprite && config.images[node.image.sprite];
    if (image) paths.add(image.path);
    for (const child of node.children) visit(child, paths);
  };
  for (const [name, id] of Object.entries(config.roots)) visit(id as string, name === 'collection' ? collection : common);
  for (const key of [...config.gunIcons, ...Object.values(config.inlineSprites ?? {})] as string[]) {
    if (config.images[key]) common.add(config.images[key].path);
  }
  const paths = Object.values(config.images).map((image: any) => image.path as string)
    .filter(path => !collection.has(path) || common.has(path));
  for (const font of Object.values(config.bitmapFonts ?? {}) as { pages: string[] }[]) paths.push(...font.pages);
  return Array.from(new Set(paths));
}

/** Only live runtime catalogs, never the entire resources directory or source art. */
export function backgroundConfigs(_petCount = 0): BackgroundConfig[] {
  const configs: BackgroundConfig[] = [];
  for (const module of RESOURCE_MODULES) {
    configs.push({ path: module.config, group: module.name, offset: 0 });
    if (module.entry) configs.push({ path: module.entry, group: module.name, offset: -1 });
  }
  configs.push({ path: 'art/original-bgm/config', group: 'bgm', offset: 0 },
    { path: 'art/original-sfx/config', group: 'sfx', offset: 0 });
  return configs;
}

/** JSON contains ordinary string paths, not engine UUID dependencies. Enumerate
 * them explicitly so preloading the JSON cannot masquerade as prepared artwork. */
export function collectBackgroundResources(config: any, group: BackgroundGroup): BackgroundResource[] {
  const found = new Map<string, BackgroundResource>();
  const add = (path: unknown, kind: BackgroundResource['kind']): void => {
    if (typeof path !== 'string' || !path.startsWith('art/')) return;
    // Creator's packed Texture2D records can omit ImageAsset dependencies from
    // preload discovery. Explicitly fetch the original image as well; loading
    // only SpriteFrame metadata otherwise leaves PNG downloads until first use.
    if (kind === 'spriteFrame') found.set(`image:${path}`, { path, kind: 'image' });
    const assetPath = kind === 'spriteFrame' ? `${path}/spriteFrame` : path;
    found.set(`${kind}:${assetPath}`, { path: assetPath, kind });
  };
  const images = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && (Array.isArray(value.sizePx) || Array.isArray(value.sizeUnits))) add(value.path, 'spriteFrame');
    for (const child of Object.values(value)) images(child);
  };
  if (group === 'bgm') { add(config.main?.path, 'audio'); add(config.contents?.path, 'audio'); }
  else if (group === 'sfx') for (const entry of config.entries ?? []) add(entry.path, 'audio');
  else {
    // UI node hierarchies/animation curves carry no image definitions.
    if (group === 'weapons' && config.roots?.collection) {
      for (const path of weaponPanelImagePaths(config)) add(path, 'spriteFrame');
    } else images(config.roots ? config.images : config);
    const fonts = [...Object.values(config.bitmapFonts ?? {}), config.bitmapFont, config.input?.bitmapFont] as ({ pages: string[] } | undefined)[];
    for (const font of fonts) for (const page of font?.pages ?? []) add(page, 'spriteFrame');
    add(config.ground?.lighting?.effect, 'effect');
    if (config.customProjectiles && Object.keys(config.customProjectiles).length) add('art/rendering/custom-projectile', 'effect');
  }
  return Array.from(found.values());
}
