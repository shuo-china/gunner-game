import { DecimalAmount } from './DecimalAmount';
import { OriginalInfVal, subtractOriginalHealth } from './OriginalInfVal';
import { HUNT_RULES as H, huntHealth, validateHuntLevel } from './HuntBalance';
import { clamp, clamp01, distance, normalize, Random } from './math';
import { sweepSphereSphere } from './RaidCollision';
import type { AABB, CombatEvent, Damageable, Vec2 } from './types';

export const HUNT_CENTER: Readonly<Vec2> = Object.freeze({ x: -100, z: 0 });
export type HuntCombatEvent = Extract<CombatEvent, { type: 'huntMonsterDied' | 'huntLevelComplete' | 'huntFailed' }>;

/** Source pool slot: sprite scale changes for large monsters, its capsule never does. */
export class HuntMonster implements Damageable {
  readonly id: number;
  position: Vec2 = { ...HUNT_CENTER };
  velocity: Vec2 = { x: 0, z: 0 };
  inwardVelocity: Vec2 = { x: 0, z: 0 };
  health = DecimalAmount.from(0);
  maxHealth = DecimalAmount.from(0);
  healthPrecision = 1;
  alive = false;
  large = false;
  skinIndex = 0;
  spawnGeneration = 0;
  knockbackElapsed = 0;
  knockbackDuration = 0;
  knockbackVelocity: Vec2 = { x: 0, z: 0 };
  readonly capsuleCollider = Object.freeze({ radius: H.monsterRadius, height: H.monsterHeight, centerY: H.monsterCenterY, transformY: 0 });
  constructor(slot: number) { this.id = 4000000 + slot; }
  get collider(): AABB { return { minX: this.position.x - H.monsterRadius, maxX: this.position.x + H.monsterRadius,
    minZ: this.position.z - H.monsterRadius, maxZ: this.position.z + H.monsterRadius }; }
  get colliderMinY(): number { return H.monsterCenterY - H.monsterHeight / 2; }
  get colliderMaxY(): number { return H.monsterCenterY + H.monsterHeight / 2; }
  get visualScale(): number { return this.large ? H.largeVisualScale : 1; }
  get moving(): boolean { return this.alive && (this.velocity.x !== 0 || this.velocity.z !== 0); }
  get facing(): -1 | 1 { return this.inwardVelocity.x + this.inwardVelocity.z > 0 ? 1 : -1; }
}

/** Original Monster_manager combat only. The session owns rewards, progress and transition delays. */
export class HuntCombat {
  readonly enemies: HuntMonster[] = Array.from({ length: H.poolSize }, (_, slot) => new HuntMonster(slot));
  private currentWave: number;
  private currentLevel: number;
  private readonly random: Random;
  private aspect = 9 / 16;
  private available: HuntMonster[] = this.enemies.slice();
  private activeOrder: HuntMonster[] = [];
  private spawnRemaining = 0;
  private invasionPending = 0;
  private events: HuntCombatEvent[] = [];
  kills = 0;
  spawned = 0;
  barrierHp: number = H.barrierHp;
  completed = false;
  failed = false;
  running = false;

  constructor(wave = 0, level = 0, seed = 20261010, aspect = 9 / 16) {
    validateHuntLevel(wave, level);
    this.currentWave = wave; this.currentLevel = level; this.random = new Random(seed); this.setAspect(aspect);
  }
  get wave(): number { return this.currentWave; }
  get level(): number { return this.currentLevel; }
  get total(): number { return H.targetCounts[this.level]; }
  get targets(): readonly HuntMonster[] { return this.enemies; }
  get activeCount(): number { return this.enemies.reduce((count, enemy) => count + Number(enemy.alive), 0); }
  get largeProbability(): number { return this.level * H.largeProbabilityStep; }
  get spawnInterval(): number { return H.spawnIntervals[this.level]; }

  setAspect(aspect: number): void { if (Number.isFinite(aspect) && aspect > 0) this.aspect = aspect; }

  startLevel(wave = this.wave, level = this.level, aspect?: number): void {
    validateHuntLevel(wave, level);
    this.clear(); this.currentWave = wave; this.currentLevel = level;
    if (aspect !== undefined) this.setAspect(aspect);
    this.kills = this.spawned = this.invasionPending = 0;
    this.completed = this.failed = false; this.running = true;
    this.spawnOne();
  }

  /** Freeze includes an in-flight knockback coroutine, but leaves the monsters visible. */
  stopMotion(): void {
    this.running = false;
    for (const enemy of this.enemies) { enemy.velocity = { x: 0, z: 0 }; enemy.knockbackDuration = 0; }
  }
  clear(): void {
    this.stopMotion();
    for (const enemy of this.activeOrder.slice()) this.recycle(enemy);
    this.events.length = 0;
  }
  drainEvents(): HuntCombatEvent[] { const events = this.events; this.events = []; return events; }

  update(dt: number): void {
    if (!this.running || !Number.isFinite(dt) || dt <= 0) return;
    for (const enemy of this.enemies) {
      if (!enemy.alive || enemy.knockbackDuration <= 0) continue;
      enemy.knockbackElapsed += dt;
      const t = clamp01(enemy.knockbackElapsed / enemy.knockbackDuration);
      enemy.velocity = { x: enemy.knockbackVelocity.x + (enemy.inwardVelocity.x - enemy.knockbackVelocity.x) * t,
        z: enemy.knockbackVelocity.z + (enemy.inwardVelocity.z - enemy.knockbackVelocity.z) * t };
      if (t >= 1) enemy.knockbackDuration = 0;
    }
    this.spawnRemaining -= dt;
    // WaitForSeconds resumes once per Update; it does not catch up missed spawns.
    if (this.spawnRemaining > 1e-10) return;
    if (this.kills >= this.total) {
      this.completed = true; this.stopMotion();
      this.events.push({ type: 'huntLevelComplete', wave: this.wave, level: this.level, position: { ...HUNT_CENTER } });
    } else if (this.spawned < this.total || this.invasionPending > 0) this.spawnOne();
    else this.spawnRemaining = H.completionPollInterval;
  }

