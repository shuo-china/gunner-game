import { DecimalAmount } from './DecimalAmount';
import { OriginalInfVal, subtractOriginalHealth } from './OriginalInfVal';
import { bossHealth, BOSS_RULES } from './BossBalance';
import { orientedBoxBounds } from './BossCollision';
import { clamp, distance, normalize, Random } from './math';
import type { AABB, Damageable, OrientedBoxCollider, Vec2 } from './types';

export const BOSS_ID = 3000000;
export interface BossSnapshot {
  stageIndex: number; level: number; skinIndex: number; health: DecimalAmount; maxHealth: DecimalAmount;
  healthRatio: number; alive: boolean; position: Vec2; facing: -1 | 1; moving: boolean;
}
export interface BossHit { defeated: boolean; health: DecimalAmount; maxHealth: DecimalAmount; }
/** Independent Boss: a single mortal Enemy, not Raid's replenishing HP layers. */
export class BossCombat implements Damageable {
  readonly id = BOSS_ID;
  position: Vec2 = { x: -115, z: 15 };
  velocity: Vec2 = { x: 0, z: 0 };
  /** Movement direction: -1 is the source art's unrotated, left-facing pose. */
  facing: -1 | 1 = -1;
  moving = false;
  alive = true;
  private hp: OriginalInfVal;
  readonly maxHealth: DecimalAmount;
  private readonly random: Random;
  private destination: Vec2 | null = null;
  private waitRemaining = 0;
  constructor(readonly stageIndex: number, seed = 1) {
    this.hp = bossHealth(stageIndex); this.maxHealth = this.hp.amount; this.random = new Random(seed);
  }
  get level(): number { return this.stageIndex + 1; }
  get skinIndex(): number { return this.stageIndex % BOSS_RULES.skinCount; }
  get health(): DecimalAmount { return this.hp.amount; }
  get healthPrecision(): number { return this.hp.precision; }
  get healthRatio(): number { return this.health.ratio(this.maxHealth); }
  /** level0:64999/39264: center=(0,.51,-.16), size=(1.73,1,1.15),
   * scale12, local=(-4.87,-.04,4.61), yaw=-45. Skin flips do not rotate this sibling. */
  get orientedBoxCollider(): OrientedBoxCollider {
    const yaw = -Math.PI / 4, offsetZ = -0.1599999964237213 * 12;
    const transform = { x: this.position.x - 4.869999885559082, z: this.position.z + 4.610000133514404 };
    return { center: { x: transform.x + Math.sin(yaw) * offsetZ, z: transform.z + Math.cos(yaw) * offsetZ },
      halfX: 1.7300000190734863 * 6, halfZ: 1.149999976158142 * 6, yaw,
      minY: -.03999999910593033 + (.5099999904632568 - .5) * 12,
      maxY: -.03999999910593033 + (.5099999904632568 + .5) * 12,
      transform, transformY: -.03999999910593033 };
  }
  get collider(): AABB { return orientedBoxBounds(this.orientedBoxCollider); }
  get colliderMinY(): number { return this.orientedBoxCollider.minY; }
  get colliderMaxY(): number { return this.orientedBoxCollider.maxY; }
  snapshot(): BossSnapshot { return { stageIndex: this.stageIndex, level: this.level, skinIndex: this.skinIndex,
    health: this.health, maxHealth: this.maxHealth, healthRatio: this.healthRatio, alive: this.alive,
    position: { ...this.position }, facing: this.facing, moving: this.moving }; }
  hit(damage: DecimalAmount, precision = OriginalInfVal.fromAmount(damage).precision): BossHit {
    if (damage.isNegative) throw new Error('Boss damage cannot be negative');
    if (!this.alive) return { defeated: false, health: this.health, maxHealth: this.maxHealth };
    const result = subtractOriginalHealth(this.health, this.healthPrecision, damage, precision);
    this.hp = OriginalInfVal.fromAmount(result.health, result.precision);
    if (this.health.isZero) { this.alive = false; this.stopMotion(); }
    return { defeated: !this.alive, health: this.health, maxHealth: this.maxHealth };
  }
  stopMotion(): void { this.velocity = { x: 0, z: 0 }; this.moving = false; }
  /** Rigidbody consumes the previous rendered Update's linear velocity. */
  fixedStep(dt: number): void {
    if (!this.alive) return;
    this.position.x += this.velocity.x * dt; this.position.z += this.velocity.z * dt;
  }
  update(dt: number, mainCat: Vec2): void {
    if (!this.alive || !Number.isFinite(dt) || dt <= 0) return;
    if (this.waitRemaining > 0) { this.waitRemaining -= dt; if (this.waitRemaining > 0) return; }
    if (!this.destination) this.destination = this.pickWanderPoint(mainCat);
    const delta = { x: this.destination.x - this.position.x, z: this.destination.z - this.position.z };
    if (distance(this.position, this.destination) <= BOSS_RULES.arrivalThreshold) {
      this.destination = null; this.stopMotion(); this.waitRemaining = this.random.range(BOSS_RULES.minWaitTime, BOSS_RULES.maxWaitTime); return;
    }
    const dir = normalize(delta);
    this.velocity = { x: dir.x * BOSS_RULES.moveSpeed, z: dir.z * BOSS_RULES.moveSpeed };
    if (delta.x !== 0) this.facing = delta.x > 0 ? 1 : -1;
    this.moving = true;
  }
  private randomPoint(): Vec2 {
    const angle = this.random.range(0, Math.PI * 2), radius = Math.sqrt(this.random.next()) * BOSS_RULES.mapRadius;
    return { x: -100 + Math.cos(angle) * radius, z: Math.sin(angle) * radius };
  }
  private pickWanderPoint(cat: Vec2): Vec2 {
    for (let i = 0; i < BOSS_RULES.maxPointRetries; i++) {
      const point = this.randomPoint();
      if (!bossPathCrossesCat(this.position, point, cat, BOSS_RULES.catAvoidRadius)) return point;
    }
    return this.randomPoint();
  }
}
/** Boss.PathCrossesCat uses the nearest point on the complete path segment. */
export function bossPathCrossesCat(origin: Vec2, target: Vec2, cat: Vec2, radius: number): boolean {
  if (cat.x * cat.x + cat.z * cat.z < 9.999999439624929e-11) return false;
  const dx = target.x - origin.x, dz = target.z - origin.z, d = Math.hypot(dx, dz);
  if (d < .0010000000474974513) return false;
  const t = clamp(((cat.x - origin.x) * dx + (cat.z - origin.z) * dz) / (d * d), 0, 1);
  return Math.hypot(origin.x + dx * t - cat.x, origin.z + dz * t - cat.z) < radius;
}
