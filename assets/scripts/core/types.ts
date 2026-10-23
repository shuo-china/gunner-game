import type { DecimalAmount } from './DecimalAmount';
import type { OriginalInfVal } from './OriginalInfVal';
import type { WeaponDefinition, WeaponType } from './WeaponCatalog';

/** Simulation coordinates stay on the original Unity XZ ground plane. */
export interface Vec2 { x: number; z: number; }
export interface ScreenPoint { x: number; y: number; }
export interface AABB { minX: number; maxX: number; minZ: number; maxZ: number; }
export interface OrientedBoxCollider {
  center: Vec2; halfX: number; halfZ: number; yaw: number; minY: number; maxY: number;
  transform: Vec2; transformY: number;
}
export interface CollisionWall extends AABB { minY: number; maxY: number; }
export interface PlayerState {
  actorId: number;
  weaponId: number;
  starLevel: number;
  position: Vec2;
  velocity: Vec2;
  facing: -1 | 1;
  aim: Vec2;
  moving: boolean;
  targetId: number | null;
}
/** Called once per rendered Update after movement/aim, before an attack can fire. */
export interface MuzzleSampleContext {
  actorId: number;
  weaponId: number;
  dt: number;
  player: Readonly<PlayerState>;
  /** Missile arms aim at the collider transform; other guns use nearHitPoint. */
  targetPoint: Readonly<Vec2> | null;
  /** Main cat's raw joystick direction rotated into XZ; independent of attack aim. */
  manualLookDirection?: Readonly<Vec2>;
  /** Attack flips the body after aiming, before it samples the firing point. */
  attackFacing?: -1 | 1;
  attackInterval: number;
  /** Current cooldown divided by attackInterval, clamped to [0,1]. */
  attackProgress: number;
  /** Release pose must be applied before this frame's projectile origin is read. */
  willFire: boolean;
}
/** Returns an XZ offset from the player after projecting the muzzle to bullet height. */
export type MuzzleProvider = (context: MuzzleSampleContext) => Vec2 | null;
/** A live damage target and its ground-plane hit shape; independent of its artwork. */
export interface Damageable {
  /** Stable collider/pool identity, including when a stage reactivates its slot. */
  id: number;
  position: Vec2;
  health: DecimalAmount;
  /** Challenge Enemy.InfVal precision; absent keeps legacy Main subtraction. */
  healthPrecision?: number;
  maxHealth: DecimalAmount;
  alive: boolean;
  collider: AABB;
  colliderMinY?: number;
  colliderMaxY?: number;
  /** Raid's source SphereCollider. XZ center comes from collider bounds;
   * transformY is distinct from its serialized local center for targeting. */
  sphereCollider?: { radius: number; centerY: number; transformY: number };
  /** Hunt's vertical capsule remains unscaled when its sprite grows. */
  capsuleCollider?: { radius: number; height: number; centerY: number; transformY: number };
  orientedBoxCollider?: OrientedBoxCollider;
}
export interface TreeState extends Damageable {
  degree: 0 | 1 | 2 | 3;
  stageIndex: number;
  /** Authored Main Tree_Grid transform Z; absent for Boss_tree and arenas. */
  gridOriginZ?: number;
  /** Base reward for this tree; the session applies the current gold upgrade. */
  reward: DecimalAmount;
  /** Tree_Batch InfVal precision, retained separately from normalized reward. */
  rewardPrecision?: number;
}
/** Mine_manager's pooled Ore identity; diamonds are settled by the session. */
export interface OreState extends Damageable {
  readonly kind: 'ore';
  readonly poolIndex: number;
  readonly rare: boolean;
  readonly score: number;
}
export interface BulletState {
  id: number;
  active: boolean;
  damaging: boolean;
  position: Vec2;
  previousPosition: Vec2;
  direction: Vec2;
  age: number;
  life: number;
  trailTime: number;
  traveled: number;
  /** Original Bullet.SetupLinear snapshots damage, so upgrades only affect new shots. */
  damage: DecimalAmount;
  damagePrecision?: number;
  actorId: number;
  weaponId: number;
  weaponType: WeaponType;
  critical: boolean;
  volleyId: number;
  pelletIndex: number;
  /** World height; missiles follow the original distance-scaled parabolic arc. */
  height: number;
  speed: number;
  explosionRadius: number;
  hitIds: number[];
  pierceCount: number;
  hasExploded: boolean;
  /** Bullet's first-enemy FX flag is separate from its hit/damage ledger. */
  hasEnemyImpactFx: boolean;
  missileStart: Vec2 | null;
  missileTarget: Vec2 | null;
  /** Snapshot of Collider.transform.y; absent synthetic emitters use ground height. */
  missileTargetHeight?: number;
  missileDuration: number;
  missileArcHeight: number;
}
/** Session supplies compressed actor identities and stars resolved for the mode.
 * Raid keeps the physical preparation-slot star even when its actor index shifts. */
export interface ActorLoadout {
  actorIndex: number;
  weapon: WeaponDefinition;
  damage: DecimalAmount;
  damagePrecision?: number;
  attackInterval: number;
  criticalChance?: number;
  criticalMultiplier?: number;
  /** Applied after the fish critical percent, before the original integer cut. */
  criticalRelicPercent?: OriginalInfVal;
  starLevel?: number;
}
export interface CombatModifiers { damage: DecimalAmount; attackInterval: number }
export interface CombatStats {
  shots: number;
  hits: number;
  kills: number;
  totalTrees: number;
  elapsed: number;
  complete: boolean;
}
export interface WeaponEventMetadata {
  actorId: number;
  weaponId: number;
  weaponType: WeaponType;
  critical: boolean;
}
export type CombatEvent =
  | ({ type: 'shot'; position: Vec2; bulletId: number; direction: Vec2; volleyId: number; pelletIndex: number } & WeaponEventMetadata)
  | ({ type: 'hit'; position: Vec2; height?: number; sourceTime: number; treeId: number; damage: DecimalAmount; health: DecimalAmount; maxHealth: DecimalAmount } & WeaponEventMetadata)
  | ({ type: 'damageText'; position: Vec2; height?: number; sourceTime: number; damage: DecimalAmount } & WeaponEventMetadata)
  | ({ type: 'impact'; position: Vec2; radius: number; height: number; sourceTime: number } & WeaponEventMetadata)
  | { type: 'treeDied'; position: Vec2; treeId: number; sourceTime: number }
  | { type: 'oreDied'; position: Vec2; oreId: number; score: number; sourceTime: number }
  | { type: 'bossDied'; position: Vec2; treeId: number; sourceTime: number }
  | { type: 'huntMonsterDied'; position: Vec2; targetId: number; large: boolean; skinIndex: number }
  | { type: 'huntLevelComplete'; position: Vec2; wave: number; level: number }
  | { type: 'huntFailed'; position: Vec2; wave: number; level: number }
  | { type: 'complete'; position: Vec2 };
export interface SweepHit { time: number; normal: Vec2; }
