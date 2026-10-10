import type { DecimalAmount } from './DecimalAmount';

/** Simulation coordinates stay on the original Unity XZ ground plane. */
export interface Vec2 { x: number; z: number; }
export interface ScreenPoint { x: number; y: number; }
export interface AABB { minX: number; maxX: number; minZ: number; maxZ: number; }
export interface PlayerState {
  position: Vec2;
  velocity: Vec2;
  facing: -1 | 1;
  aim: Vec2;
  moving: boolean;
  targetId: number | null;
}
/** Called once per rendered Update after movement/aim, before an attack can fire. */
export interface MuzzleSampleContext {
  dt: number;
  player: Readonly<PlayerState>;
  targetPoint: Readonly<Vec2> | null;
  /** Attack flips the body after aiming, before it samples the firing point. */
  attackFacing?: -1 | 1;
}
/** Returns an XZ offset from the player after projecting the muzzle to bullet height. */
export type MuzzleProvider = (context: MuzzleSampleContext) => Vec2 | null;
/** A live damage target and its ground-plane hit shape; independent of its artwork. */
export interface Damageable {
  id: number;
  position: Vec2;
  health: number;
  maxHealth: number;
  alive: boolean;
  collider: AABB;
}
export interface TreeState extends Damageable {
  degree: 0 | 1;
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
export type CombatEvent =
  | { type: 'shot'; position: Vec2; bulletId: number; direction: Vec2 }
  | { type: 'hit'; position: Vec2; sourceTime: number; treeId: number; damage: DecimalAmount; health: number; maxHealth: number }
  | { type: 'impact'; position: Vec2 }
  | { type: 'treeDied'; position: Vec2; treeId: number; sourceTime: number }
  | { type: 'complete'; position: Vec2 };
export interface SweepHit { time: number; normal: Vec2; }