  fixedStep(dt: number): void {
    if (!this.running || !Number.isFinite(dt) || dt <= 0) return;
    const segmentMinimumY = H.monsterCenterY - (H.monsterHeight / 2 - H.monsterRadius);
    const segmentMaximumY = H.monsterCenterY + (H.monsterHeight / 2 - H.monsterRadius);
    const vertical = H.barrierCenterY - clamp(H.barrierCenterY, segmentMinimumY, segmentMaximumY);
    const invasionRadius = Math.sqrt((H.barrierRadius + H.monsterRadius) ** 2 - vertical ** 2);
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const next = { x: enemy.position.x + enemy.velocity.x * dt, z: enemy.position.z + enemy.velocity.z * dt };
      // Sweep prevents a long fixed step crossing the small barrier undetected.
      const collision = sweepSphereSphere({ ...enemy.position, y: 0 }, { ...next, y: 0 }, 0, { ...HUNT_CENTER, y: 0 }, invasionRadius);
      enemy.position = next;
      if (collision === null) continue;
      this.recycle(enemy); this.invasionPending++;
      this.barrierHp = Math.max(0, this.barrierHp - 1);
      if (this.barrierHp === 0) {
        this.failed = true; this.stopMotion();
        this.events.push({ type: 'huntFailed', wave: this.wave, level: this.level, position: { ...HUNT_CENTER } });
        return;
      }
    }
  }

  hit(id: number, damage: DecimalAmount, damagePrecision = OriginalInfVal.fromAmount(damage).precision):
    { damaged: boolean; defeated: boolean; health: DecimalAmount; maxHealth: DecimalAmount } {
    const enemy = this.enemies.find(candidate => candidate.id === id);
    if (!enemy) throw new Error('Unknown Hunt monster');
    if (!this.running || !enemy.alive || damage.compare(0) <= 0) return { damaged: false, defeated: false, health: enemy.health, maxHealth: enemy.maxHealth };
    const remaining = subtractOriginalHealth(enemy.health, enemy.healthPrecision, damage, damagePrecision);
    enemy.health = remaining.health; enemy.healthPrecision = remaining.precision;
    const defeated = enemy.health.isZero;
    if (defeated) {
      this.recycle(enemy); this.kills++;
      this.events.push({ type: 'huntMonsterDied', targetId: enemy.id, large: enemy.large, skinIndex: enemy.skinIndex,
        position: { ...enemy.position } });
    } else {
      const ratio = clamp01(damage.ratio(enemy.maxHealth)), outward = normalize({ x: enemy.position.x - HUNT_CENTER.x, z: enemy.position.z - HUNT_CENTER.z });
      enemy.knockbackElapsed = 0;
      enemy.knockbackDuration = H.knockbackMinimumDuration + H.knockbackDurationScale * ratio;
      enemy.knockbackVelocity = { x: outward.x * H.knockbackSpeed * ratio, z: outward.z * H.knockbackSpeed * ratio };
      enemy.velocity = { ...enemy.knockbackVelocity };
    }
    return { damaged: true, defeated, health: enemy.health, maxHealth: enemy.maxHealth };
  }

  private recycle(enemy: HuntMonster): void {
    if (!enemy.alive) return;
    enemy.alive = false; enemy.velocity = { x: 0, z: 0 }; enemy.knockbackDuration = 0;
    this.activeOrder.splice(this.activeOrder.indexOf(enemy), 1); this.available.push(enemy);
  }

  private spawnOne(): void {
    const enemy = this.available.shift();
    if (!enemy) return;
    const a = clamp(this.aspect * H.spawnRadius, H.spawnMinimumAxis, H.spawnRadius);
    const theta = this.random.range(0, 6.2831854820251465), cosine = Math.cos(theta), sine = Math.sin(theta);
    const radius = a * H.spawnRadius / Math.sqrt((H.spawnRadius * cosine) ** 2 + (a * sine) ** 2)
      + this.random.range(-H.spawnJitter, H.spawnJitter);
    const large = this.random.next() <= this.largeProbability;
    const k = .7071067690849304;
    enemy.position = { x: HUNT_CENTER.x + k * radius * (cosine - sine), z: HUNT_CENTER.z + k * radius * (cosine + sine) };
    enemy.large = large; enemy.skinIndex = (this.wave % H.skinCount) * 2 + Number(large); enemy.spawnGeneration++;
    const health = huntHealth(this.wave, large);
    enemy.health = enemy.maxHealth = health.amount; enemy.healthPrecision = health.precision;
    enemy.alive = true; enemy.knockbackElapsed = enemy.knockbackDuration = 0;
    const inward = normalize({ x: HUNT_CENTER.x - enemy.position.x, z: HUNT_CENTER.z - enemy.position.z });
    const speed = Math.max(distance(enemy.position, HUNT_CENTER) - H.speedReferenceRadius, H.minimumSpeedDistance)
      / (large ? H.largeTravelDivisor : H.normalTravelDivisor);
    enemy.inwardVelocity = { x: inward.x * speed, z: inward.z * speed }; enemy.velocity = { ...enemy.inwardVelocity };
    this.activeOrder.push(enemy);
    if (this.invasionPending > 0) this.invasionPending--;
    else this.spawned++;
    this.spawnRemaining = this.activeCount < H.sparseAliveThreshold ? H.sparseSpawnInterval : this.spawnInterval;
  }
}
