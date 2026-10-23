import { DecimalAmount } from './DecimalAmount';
import { OriginalInfVal, subtractOriginalHealth } from './OriginalInfVal';
import type { AABB, Damageable, Vec2 } from './types';

/** One serialized Raid_Boss/Enemy collider is reused for every health layer. */
export const RAID_BOSS_ID = 2000000;
const healthCache: OriginalInfVal[] = [OriginalInfVal.fromInt(10000000)];
const growth = OriginalInfVal.fromDouble(3);

/** Raid_manager.EnsureHealthCache grows p3 values, then Boss_Reload supplies p2.
 * Keep the cache's third digit: rounding each displayed HP would change later layers. */
export function raidBossHealth(clearedLevels: number): OriginalInfVal {
  if (!Number.isSafeInteger(clearedLevels) || clearedLevels < 0) throw new Error('Invalid Raid layer');
  while (healthCache.length <= clearedLevels) healthCache.push(healthCache[healthCache.length - 1].mul(growth).toPrecision(3));
  return healthCache[clearedLevels].toPrecision(2);
}

export interface RaidBossSnapshot {
  bossIndex: number; clearedLevels: number; level: number;
  health: DecimalAmount; maxHealth: DecimalAmount; healthRatio: number;
}
export interface RaidBossHit {
  defeated: boolean; health: DecimalAmount; maxHealth: DecimalAmount;
}

/** Raid（突袭）boss enemy state, not the separate Boss gameplay module.
 * Live battle-only state shared by the session and CombatWorld. It has no
 * wallet, clock or save side effects. Enemy.Die -> Boss_Destroyed -> Spawn is
 * synchronous: the very next bullet can hit the next full layer in this frame. */
export class RaidBossCombat implements Damageable {
  readonly id = RAID_BOSS_ID;
  position: Vec2 = { x: -120, z: 20 };
  collider: AABB = { minX: -132, maxX: -108, minZ: 8, maxZ: 32 };
  /** level0:66820 radius12, local centerY12; EnemyColl Transform is at -7.45. */
  readonly sphereCollider = { radius: 12, centerY: 4.550000190734863, transformY: -7.449999809265137 };
  colliderMinY = this.sphereCollider.centerY - this.sphereCollider.radius;
  colliderMaxY = this.sphereCollider.centerY + this.sphereCollider.radius;
  readonly alive = true;
  private cleared = 0;
  private hp = raidBossHealth(0);
  private maximum = this.hp.amount;

  constructor(readonly bossIndex: number) {
    if (!Number.isInteger(bossIndex) || bossIndex < 0 || bossIndex > 4) throw new Error('Invalid Raid boss');
  }
  get clearedLevels(): number { return this.cleared; }
  get level(): number { return this.cleared + 1; }
  get health(): DecimalAmount { return this.hp.amount; }
  get healthPrecision(): number { return this.hp.precision; }
  get maxHealth(): DecimalAmount { return this.maximum; }
  get healthRatio(): number { return this.health.ratio(this.maximum); }
  snapshot(): RaidBossSnapshot {
    return { bossIndex: this.bossIndex, clearedLevels: this.cleared, level: this.level,
      health: this.health, maxHealth: this.maximum, healthRatio: this.healthRatio };
  }
  hit(damage: DecimalAmount, damagePrecision = OriginalInfVal.fromAmount(damage).precision): RaidBossHit {
    if (damage.isNegative) throw new Error('Raid damage cannot be negative');
    const remaining = subtractOriginalHealth(this.health, this.healthPrecision, damage, damagePrecision);
    const result = { defeated: remaining.health.isZero, health: remaining.health, maxHealth: this.maximum };
    if (result.defeated) {
      this.cleared++;
      this.hp = raidBossHealth(this.cleared);
      this.maximum = this.hp.amount;
    } else this.hp = OriginalInfVal.fromAmount(remaining.health, remaining.precision);
    return result;
  }
}
