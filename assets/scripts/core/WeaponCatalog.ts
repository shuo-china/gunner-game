import { WEAPON_DATA } from './WeaponData';
import { ECONOMY_CONFIG } from './EconomyConfig';

/** Collision mechanisms remain separate from the seven authored weapon families. */
export const WEAPON_TYPES = ['SINGLE', 'LASER', 'PIERCE', 'SHOTGUN', 'EXPLOSIVE', 'MISSILE', 'BLAST_SNIPER'] as const;
export type WeaponType = typeof WEAPON_TYPES[number];
export const WEAPON_CATEGORIES = ['bow', 'crossbow', 'glove', 'staff', 'fan', 'handgun', 'cannon'] as const;
export type WeaponCategory = typeof WEAPON_CATEGORIES[number];
export const WEAPON_CATEGORY_NAMES: Readonly<Record<WeaponCategory, string>> = Object.freeze({
  bow: '弓', crossbow: '弩', glove: '拳套', staff: '法杖', fan: '扇子', handgun: '火铳', cannon: '火炮',
});
/** Explicit mapping keeps Raid's historical mechanism order separate from catalog order. */
export const WEAPON_CATEGORY_BY_TYPE: Readonly<Record<WeaponType, WeaponCategory>> = Object.freeze({
  SINGLE: 'bow', SHOTGUN: 'crossbow', PIERCE: 'glove', EXPLOSIVE: 'staff',
  LASER: 'fan', BLAST_SNIPER: 'handgun', MISSILE: 'cannon',
});
export interface WeaponDefinition {
  readonly id: number;
  readonly name: string;
  readonly category: WeaponCategory;
  readonly grade: number;
  /** Original balance/visual reference; this is not a saved weapon identifier. */
  readonly sourceWeaponId: number;
  readonly type: WeaponType;
  readonly damage: string;
  readonly attackInterval: number;
  readonly pelletCount: number;
  readonly shotgunSpreadAngle: number;
  readonly explosionRadius: number;
  readonly missileExplosionRadius: number;
  readonly missileSpeed: number;
  readonly blastSniperExplosionRadius: number;
  readonly penetratingBulletLifetime: number;
}
export const WEAPON_GRADES = ['D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'X', 'XX', 'XXX', 'Z', 'ZZ', 'ZZZ'] as const;
export const WEAPON_CATALOG_VERSION = 4;
export const WEAPON_COUNT = 65;
const CATALOG: readonly WeaponDefinition[] = Object.freeze(WEAPON_DATA.map(weapon => Object.freeze({ ...weapon })));
const GRADE_IDS = Object.freeze(WEAPON_GRADES.map((_, grade) => Object.freeze(CATALOG.filter(w => w.grade === grade).map(w => w.id))));
export const AD_WEAPON_ID = ECONOMY_CONFIG.weapons.offer.weaponId;
export const DRAW_PRICE = ECONOMY_CONFIG.weapons.drawPrice;
export const DRAW_PROBABILITIES = Object.freeze(ECONOMY_CONFIG.weapons.drawGradePercents.map((percent, index) =>
  Object.freeze({ grade: WEAPON_GRADES[index], percent })));
export function isWeaponId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < WEAPON_COUNT;
}
export function getWeapon(id: number): WeaponDefinition {
  if (!isWeaponId(id) || !CATALOG[id] || CATALOG[id].id !== id) throw new Error(`Unknown weapon: ${id}`);
  return CATALOG[id];
}
export function getWeaponGrade(id: number): number {
  return getWeapon(id).grade;
}
export function getWeaponGradeName(id: number): typeof WEAPON_GRADES[number] { return WEAPON_GRADES[getWeaponGrade(id)]; }
export function getWeaponCatalog(): readonly WeaponDefinition[] { return CATALOG; }
export function getWeaponIdsForGrade(grade: number): readonly number[] {
  if (!Number.isInteger(grade) || !GRADE_IDS[grade]) throw new Error(`Unknown weapon grade: ${grade}`);
  return GRADE_IDS[grade];
}
