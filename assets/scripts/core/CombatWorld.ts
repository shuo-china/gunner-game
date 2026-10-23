import { PetFollowers } from './PetFollowers';
import { COMBAT_CONFIG as C } from './config';
import { createStageDefinition, StageDefinition } from './map';
import { clamp, clamp01, closestPoint, circleOverlapsBox, distance, length, normalize, Random, rayAABB, sweepCircleAABB } from './math';
import { CAMERA_BASIS, screenSpeedMultiplier } from './projection';
import { clampMovementInput, manualLookDirection, manualVelocity, MANUAL_INPUT_SQUARED_THRESHOLD } from './ManualMovement';
import type { OreState, ScreenPoint } from './types';
import { DecimalAmount } from './DecimalAmount';
import { OriginalInfVal, subtractOriginalHealth } from './OriginalInfVal';
import { ActorLoadout, BulletState, CollisionWall, CombatEvent, CombatModifiers, CombatStats, Damageable, MuzzleProvider, PlayerState, TreeState, Vec2, WeaponEventMetadata } from './types';
import { getWeapon, isWeaponId } from './WeaponCatalog';
import { FollowerAI, LeaderSample } from './FollowerAI';
import { sweepSphereBox } from './WeaponBallistics';
import { closestPointOnSphere, sphereCenter, sweepSphereSphere } from './RaidCollision';
import { closestPointOnOrientedBox, insideOrientedBox, separateCircleOrientedBox, sweepBoxOrientedBox,
  sweepCircleOrientedBox, sweepSphereOrientedBox } from './BossCollision';
import { HUNT_RULES } from './HuntBalance';
import { HUNT_CENTER } from './HuntCombat';
import { closestPointOnHuntCapsule, insideHuntCapsule, sweepSphereHuntCapsule } from './HuntCollision';
import { CombatSpatialIndex } from './CombatSpatialIndex';

const copy = (p: Vec2): Vec2 => ({ x: p.x, z: p.z });
const ATTACK_RAYS: readonly Vec2[] = Array.from({ length: C.rayCount }, (_, ray) => {
  const angle = ray * Math.PI * 2 / C.rayCount;
  return { x: Math.sin(angle), z: Math.cos(angle) };
});
const HUNT_ATTACK_RAYS: readonly Vec2[] = Array.from({ length: HUNT_RULES.rayCount }, (_, ray) => {
  const angle = ray * Math.PI * 2 / HUNT_RULES.rayCount;
  return { x: Math.sin(angle), z: Math.cos(angle) };
});
const BASE_DAMAGE = DecimalAmount.from(C.damage);
const DEFAULT_WEAPON = getWeapon(0);
function maximumSpread(interval: number): number {
  const blend = 1 - clamp01((Math.log(Math.max(0.05, interval)) + Math.log(20)) / Math.log(40));
  return C.spreadMinimum + (C.spreadMaximum - C.spreadMinimum) * blend;
}
export interface CombatResetOptions {
  preserveActorState?: boolean;
  rebirth?: boolean;
  /** Scene changes Warp cats but leave Polling_manager bullets and clocks alive. */
  preserveProjectiles?: boolean;
}

/** Seeded simulation with frame-driven Cat.Update and the source fixed physics step. */
export class CombatWorld {
  readonly player: PlayerState = {
    actorId: 0, weaponId: 0, starLevel: 0,
    position: { x: 0, z: 0 }, velocity: { x: 0, z: 0 }, facing: 1,
    aim: { x: 0, z: 1 }, moving: false, targetId: null,
  };
  readonly players: PlayerState[] = [this.player];
  readonly trees: TreeState[] = [];
  readonly bullets: BulletState[] = [];
  stage!: StageDefinition;
  readonly petFollowers = new PetFollowers();
  private petSpeedPercent = 100;
  private movementMultiplier = 1;
  private movementInput: ScreenPoint = { x: 0, y: 0 };
  private autoSmoothVelocity: Vec2 = { x: 0, z: 0 };
  private manualVelocityActive = false;
  readonly stats: CombatStats = { shots: 0, hits: 0, kills: 0, totalTrees: C.treeCount, elapsed: 0, complete: false };
  private events: CombatEvent[] = [];
  private random = new Random(1);
  private seed = 1;
  private physicsAccumulator = 0;
  private frameTime = 0;
  private physicsTime = 0;
  private inFixedPhysics = false;
  private bulletPoolCursor = 0;
  private readonly bulletTimeouts = new Map<number, number>();
  private attackSearchTimer = 0;
  private autoSearchTimer = 0;
  private attackClock = 0;
  private autoTargetId: number | null = null;
  private lockedAttackTargetId: number | null = null;
  private nearHitPoint: Vec2 = { x: 0, z: 0 };
  private spread = 0;
  private previouslyHadTarget = false;
  private paused = false;
  private combatStopped = false;
  private rebirthStopped = false;
  private battlefieldActive = true;
  private aspect: number = C.defaultAspect;
  private muzzleOffset: Vec2 | null = null;
  private muzzleProvider: MuzzleProvider | null = null;
  private damage = BASE_DAMAGE;
  private attackInterval: number = C.attackInterval;
  private maximumSpread = maximumSpread(C.attackInterval);
  private loadout: ActorLoadout[] = [{ actorIndex: 0, weapon: DEFAULT_WEAPON, damage: BASE_DAMAGE, attackInterval: C.attackInterval }];
  private followers: FollowerAI[] = [];
  private followerCache = new Map<number, FollowerAI>();
  private leaderHistory: LeaderSample[] = [];
  private breadcrumbs: Vec2[] = [];
  private volleyCounter = 0;
  private huntOffscreenTargets = new Map<number, { id: number; point: Vec2 }>();
  private readonly targetIndex = new CombatSpatialIndex();
  // Explosions can be nested inside projectile contacts; never share their output.
  private readonly bulletCandidates: Damageable[] = [];
  private readonly missileCandidates: Damageable[] = [];
  private readonly explosionCandidates: Damageable[] = [];
  private readonly rayCandidates: Damageable[] = [];

  constructor(seed = 1, stage?: StageDefinition) { this.reset(seed, stage); }

  get isPaused(): boolean { return this.paused; }
  get cameraAnchor(): Vec2 { return this.player.position; }
  /** Scaled frame clock also advances after the stage counter stops. */
  get simulationTime(): number { return this.frameTime; }
  get bulletWalls(): readonly CollisionWall[] { return this.battlefieldActive ? this.stage.bulletWalls : []; }
  get isBattlefieldActive(): boolean { return this.battlefieldActive; }
  get hunt() { return this.stage.hunt; }
  private get attackRange(): number { return this.hunt ? HUNT_RULES.attackRange : C.attackRange; }
  /** Raid shares aiming and ballistics without entering tree rewards/completion. */
  get damageTargets(): readonly Damageable[] { return this.stage.ores ?? (this.hunt ? this.hunt.enemies : this.stage.boss ? [this.stage.boss] : this.stage.raidBoss ? [this.stage.raidBoss] : this.trees); }

  private prepareTargetIndex(): CombatSpatialIndex | null {
    // These pools move/respawn during physics and damage callbacks. Their small
    // or dynamic sets keep the original scan, always reading current colliders.
    if (this.hunt || this.stage.boss || this.stage.raidBoss) return null;
    const targets = this.damageTargets;
    if (targets.length < 24) return null;
    this.targetIndex.synchronize(targets);
    return this.targetIndex;
  }

  /** Map_obj.SetActive(false) removes colliders without touching global pools. */
  setBattlefieldActive(active: boolean): void {
    this.battlefieldActive = active;
    if (!active) this.stopCombat();
  }

  /** Finish the loading coroutine without another Warp/reset or pool clear. */
  startCombat(): void {
    if (!this.battlefieldActive) return;
    this.combatStopped = false;
    this.rebirthStopped = false;
  }

  setPetSpeedPercent(percent: number): void {
    if (!Number.isFinite(percent) || percent < 100 || percent > 376) throw new Error('Invalid pet speed');
    this.petSpeedPercent = percent;
  }
  private get effectiveMovementMultiplier(): number { return this.movementMultiplier * this.petSpeedPercent / 100; }

  setMovementMultiplier(multiplier: 1 | 2): void { this.movementMultiplier = multiplier; }

  /** Screen-space analog input; never persisted or treated as an attack target. */
  setMovementInput(input: Readonly<ScreenPoint>): void {
    this.movementInput = clampMovementInput(input);
  }

  clearMovementInput(): void {
    this.movementInput = { x: 0, y: 0 };
    // Cancelled touches cannot leave a stale manual velocity in the next physics step.
    if (this.manualVelocityActive) {
      this.player.velocity = { x: 0, z: 0 }; this.player.moving = false;
      this.manualVelocityActive = false;
    }
  }

  get currentMovementInput(): Readonly<ScreenPoint> { return { ...this.movementInput }; }

  /** Stop attack/motion on timeout while allowing existing visual effects to finish. */
  stopCombat(): void {
    this.combatStopped = true;
    this.stage.boss?.stopMotion();
    this.hunt?.stopMotion();
    for (const actor of this.players) {
      actor.velocity = { x: 0, z: 0 }; actor.moving = false; actor.targetId = null;
    }
    this.autoTargetId = this.lockedAttackTargetId = null;
    this.autoSmoothVelocity = { x: 0, z: 0 };
  }

  /** Rebirth sets source is_Play=false while Animator, recoil and projectiles
   * continue. Keep accumulated cooldowns and target-transition memory. */
  beginRebirth(): void {
    this.combatStopped = true;
    this.rebirthStopped = true;
    for (const actor of this.players) actor.targetId = null;
    // The leader's HandleMovement stops without joystick input; AI cats use
    // SmoothStop on their following Updates and retain their residual motion.
    this.player.velocity = { x: 0, z: 0 }; this.player.moving = false;
    this.autoTargetId = this.lockedAttackTargetId = null;
    this.sampleStoppedPoses(0);
  }

  advanceEffects(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0 || this.paused) return;
    // is_Play gates Enemy.Damage, not Bullet.Update or its Rigidbody/trigger.
    // Keep the old volley travelling and colliding until its normal timeout.
    this.combatStopped = true;
    dt = Math.min(dt, C.maxFrameTime);
    this.frameTime += dt;
    this.physicsAccumulator += dt;
    while (this.physicsAccumulator + 1e-10 >= C.physicsStep) {
      this.physicsAccumulator -= C.physicsStep;
      this.physicsTime = this.frameTime - this.physicsAccumulator;
      if (this.battlefieldActive) this.moveAndSlide({ x: this.player.velocity.x * C.physicsStep, z: this.player.velocity.z * C.physicsStep });
      if (this.rebirthStopped) for (const follower of this.followers) {
        const p = follower.player;
        this.moveAndSlide({ x: p.velocity.x * C.physicsStep, z: p.velocity.z * C.physicsStep }, p);
      }
      this.petFollowers.fixedStep(C.physicsStep, this.players.map(p => p.position));
      this.updateBullets(C.physicsStep);
    }
    this.updateMissiles(dt);
    this.updateBulletTimeouts();
    this.recordLeaderHistory();
    this.player.targetId = null;
    this.clearAutoMovement();
    this.moveManually();
    // Source Cat.Update still relaxes its hands/face while is_Play=false;
    // Animator and recoil evaluation then continue in the presentation update.
    if (this.rebirthStopped) {
      const factor = clamp01(dt * C.velocitySmoothing);
      for (const follower of this.followers) {
        const p = follower.player;
        p.velocity.x += -p.velocity.x * factor;
        p.velocity.z += -p.velocity.z * factor;
        p.moving = p.velocity.x * p.velocity.x + p.velocity.z * p.velocity.z >= C.autoStopSquaredSpeed;
        if (!p.moving) p.velocity = { x: 0, z: 0 };
      }
    }
    this.sampleStoppedPoses(dt);
  }

  /** LevelClear keeps the source is_Play flag true throughout its two-second
   * banner. The empty monster pool stops producing enemies, while cats return
   * to the center and retain their Update clocks and global projectiles. */
  advanceHuntIntermission(dt: number): void {
    if (!this.hunt?.completed || this.hunt.failed || !this.battlefieldActive || this.paused || !Number.isFinite(dt) || dt <= 0) return;
    this.combatStopped = false;
    this.updateFrame(Math.min(dt, C.maxFrameTime));
  }

  /** Equipped slots are compressed by the session before this call. Rebalancing
   * keeps each actor's position/cooldown and every already spawned projectile. */
  setLoadout(entries: readonly ActorLoadout[]): void {
    if (entries.length < 1 || entries.length > 3) throw new Error('Loadout must contain one to three actors');
    for (let index = 0; index < entries.length; index++) {
      const e = entries[index];
      if (e.actorIndex !== index || e.damage.compare(0) <= 0 || !Number.isFinite(e.attackInterval) || e.attackInterval <= 0 ||
          !isWeaponId(e.weapon.id) ||
          !['SINGLE', 'LASER', 'PIERCE', 'SHOTGUN', 'EXPLOSIVE', 'MISSILE', 'BLAST_SNIPER'].includes(e.weapon.type) ||
          !Number.isInteger(e.weapon.pelletCount) || e.weapon.pelletCount < 0 ||
          [e.weapon.shotgunSpreadAngle, e.weapon.explosionRadius, e.weapon.missileExplosionRadius, e.weapon.blastSniperExplosionRadius]
            .some(value => !Number.isFinite(value) || value < 0) ||
          !Number.isFinite(e.weapon.missileSpeed) || e.weapon.missileSpeed <= 0 ||
          !Number.isFinite(e.weapon.penetratingBulletLifetime) || e.weapon.penetratingBulletLifetime <= 0 ||
          (e.starLevel !== undefined && (!Number.isInteger(e.starLevel) || e.starLevel < 0)) ||
          (e.damagePrecision !== undefined && (!Number.isSafeInteger(e.damagePrecision) || e.damagePrecision < 1 || e.damagePrecision > 100000)) ||
          (e.criticalChance !== undefined && (!Number.isFinite(e.criticalChance) || e.criticalChance < 0 || e.criticalChance > 1)) ||
          (e.criticalMultiplier !== undefined && (!Number.isFinite(e.criticalMultiplier) || e.criticalMultiplier <= 0))) {
        throw new Error('Invalid actor loadout');
      }
    }
    this.loadout = entries.map(e => ({ ...e, weapon: { ...e.weapon }, attackInterval: clamp(e.attackInterval, 0.05, 2),
      criticalRelicPercent: e.criticalRelicPercent ? OriginalInfVal.fromSerialized(e.criticalRelicPercent.toJSON()) : undefined }));
    const main = this.loadout[0];
    this.player.weaponId = main.weapon.id;
    this.player.starLevel = main.starLevel ?? 0;
    this.damage = main.damage;
    this.attackInterval = main.attackInterval;
    this.maximumSpread = maximumSpread(this.attackInterval);
    this.spread = 0;
    this.followers = this.loadout.slice(1).map(entry => {
      const wasActive = this.followers.some(f => f.player.actorId === entry.actorIndex);
      const follower = this.followerCache.get(entry.actorIndex) ?? new FollowerAI(entry, this.player, this.seed);
      this.followerCache.set(entry.actorIndex, follower);
      follower.loadout = entry;
      follower.player.weaponId = entry.weapon.id;
      follower.player.starLevel = entry.starLevel ?? 0;
      follower.spread = 0;
      if (!wasActive) {
        // SetActive on an existing serialized cat does not rerun Start. Warp
        // resets movement but retains its attack clock and target-search timer.
        follower.player.position = { x: this.player.position.x + follower.formationOffset.x, z: this.player.position.z + follower.formationOffset.z };
        follower.player.velocity = { x: 0, z: 0 };
        follower.player.facing = 1;
        follower.player.moving = false;
      }
      return follower;
    });
    this.players.splice(0, this.players.length, this.player, ...this.followers.map(f => f.player));
  }

  /** Cat.Balance_Reload updates AtkCool_Max without resetting AtkCool_Now.
   * Keep this state across round resets, just like the session upgrades. */
  setCombatModifiers(modifiers: CombatModifiers): void {
    if (modifiers.damage.compare(0) <= 0 || !Number.isFinite(modifiers.attackInterval) || modifiers.attackInterval <= 0) {
      throw new Error('Invalid combat modifiers');
    }
    this.damage = modifiers.damage;
    this.attackInterval = clamp(modifiers.attackInterval, 0.05, 2);
    this.maximumSpread = maximumSpread(this.attackInterval);
    this.loadout[0] = { ...this.loadout[0], damage: this.damage, attackInterval: this.attackInterval };
    // Balance_Reload resets _spreadAngle for every upgrade, including money.
    this.spread = 0;
  }

  /** Width / height of the actual gameplay viewport, after safe-area fitting. */
  setViewport(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) { this.aspect = aspect; this.hunt?.setAspect(aspect); }
  }

  /** Physical firing offset in world XZ, after the original CamDir projection to bullet height. */
  setMuzzleOffset(offset: Vec2): void {
    if (Number.isFinite(offset.x) && Number.isFinite(offset.z)) this.muzzleOffset = copy(offset);
  }

  /** Pose adapter runs once per Update, after this frame's movement and aim.
   * It persists across reset; only the sampled offset is reset. Without an
   * adapter, setMuzzleOffset remains available for headless simulations.
   */
  setMuzzleProvider(provider: MuzzleProvider | null): void { this.muzzleProvider = provider; }

  /** A source Game_Start warps existing cats; Start's randomized AI/cooldowns run
   * only once. Diagnostic full resets can still request a deterministic fresh world. */
  reset(seed = this.seed, stage = createStageDefinition(0, 0, seed), options: boolean | CombatResetOptions = false): void {
    this.clearMovementInput();
    this.autoSmoothVelocity = { x: 0, z: 0 };
    const preserveActorState = typeof options === 'boolean' ? options : options.preserveActorState === true || options.rebirth === true;
    const rebirth = typeof options === 'object' && options.rebirth === true;
    const preserveProjectiles = rebirth || typeof options === 'object' && options.preserveProjectiles === true;
    this.combatStopped = false;
    this.rebirthStopped = false;
    this.seed = seed >>> 0;
    this.battlefieldActive = true;
    this.random = new Random(this.seed ^ 0x9e3779b9);
    this.stage = stage;
    this.targetIndex.clear();
    this.bulletCandidates.length = this.missileCandidates.length = this.explosionCandidates.length = this.rayCandidates.length = 0;
    this.huntOffscreenTargets.clear();
    this.trees.splice(0, this.trees.length, ...stage.trees);
    this.player.position = copy(stage.spawnPosition ?? { x: 0, z: 0 });
    this.petFollowers.warp(this.player.position);
    this.player.velocity = { x: 0, z: 0 };
    this.player.facing = 1;
    this.player.aim = { x: 0, z: 1 };
    this.player.moving = false;
    this.player.targetId = null;
    if (!this.bullets.length) {
      for (let id = 0; id < C.bulletPoolSize; id++) this.bullets.push({
        id, active: false, damaging: false, position: { x: 0, z: 0 }, previousPosition: { x: 0, z: 0 },
        direction: { x: 0, z: 0 }, age: 0, life: C.bulletLifetime, trailTime: 0, traveled: 0, damage: BASE_DAMAGE,
        actorId: 0, weaponId: 0, weaponType: 'SINGLE', critical: false, volleyId: 0, pelletIndex: 0,
        height: C.bulletHeight, speed: C.bulletSpeed, explosionRadius: 0, hitIds: [], pierceCount: 0,
        hasExploded: false, hasEnemyImpactFx: false, missileStart: null, missileTarget: null, missileDuration: 0, missileArcHeight: 0,
      });
    }
    // Rebirth_Reset only rebuilds Tree_manager/Map_obj. Original bullets live
    // under the independent Polling_manager root, so their stored damage,
    // collision history and remaining Invoke timeout survive the warp. This is
    // visible when an old loading coroutine fires new shots during the FX.
    if (!preserveProjectiles) for (const bullet of this.bullets) this.clearBullet(bullet);
    Object.assign(this.stats, { shots: 0, hits: 0, kills: 0, totalTrees: stage.ores?.length ?? this.trees.length, elapsed: 0, complete: false });
    if (!preserveActorState) this.attackSearchTimer = this.autoSearchTimer = this.attackClock = 0;
    // Cat's rebirth warp resets the leader's nearest-tree search only. Its
    // Attack timer and follower Start-generated AI values remain intact.
    if (rebirth) this.autoSearchTimer = 0;
    this.spread = 0;
    this.autoTargetId = null;
    this.lockedAttackTargetId = null;
    this.nearHitPoint = { x: 0, z: 0 };
    if (!preserveProjectiles) {
      this.physicsAccumulator = 0;
      this.frameTime = 0;
      this.physicsTime = 0;
      this.bulletPoolCursor = 0;
      this.bulletTimeouts.clear();
    }
    if (!preserveProjectiles) this.previouslyHadTarget = false;
    this.muzzleOffset = null;
    this.events.length = 0;
    this.paused = false;
    if (!preserveProjectiles) this.volleyCounter = 0;
    if (!preserveProjectiles || rebirth) this.leaderHistory = [];
    this.breadcrumbs = [copy(this.player.position)];
    this.followers = [];
    if (!preserveActorState) this.followerCache.clear();
    else for (const follower of this.followerCache.values()) {
      follower.player.targetId = null;
      follower.nearHitPoint = { x: 0, z: 0 };
      if (!preserveProjectiles) follower.previouslyHadTarget = false;
      follower.muzzleOffset = null;
      follower.player.position = { x: this.player.position.x + follower.formationOffset.x, z: this.player.position.z + follower.formationOffset.z };
      follower.player.velocity = { x: 0, z: 0 }; follower.player.moving = false;
    }
    this.setLoadout(this.loadout);
    if (preserveProjectiles && !rebirth) {
      // Cat_manager.Warp uses its separate constructor warpOffsets, not the
      // AI's close-follow formation offsets. It also warps disabled pool cats.
      for (const follower of this.followerCache.values()) {
        follower.player.position = { x: this.player.position.x + (follower.player.actorId === 1 ? -6 : 6),
          z: this.player.position.z - 6 };
        follower.player.facing = 1;
      }
    }
  }

  pause(): void { this.clearMovementInput(); this.paused = true; this.physicsAccumulator = 0; }
  resume(): void { this.paused = false; this.physicsAccumulator = 0; }

  drainEvents(): CombatEvent[] {
    this.collectHuntEvents();
    const result = this.events;
    this.events = [];
    return result;
  }

  /** One call per rendered frame, using Unity's maximum delta. Pause excludes background time. */
  step(dt: number): void {
    if (this.paused || !Number.isFinite(dt) || dt <= 0) return;
    if (this.combatStopped) { this.advanceEffects(dt); return; }
    this.updateFrame(Math.min(dt, C.maxFrameTime));
  }

  private updateFrame(dt: number): void {
    this.frameTime += dt;
    if (!this.stats.complete) this.stats.elapsed += dt;
    // Unity consumes the previous Update's velocity in FixedUpdate/physics,
    // then Cat.Update resolves targets and writes velocity for the next step.
    this.physicsAccumulator += dt;
    while (this.physicsAccumulator + 1e-10 >= C.physicsStep) {
      this.physicsAccumulator -= C.physicsStep;
      this.physicsTime = this.frameTime - this.physicsAccumulator;
      this.stage.boss?.fixedStep(C.physicsStep);
      this.hunt?.fixedStep(C.physicsStep);
      this.collectHuntEvents();
      this.moveAndSlide({ x: this.player.velocity.x * C.physicsStep, z: this.player.velocity.z * C.physicsStep });
      for (const follower of this.followers) {
        const p = follower.player;
        this.moveAndSlide({ x: p.velocity.x * C.physicsStep, z: p.velocity.z * C.physicsStep }, p);
      }
      this.petFollowers.fixedStep(C.physicsStep, this.players.map(p => p.position));
      this.updateBullets(C.physicsStep);
    }
    this.updateMissiles(dt);
    this.updateBulletTimeouts();
    this.recordLeaderHistory();
    if (this.combatStopped) { this.sampleStoppedPoses(dt); return; }
    if (!this.stats.complete) {
      this.attackSearchTimer += dt;
      if (this.attackSearchTimer + 1e-10 >= C.attackSearchInterval) {
        this.attackSearchTimer = 0;
        this.player.targetId = this.findRayTarget(this.player, this.hunt ? this.nearHitPoint : undefined)?.id ?? null;
      }
      const input = this.movementInput;
      const manualMovement = input.x * input.x + input.y * input.y >= MANUAL_INPUT_SQUARED_THRESHOLD;
      // Main/SpeedRun choose once before resolving aim, so movement and fire
      // adopt a replacement on the same frame. Other modes keep source order.
      const selectBeforeAttack = this.usesPersistentCombatTarget && !manualMovement;
      if (selectBeforeAttack) this.updateAutoTarget(dt);
      this.resolveAttackTarget();
      // Cat.UpdateSpreadState resets both spread and the attack clock only on
      // the no-target -> target transition, not when switching between targets.
      const hasTarget = this.player.targetId !== null;
      if (hasTarget && !this.previouslyHadTarget) this.spread = this.attackClock = 0;
      if (!hasTarget) this.spread = Math.max(0, this.spread - Math.max(1, this.maximumSpread) * C.spreadDecayMultiplier * dt);
      this.previouslyHadTarget = hasTarget;
      if (manualMovement) {
        this.clearAutoMovement();
        this.moveManually();
      } else {
        this.manualVelocityActive = false;
        if (!selectBeforeAttack) this.updateAutoTarget(dt);
        this.movePlayer(dt);
      }
      const target = this.getTree(this.player.targetId);
      if (target) {
        this.player.aim = normalize({ x: this.nearHitPoint.x - this.player.position.x, z: this.nearHitPoint.z - this.player.position.z });
      } else if (this.player.moving) {
        this.player.aim = normalize(this.player.velocity);
      }
      this.attackClock += dt;
      const attempt = !!target && this.attackClock + 1e-10 >= this.attackInterval;
      const attackFacing = attempt ? this.facingToward(this.colliderCenter(target!)) : undefined;
      this.sampleMuzzle(dt, target, attackFacing);
      if (attackFacing !== undefined) this.player.facing = attackFacing;
      if (attempt) {
        this.attackClock = 0;
        if (!this.fire()) this.attackClock = this.attackInterval - dt;
      }
    } else {
      this.clearAutoMovement(); this.moveManually(); this.sampleMuzzle(dt);
    }
    this.updateFollowers(dt);
    if (!this.combatStopped) this.stage.boss?.update(dt, this.player.position);
    if (!this.combatStopped) { this.hunt?.update(dt); this.collectHuntEvents(); }
  }

  private collectHuntEvents(): void {
    if (!this.hunt) return;
    for (const event of this.hunt.drainEvents()) {
      this.events.push(event);
      if (event.type === 'huntFailed') this.stopCombat();
    }
  }

  private sampleMuzzle(dt: number, target?: Damageable, attackFacing?: -1 | 1): void {
    if (!this.muzzleProvider) return;
    const offset = this.muzzleProvider({ dt, player: this.player, actorId: 0, weaponId: this.player.weaponId,
      manualLookDirection: manualLookDirection(this.movementInput),
      targetPoint: target ? this.loadout[0].weapon.type === 'MISSILE' ? this.colliderCenter(target) : copy(this.nearHitPoint) : null, attackFacing,
      attackInterval: this.attackInterval, attackProgress: target ? clamp(this.attackClock / this.attackInterval, 0, 1) : 0,
      willFire: !!target && attackFacing !== undefined && this.bullets.some(bullet => !bullet.active || !bullet.damaging) });
    this.muzzleOffset = offset && Number.isFinite(offset.x) && Number.isFinite(offset.z) ? copy(offset) : null;
  }

  private sampleStoppedPoses(dt: number): void {
    this.sampleMuzzle(dt);
    if (this.muzzleProvider) for (const follower of this.followers) {
      this.muzzleProvider({ dt, player: follower.player, actorId: follower.player.actorId,
        weaponId: follower.player.weaponId, targetPoint: null, attackInterval: follower.loadout.attackInterval, attackProgress: 0, willFire: false });
    }
  }

  private getTree(id: number | null): Damageable | undefined {
    return id === null ? undefined : this.damageTargets.find(tree => tree.id === id);
  }

  private colliderCenter(tree: Damageable): Vec2 {
    if (tree.orientedBoxCollider) return tree.orientedBoxCollider.transform;
    return { x: (tree.collider.minX + tree.collider.maxX) / 2, z: (tree.collider.minZ + tree.collider.maxZ) / 2 };
  }

  private closestTargetPoint(position: Vec2, target: Damageable): Vec2 {
    if (target.capsuleCollider) return closestPointOnHuntCapsule(position, C.rayHeight, target);
    if (target.orientedBoxCollider) return closestPointOnOrientedBox(position, C.rayHeight, target.orientedBoxCollider);
    return target.sphereCollider ? closestPointOnSphere(position, C.rayHeight, target) : closestPoint(position, target.collider);
  }

  private isVisible(tree: Damageable): boolean {
    // IsOnScreen receives the Collider Transform (tree root + [-2,0,+2]),
    // not the tree root, Bounds center or SpriteRenderer bounds.
    const center = this.colliderCenter(tree), centerX = center.x, centerZ = center.z;
    const projectedX = CAMERA_BASIS.rightX * centerX + CAMERA_BASIS.rightZ * centerZ;
    const transformY = tree.orientedBoxCollider?.transformY ?? tree.sphereCollider?.transformY ?? tree.capsuleCollider?.transformY ?? 0;
    const projectedY = CAMERA_BASIS.upX * centerX + CAMERA_BASIS.upY * transformY + CAMERA_BASIS.upZ * centerZ;
    const cameraX = CAMERA_BASIS.rightX * this.player.position.x + CAMERA_BASIS.rightZ * this.player.position.z;
    const cameraY = CAMERA_BASIS.upX * this.player.position.x + CAMERA_BASIS.upZ * this.player.position.z;
    const depth = (centerX - this.player.position.x - C.cameraPosition.x) * CAMERA_BASIS.forwardX -
      (C.cameraPosition.y - transformY) * CAMERA_BASIS.forwardY +
      (centerZ - this.player.position.z - C.cameraPosition.z) * CAMERA_BASIS.forwardZ;
    const halfHeight = this.hunt ? HUNT_RULES.cameraHalfHeight : C.cameraHalfHeight;
    return depth > 0 && Math.abs(projectedX - cameraX - C.cameraOffsetX) <= halfHeight * this.aspect * (1 + 2 * C.viewportMargin) &&
      Math.abs(projectedY - cameraY - C.cameraOffsetY) <= halfHeight * (1 + 2 * C.viewportMargin);
  }

  private isValidTarget(tree?: Damageable): boolean { return !!tree?.alive && this.isVisible(tree); }

  private targetRange(tree: Damageable): number {
    // Ray_trans.y=2; Collider Transform.y=0 (its Box center.y=3 is unrelated).
    return Math.hypot(distance(this.player.position, this.colliderCenter(tree)), C.rayHeight - (tree.orientedBoxCollider?.transformY ?? tree.sphereCollider?.transformY ?? tree.capsuleCollider?.transformY ?? 0));
  }

  /** Main and SpeedRun retain an attackable target instead of periodically
   * replacing it with a slightly better movement candidate. */
  private get usesPersistentCombatTarget(): boolean {
    const layout = this.stage.mapLayout;
    return !this.stage.ores && !this.hunt && !this.stage.boss && !this.stage.raidBoss &&
      (layout === undefined || layout === 'main' || layout === 'arena');
  }

  private isAttackableTarget(target?: Damageable): target is Damageable {
    return !!target && this.isValidTarget(target) && this.targetRange(target) <= this.attackRange;
  }

  private resolveAttackTarget(): void {
    if (this.movementInput.x * this.movementInput.x + this.movementInput.y * this.movementInput.y > MANUAL_INPUT_SQUARED_THRESHOLD) {
      // Source ResolveAttackTarget adopts the current ray target (including
      // null) during manual movement in every mode, ahead of auto/locked targets.
      // Main-cat aim uses the Collider transform after this resolution.
      this.lockedAttackTargetId = this.player.targetId;
      const near = this.getTree(this.player.targetId);
      if (near) this.nearHitPoint = this.colliderCenter(near);
      return;
    }
    if (this.usesPersistentCombatTarget) {
      const locked = this.getTree(this.lockedAttackTargetId);
      const auto = this.getTree(this.autoTargetId);
      const ray = this.getTree(this.player.targetId);
      let target: Damageable | undefined;
      if (this.isAttackableTarget(locked)) target = locked;
      else if (this.isValidTarget(auto)) {
        if (this.isAttackableTarget(auto)) target = auto;
      } else if (this.isAttackableTarget(ray)) target = ray;
      this.player.targetId = this.lockedAttackTargetId = target?.id ?? null;
      if (target) {
        this.autoTargetId = target.id;
        this.nearHitPoint = this.closestTargetPoint(this.player.position, target);
      } else if (this.isValidTarget(auto)) {
        this.nearHitPoint = this.closestTargetPoint(this.player.position, auto!);
      }
      return;
    }
    const auto = this.getTree(this.autoTargetId);
    if (this.isValidTarget(auto)) {
      this.nearHitPoint = this.closestTargetPoint(this.player.position, auto!);
      this.player.targetId = this.lockedAttackTargetId = this.targetRange(auto!) <= this.attackRange ? auto!.id : null;
      return;
    }
    const locked = this.getTree(this.lockedAttackTargetId);
    if (this.isValidTarget(locked) && this.targetRange(locked!) <= this.attackRange) {
      this.player.targetId = locked!.id;
    } else this.lockedAttackTargetId = this.player.targetId;
    // Source fallback tests Object!=null only, even for a recently disabled
    // Collider. Its transform can survive until the next ray/auto selection.
    const near = this.getTree(this.player.targetId);
    if (near) this.nearHitPoint = this.colliderCenter(near);
  }

  private updateAutoTarget(dt: number): void {
    if (this.hunt) { this.autoTargetId = null; return; }
    if (this.usesPersistentCombatTarget) {
      const locked = this.getTree(this.lockedAttackTargetId);
      if (this.isAttackableTarget(locked)) {
        this.autoTargetId = locked.id;
        this.autoSearchTimer = 0;
        return;
      }
      if (this.lockedAttackTargetId !== null) {
        // Losing a lock must search immediately, including when its object is
        // still alive but has left the viewport or attack range.
        this.lockedAttackTargetId = this.autoTargetId = null;
      }
    }
    this.autoSearchTimer += dt;
    if (this.autoSearchTimer + 1e-10 >= C.autoSearchInterval || this.getTree(this.autoTargetId) === undefined) {
      this.autoSearchTimer = 0;
      this.autoTargetId = this.findAutoTarget()?.id ?? null;
    }
    const auto = this.getTree(this.autoTargetId);
    if (auto && !auto.alive) this.autoTargetId = this.findAutoTarget()?.id ?? null;
  }

  private facingToward(point: Vec2): -1 | 1 {
    return point.x - this.player.position.x + point.z - this.player.position.z > 0 ? 1 : -1;
  }

  private findRayTarget(player = this.player, hitPoint?: Vec2): Damageable | undefined {
    let best: Damageable | undefined;
    let bestDistance = Infinity;
    let offscreenDistance = Infinity;
    const index = this.prepareTargetIndex();
    const candidates = index?.around(player.position, this.attackRange, this.rayCandidates) ?? this.damageTargets;
    if (this.hunt) this.huntOffscreenTargets.delete(player.actorId);
    for (const direction of this.hunt ? HUNT_ATTACK_RAYS : ATTACK_RAYS) {
      let firstTree: Damageable | undefined;
      let firstDistance = Infinity;
      for (const tree of candidates) {
        if (!tree.alive) continue;
        // Physics.Raycast ignores colliders containing its origin. Ray.y=2
        // lies within the source tree box's height range [0,6].
        const p = player.position, box = tree.collider;
        const sphere = tree.sphereCollider, center = sphere ? sphereCenter(tree) : null;
        const oriented = tree.orientedBoxCollider;
        const capsule = tree.capsuleCollider;
        if (capsule ? insideHuntCapsule(p, C.rayHeight, tree) : oriented ? insideOrientedBox(p, C.rayHeight, oriented) : sphere ? Math.hypot(p.x - center!.x, C.rayHeight - center!.y, p.z - center!.z) < sphere.radius
          : p.x > box.minX && p.x < box.maxX && p.z > box.minZ && p.z < box.maxZ) continue;
        const end = { x: p.x + direction.x * this.attackRange, z: p.z + direction.z * this.attackRange, y: C.rayHeight };
        const fraction = capsule ? sweepSphereHuntCapsule({ ...p, y: C.rayHeight }, end, 0, tree)
          : oriented ? sweepSphereOrientedBox({ ...p, y: C.rayHeight }, end, 0, oriented)
          : sphere ? sweepSphereSphere({ ...p, y: C.rayHeight }, end, 0, center!, sphere.radius) : null;
        const hit = sphere || oriented || capsule ? fraction === null ? null : fraction * this.attackRange : rayAABB(player.position, direction, this.attackRange, tree.collider);
        if (hit !== null && hit < firstDistance) { firstDistance = hit; firstTree = tree; }
      }
      // A ray cannot select a farther target through an off-screen foreground collider.
      if (firstTree && this.isVisible(firstTree) && firstDistance < bestDistance) {
        bestDistance = firstDistance; best = firstTree;
        if (hitPoint) { hitPoint.x = player.position.x + direction.x * firstDistance; hitPoint.z = player.position.z + direction.z * firstDistance; }
      } else if (this.hunt && firstTree && !this.isVisible(firstTree) && firstDistance < offscreenDistance) {
        offscreenDistance = firstDistance;
        this.huntOffscreenTargets.set(player.actorId, { id: firstTree.id,
          point: this.colliderCenter(firstTree) });
      }
    }
    return best;
  }

  private findAutoTarget(): Damageable | undefined {
    if (this.stage.ores) {
      // Scene OreLayer=0 makes both OverlapSphereNonAlloc passes empty.
      // FindNearestOreFallback then scans the active pool in serialized order;
      // strict '<' preserves the first pooled ore when distances tie.
      let nearest: OreState | undefined, squared = Infinity;
      for (const ore of this.stage.ores) {
        if (!ore.alive) continue;
        const dx = ore.position.x - this.player.position.x, dz = ore.position.z - this.player.position.z;
        const distanceSquared = dx * dx + dz * dz;
        if (distanceSquared < squared) { nearest = ore; squared = distanceSquared; }
      }
      return nearest;
    }
    if (this.hunt) return this.findRayTarget();
    // Cat.FindBossTarget directly returns the one living Boss, independent of
    // the main-stage tree priority and current camera visibility.
    if (this.stage.boss) return this.stage.boss.alive ? this.stage.boss : undefined;
    if (!this.stage.raidBoss && (this.stage.mapLayout === undefined || this.stage.mapLayout === 'main')) {
      return this.findMainTreeTarget();
    }
    let result: Damageable | undefined;
    let bestScore = Infinity;
    for (const tree of this.damageTargets) {
      if (!tree.alive) continue;
      const d = distance(this.player.position, tree.position);
      const score = d + (d > C.autoNearbyRadius ? C.autoZWeight * Math.max(0, tree.position.z - this.player.position.z) : 0);
      if (score < bestScore) { bestScore = score; result = tree; }
    }
    return result;
  }

  /** Cat.FindNearestTreeByGrid (RVA 0x2b3ecd8) sorts active grid banks by
   * their authored Z bounds and stops once the next bound exceeds the best
   * score. Flattening the banks lets the next bank's front trees preempt
   * unfinished nearby trees, leaving earlier trees to be revisited later. */
  private findMainTreeTarget(): TreeState | undefined {
    const grids = new Map<number, TreeState[]>();
    const independent: TreeState[] = [];
    for (const tree of this.trees) {
      if (!tree.alive) continue;
      if (tree.gridOriginZ === undefined) { independent.push(tree); continue; }
      let trees = grids.get(tree.gridOriginZ);
      if (!trees) { trees = []; grids.set(tree.gridOriginZ, trees); }
      trees.push(tree);
    }
    const player = this.player.position;
    const ordered = Array.from(grids, ([originZ, trees]) => ({ originZ, trees,
      lowerBound: player.z < originZ ? originZ - player.z : Math.max(0, player.z - (originZ + C.treeGridSearchDepth)),
    })).sort((a, b) => a.lowerBound - b.lowerBound || a.originZ - b.originZ);
    let result: TreeState | undefined;
    let bestScore = Infinity;
    const consider = (tree: TreeState): void => {
      const d = distance(player, tree.position);
      const score = d + (d > C.autoNearbyRadius ? C.autoZWeight * Math.max(0, tree.position.z - player.z) : 0);
      if (score < bestScore) { bestScore = score; result = tree; }
    };
    for (const grid of ordered) {
      if (grid.lowerBound > bestScore) break;
      for (const tree of grid.trees) consider(tree);
    }
    // The fifth-wave Boss_tree is compared after grid pruning, with the same
    // score. Ungrouped custom maps retain their existing array-order search.
    for (const tree of independent) consider(tree);
    return result;
  }

  private clearAutoMovement(): void {
    this.autoTargetId = null; this.autoSearchTimer = 0;
    this.autoSmoothVelocity = { x: 0, z: 0 };
  }

  private moveManually(): void {
    const input = this.movementInput;
    const moving = this.battlefieldActive && input.x * input.x + input.y * input.y > MANUAL_INPUT_SQUARED_THRESHOLD;
    this.manualVelocityActive = moving;
    this.player.moving = moving;
    this.player.velocity = moving ? manualVelocity(input, C.playerSpeed * this.effectiveMovementMultiplier) : { x: 0, z: 0 };
    if (this.hunt) this.constrainHuntCat(this.player);
    const target = this.getTree(this.player.targetId);
    if (target) this.player.facing = this.facingToward(this.colliderCenter(target));
    else if (moving) this.player.facing = input.x > 0 ? 1 : -1;
  }

  private movePlayer(dt: number): void {
    if (this.hunt) { this.moveHuntCat(this.player, dt, C.playerSpeed); return; }
    const autoTarget = this.getTree(this.autoTargetId);
    const attackTarget = this.getTree(this.player.targetId);
    let desiredVelocity: Vec2 = { x: 0, z: 0 };
    let moving = false;
    if (autoTarget) {
      const reference = attackTarget ? this.nearHitPoint : autoTarget.position;
      const separation = distance(this.player.position, reference);
      let destination: Vec2 | null = null;
      let speedRatio = 1;
      let facingPoint: Vec2 | null = null;
      if (separation < C.minimumEnemyDistance && attackTarget) {
        let away = normalize({ x: this.player.position.x - reference.x, z: this.player.position.z - reference.z });
        if (separation * separation < C.retreatDirectionSquaredThreshold) away = { x: 0, z: -1 };
        destination = { x: reference.x + away.x * (C.minimumEnemyDistance + 0.5), z: reference.z + away.z * (C.minimumEnemyDistance + 0.5) };
        if (distance(this.player.position, destination) <= C.retreatDestinationTolerance) {
          destination = null;
          facingPoint = this.colliderCenter(attackTarget);
        } else facingPoint = { x: this.player.position.x + away.x, z: this.player.position.z + away.z };
      } else if (separation > C.stopDistance) {
        const offsetWeight = clamp01((separation - C.autoZOffsetMinDistance) / (C.autoZOffsetFullDistance - C.autoZOffsetMinDistance));
        const offset = clamp(C.autoZOffset * offsetWeight, -C.stopDistance * C.maximumApproachOffsetRatio, C.stopDistance * C.maximumApproachOffsetRatio);
        destination = { x: autoTarget.position.x, z: autoTarget.position.z + offset };
        if (distance(this.player.position, destination) < C.approachDestinationTolerance) destination = null;
        else facingPoint = attackTarget ? this.colliderCenter(attackTarget) : destination;
        if (separation < C.stopDistance + C.decelerationRange) {
          const t = clamp01((separation - C.stopDistance) / C.decelerationRange);
          const smooth = t * t * (3 - 2 * t);
          speedRatio = C.minimumApproachSpeed + (1 - C.minimumApproachSpeed) * smooth;
        }
      } else facingPoint = attackTarget ? this.colliderCenter(attackTarget) : autoTarget.position;
      if (destination) {
        moving = true;
        const direction = normalize({ x: destination.x - this.player.position.x, z: destination.z - this.player.position.z });
        const speed = C.playerSpeed * this.effectiveMovementMultiplier * speedRatio * screenSpeedMultiplier(direction);
        desiredVelocity = { x: direction.x * speed, z: direction.z * speed };
      }
      if (facingPoint) this.player.facing = this.facingToward(facingPoint);
    }
    const factor = clamp01(dt * C.velocitySmoothing);
    this.autoSmoothVelocity.x += (desiredVelocity.x - this.autoSmoothVelocity.x) * factor;
    this.autoSmoothVelocity.z += (desiredVelocity.z - this.autoSmoothVelocity.z) * factor;
    // Main Cat.HandleAutoMove sets Walk from its movement branch. Its stop
    // branch starts Idle immediately while AutoSmoothStop still decelerates.
    this.player.moving = moving;
    const v = this.autoSmoothVelocity;
    if (!this.player.moving && v.x * v.x + v.z * v.z < C.autoStopSquaredSpeed) this.autoSmoothVelocity = { x: 0, z: 0 };
    this.player.velocity = copy(this.autoSmoothVelocity);
  }

  /** Monster mode uses the actor's own visible ray target, then its nearest
   * off-screen ray collider. With neither, every cat returns to the center. */
  private moveHuntCat(player: PlayerState, dt: number, speed: number, follower?: FollowerAI, separation: Vec2 = { x: 0, z: 0 }): void {
    const target = this.getTree(player.targetId), offscreen = this.huntOffscreenTargets.get(player.actorId);
    const reference = target ? this.colliderCenter(target) : offscreen?.point;
    const radial = reference ? normalize({ x: reference.x - HUNT_CENTER.x, z: reference.z - HUNT_CENTER.z }) : { x: 0, z: 0 };
    const destination = { x: HUNT_CENTER.x + radial.x * HUNT_RULES.catRadius, z: HUNT_CENTER.z + radial.z * HUNT_RULES.catRadius };
    const delta = { x: destination.x - player.position.x, z: destination.z - player.position.z }, d = length(delta);
    const direction = normalize(delta), moving = d >= HUNT_RULES.catArrivalThreshold;
    let desired: Vec2 = { x: 0, z: 0 };
    if (moving) {
      const t = clamp01(d / C.decelerationRange);
      const ratio = follower ? C.followerMinimumSpeedRatio + (1 - C.followerMinimumSpeedRatio) * t * t * (3 - 2 * t) : 1;
      const baseSpeed = speed * this.effectiveMovementMultiplier;
      const magnitude = baseSpeed * (follower?.speedMultiplier ?? 1) * screenSpeedMultiplier(direction) * ratio;
      desired = { x: direction.x * magnitude + (follower ? separation.x * baseSpeed : 0),
        z: direction.z * magnitude + (follower ? separation.z * baseSpeed : 0) };
    }
    const velocity = follower ? player.velocity : this.autoSmoothVelocity, factor = clamp01(dt * C.velocitySmoothing);
    velocity.x += (desired.x - velocity.x) * factor; velocity.z += (desired.z - velocity.z) * factor;
    // HandleAIMonster explicitly zeros Rigidbody after SmoothStop within one
    // unit; the leader retains AutoSmoothStop's ordinary deceleration.
    if (!moving && (follower || velocity.x ** 2 + velocity.z ** 2 < C.autoStopSquaredSpeed)) velocity.x = velocity.z = 0;
    player.velocity = copy(velocity); player.moving = moving;
    const facing = target ? { x: target.position.x - player.position.x, z: target.position.z - player.position.z } : moving ? direction : null;
    if (facing) player.facing = facing.x + facing.z > 0 ? 1 : -1;
    if (target) {
      const hit = follower?.nearHitPoint ?? this.nearHitPoint;
      player.aim = normalize({ x: hit.x - player.position.x, z: hit.z - player.position.z });
    } else if (moving) player.aim = direction;
    this.constrainHuntCat(player);
  }

  private constrainHuntCat(player: PlayerState): void {
    const dx = player.position.x - HUNT_CENTER.x, dz = player.position.z - HUNT_CENTER.z, radius = Math.hypot(dx, dz);
    if (radius < HUNT_RULES.catRadius) return;
    const nx = dx / radius, nz = dz / radius, outward = player.velocity.x * nx + player.velocity.z * nz;
    if (outward > 0) { player.velocity.x -= outward * nx; player.velocity.z -= outward * nz; }
    player.position = { x: HUNT_CENTER.x + nx * HUNT_RULES.catRadius, z: HUNT_CENTER.z + nz * HUNT_RULES.catRadius };
  }

  private moveAndSlide(displacement: Vec2, player = this.player): void {
    if (this.hunt) {
      // Source Cat layer6 and Monster layer9 are disabled in PhysicsManager's
      // collision matrix; their non-trigger capsules do not push each other.
      player.position = { x: player.position.x + displacement.x, z: player.position.z + displacement.z };
      this.constrainHuntCat(player); return;
    }
    this.resolveBodyOverlap(player);
    let remaining = copy(displacement);
    for (let attempt = 0; attempt < 4 && length(remaining) > 1e-7; attempt++) {
      const start = player.position;
      const end = { x: start.x + remaining.x, z: start.z + remaining.z };
      let earliest: ReturnType<typeof sweepCircleAABB> = null;
      for (const tree of this.damageTargets) {
        if (!tree.alive) continue;
        let hit: ReturnType<typeof sweepCircleAABB>;
        if (tree.sphereCollider) {
          const center = sphereCenter(tree), radius = this.bodySphereRadius(tree);
          const time = sweepSphereSphere({ ...start, y: 0 }, { ...end, y: 0 }, 0, { ...center, y: 0 }, radius);
          hit = time === null ? null : { time, normal: normalize({ x: start.x + remaining.x * time - center.x,
            z: start.z + remaining.z * time - center.z }) };
        } else if (tree.orientedBoxCollider) hit = sweepCircleOrientedBox(start, end, C.playerRadius, tree.orientedBoxCollider);
        else hit = sweepCircleAABB(start, end, C.playerRadius, tree.collider);
        if (hit && (!earliest || hit.time < earliest.time)) earliest = hit;
      }
      if (!earliest) { player.position = end; break; }
      const safeTime = Math.max(0, earliest.time - 0.0001);
      player.position = { x: start.x + remaining.x * safeTime, z: start.z + remaining.z * safeTime };
      remaining.x *= 1 - earliest.time;
      remaining.z *= 1 - earliest.time;
      const into = remaining.x * earliest.normal.x + remaining.z * earliest.normal.z;
      if (into < 0) {
        remaining.x -= earliest.normal.x * into;
        remaining.z -= earliest.normal.z * into;
      }
    }
    player.position.x = clamp(player.position.x, this.stage.bounds.minX + C.playerRadius, this.stage.bounds.maxX - C.playerRadius);
    player.position.z = clamp(player.position.z, this.stage.bounds.minZ + C.playerRadius, this.stage.bounds.maxZ - C.playerRadius);
  }

  /** Warp can activate a follower inside a tree or outside the map. PhysX
   * separates overlapping rigidbodies even when their velocity is zero. */
  private resolveBodyOverlap(player: PlayerState): void {
    if (this.hunt) { this.constrainHuntCat(player); return; }
    const bounded = (p: Vec2): Vec2 => ({
      x: clamp(p.x, this.stage.bounds.minX + C.playerRadius, this.stage.bounds.maxX - C.playerRadius),
      z: clamp(p.z, this.stage.bounds.minZ + C.playerRadius, this.stage.bounds.maxZ - C.playerRadius),
    });
    player.position = bounded(player.position);
    const boss = this.stage.boss;
    if (boss) {
      if (boss.alive) player.position = bounded(separateCircleOrientedBox(player.position, C.playerRadius, boss.orientedBoxCollider));
      return;
    }
    const raidBoss = this.stage.raidBoss;
    if (raidBoss) {
      const center = sphereCenter(raidBoss), offset = { x: player.position.x - center.x, z: player.position.z - center.z };
      const radius = this.bodySphereRadius(raidBoss), magnitude = length(offset);
      if (magnitude < radius - 1e-8) {
        const direction = magnitude > 1e-8 ? normalize(offset) : { x: 0, z: -1 };
        player.position = bounded({ x: center.x + direction.x * (radius + 1e-6), z: center.z + direction.z * (radius + 1e-6) });
      }
      return;
    }
    const boxes = this.trees.filter(t => t.alive).map(t => t.collider);
    if (!boxes.some(box => circleOverlapsBox(player.position, C.playerRadius, box))) return;
    const origin = copy(player.position);
    // Search outward through overlapping boxes. Face exits are also candidates
    // when a nearer exit is blocked by another tree or the map boundary.
    const candidates: Vec2[] = [origin];
    const seen = new Set<string>();
    while (candidates.length) {
      candidates.sort((a, b) => distance(a, origin) - distance(b, origin));
      const point = candidates.shift()!;
      const key = `${point.x.toFixed(7)},${point.z.toFixed(7)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const box = boxes.find(b => circleOverlapsBox(point, C.playerRadius, b));
      if (!box) { player.position = point; return; }
      const near = closestPoint(point, box), delta = { x: point.x - near.x, z: point.z - near.z }, d = length(delta);
      const radius = C.playerRadius + 1e-6;
      if (d > 1e-8 && seen.size === 1) candidates.push(bounded({ x: near.x + delta.x * radius / d, z: near.z + delta.z * radius / d }));
      candidates.push(
        bounded({ x: box.minX - radius, z: point.z }), bounded({ x: box.maxX + radius, z: point.z }),
        bounded({ x: point.x, z: box.minZ - radius }), bounded({ x: point.x, z: box.maxZ + radius }),
      );
    }
  }

  private bodySphereRadius(target: Damageable): number {
    // Cat CapsuleCollider67065: radius1.5, height8, centerY4.5. The capsule's
    // central segment runs y2..7; Raid's sphere center y4.55 lies inside it.
    const shape = target.sphereCollider!, vertical = shape.centerY - clamp(shape.centerY, 2, 7);
    return Math.sqrt(Math.max(0, (shape.radius + C.playerRadius) ** 2 - vertical ** 2));
  }

  private recordLeaderHistory(): void {
    this.leaderHistory.push({ time: this.frameTime, position: copy(this.player.position) });
    while (this.leaderHistory.length > 1 && this.leaderHistory[0].time < this.frameTime - 2) this.leaderHistory.shift();
    if (!this.breadcrumbs.length || distance(this.breadcrumbs[this.breadcrumbs.length - 1], this.player.position) >= 0.5) {
      this.breadcrumbs.push(copy(this.player.position));
      if (this.breadcrumbs.length > 100) this.breadcrumbs.shift();
    }
  }

  private breadcrumbTarget(position: Vec2): Vec2 {
    if (!this.breadcrumbs.length) return position;
    let index = 0, best = Infinity;
    for (let i = 0; i < this.breadcrumbs.length; i++) {
      const d = distance(position, this.breadcrumbs[i]);
      if (d < best) { best = d; index = i; }
    }
    // GetBreadcrumbTarget clamps lookahead to the final recorded point. Only
    // a cat already nearest that final point switches to the live leader.
    const ahead = Math.min(index + 5, this.breadcrumbs.length - 1);
    return ahead === index ? this.player.position : this.breadcrumbs[ahead];
  }

  private followerPathClear(from: Vec2, to: Vec2): boolean {
    if (this.hunt) return true;
    const lengthTo = distance(from, to);
    // Cat.IsPathClear skips its BoxCast below the source float 0.01.
    if (lengthTo < 0.009999999776482582) return true;
    const boss = this.stage.boss;
    if (boss) return !boss.alive || sweepBoxOrientedBox(from, to, .3, .3, -.4, .4, boss.orientedBoxCollider) === null;
    const raidBoss = this.stage.raidBoss;
    if (raidBoss) {
      const center = sphereCenter(raidBoss);
      // Relative motion turns BoxCast against the sphere into a sphere sweep
      // against the stationary source half-extents (.3,.4,.3).
      return sweepSphereBox({ x: center.x - from.x, y: center.y, z: center.z - from.z },
        { x: center.x - to.x, y: center.y, z: center.z - to.z }, raidBoss.sphereCollider.radius,
        { minX: -.3, maxX: .3, minZ: -.3, maxZ: .3 }, -.4, .4) === null;
    }
    const direction = normalize({ x: to.x - from.x, z: to.z - from.z });
    const boxes = [...this.trees.filter(t => t.alive).map(t => t.collider), ...this.bulletWalls];
    // Cat.IsPathClear uses a BoxCast of half-extents (0.3,0.4,0.3).
    return !boxes.some(box => rayAABB(from, direction, lengthTo, {
      minX: box.minX - 0.3, maxX: box.maxX + 0.3, minZ: box.minZ - 0.3, maxZ: box.maxZ + 0.3,
    }) !== null);
  }

  private updateFollowers(dt: number): void {
    for (const follower of this.followers) {
      const p = follower.player, loadout = follower.loadout;
      if (this.stats.complete) {
        p.targetId = null; p.velocity = { x: 0, z: 0 }; p.moving = false;
        if (this.muzzleProvider) this.muzzleProvider({ dt, player: p, actorId: p.actorId, weaponId: p.weaponId, targetPoint: null,
          attackInterval: loadout.attackInterval, attackProgress: 0, willFire: false });
        continue;
      }
      follower.searchTimer += dt;
      if (follower.searchTimer + 1e-10 >= C.attackSearchInterval) {
        follower.searchTimer = 0;
        p.targetId = this.findRayTarget(p, follower.nearHitPoint)?.id ?? null;
      }
      const target = this.getTree(p.targetId);
      // Source follower nearObj remains until its next ray pass, independently
      // of the leader's auto-target and retained attack target.
      const hasTarget = !!target;
      const maxSpread = maximumSpread(loadout.attackInterval);
      if (hasTarget && !follower.previouslyHadTarget) follower.spread = follower.attackClock = 0;
      if (!hasTarget) follower.spread = Math.max(0, follower.spread - Math.max(1, maxSpread) * C.spreadDecayMultiplier * dt);
      follower.previouslyHadTarget = hasTarget;
      const separation: Vec2 = { x: 0, z: 0 };
      // ComputeSeparation traverses all three serialized cats without an
      // activeSelf test. Disabled followers retain their last position; before
      // first activation Cat_manager.Warp uses its constructor offsets ±6,-6.
      for (let actorId = 0; actorId < 3; actorId++) {
        if (actorId === p.actorId) continue;
        const origin = this.stage.spawnPosition ?? { x: 0, z: 0 };
        const other = actorId === 0 ? this.player.position : this.followerCache.get(actorId)?.player.position ?? { x: origin.x + (actorId === 1 ? -6 : 6), z: origin.z - 6 };
        const dx = p.position.x - other.x, dz = p.position.z - other.z, d = Math.hypot(dx, dz);
        if (d >= 0.00001 && d < C.separationRadius) {
          const strength = (1 - d / C.separationRadius) * C.separationStrength / d;
          separation.x += dx * strength; separation.z += dz * strength;
        }
      }
      if (this.hunt) this.moveHuntCat(p, dt, C.followerSpeed, follower, separation);
      else follower.update(dt, {
        leader: this.player, leaderTarget: this.getTree(this.player.targetId) ? this.colliderCenter(this.getTree(this.player.targetId)!) : null,
        ownTarget: target ? follower.nearHitPoint : null, ownTargetCenter: target ? this.colliderCenter(target) : null,
        ownTargetHeight: C.rayHeight, time: this.frameTime, history: this.leaderHistory, movementMultiplier: this.effectiveMovementMultiplier,
        separation, pathClear: (from, to) => this.followerPathClear(from, to), breadcrumb: position => this.breadcrumbTarget(position),
      });
      follower.attackClock += dt;
      const attempt = hasTarget && follower.attackClock + 1e-10 >= loadout.attackInterval;
      const center = target ? this.colliderCenter(target) : null;
      const attackFacing = attempt && center ? (center.x - p.position.x + center.z - p.position.z > 0 ? 1 : -1) as -1 | 1 : undefined;
      if (this.muzzleProvider) {
        const offset = this.muzzleProvider({ dt, player: p, actorId: p.actorId, weaponId: p.weaponId,
          targetPoint: target ? loadout.weapon.type === 'MISSILE' ? this.colliderCenter(target) : copy(follower.nearHitPoint) : null, attackFacing,
          attackInterval: loadout.attackInterval, attackProgress: target ? clamp(follower.attackClock / loadout.attackInterval, 0, 1) : 0,
          willFire: attempt && this.bullets.some(bullet => !bullet.active || !bullet.damaging) });
        follower.muzzleOffset = offset && Number.isFinite(offset.x) && Number.isFinite(offset.z) ? copy(offset) : null;
      }
      if (attackFacing !== undefined) p.facing = attackFacing;
      if (attempt) {
        follower.attackClock = 0;
        if (this.fireActor(p, loadout, follower.nearHitPoint, follower.muzzleOffset, follower.spread)) {
          if (loadout.weapon.type !== 'SHOTGUN') follower.spread += (maxSpread - follower.spread) * C.spreadGrowth;
        } else follower.attackClock = loadout.attackInterval - dt;
      }
    }
  }

  private fire(): boolean {
    const result = this.fireActor(this.player, this.loadout[0], this.nearHitPoint, this.muzzleOffset, this.spread);
    if (result && this.loadout[0].weapon.type !== 'SHOTGUN') this.spread += (this.maximumSpread - this.spread) * C.spreadGrowth;
    return result;
  }

  private fireActor(player: PlayerState, loadout: ActorLoadout, nearPoint: Vec2, muzzleOffset: Vec2 | null, spread: number): boolean {
    const aim = player.aim, weapon = loadout.weapon;
    const muzzle = muzzleOffset ?? { x: aim.x * C.muzzleDistance, z: aim.z * C.muzzleDistance };
    const position = { x: player.position.x + muzzle.x, z: player.position.z + muzzle.z };
    // Cat.Attack passes GetFirePosition and nearHitPoint to CalcBulletDir.
    // A muzzle displaced by animation must not fire parallel to the cat's aim.
    const target = this.getTree(player.targetId);
    const targetPoint = target ? nearPoint : null;
    const delta = targetPoint ? { x: targetPoint.x - position.x, z: targetPoint.z - position.z } : aim;
    const base = length(delta) > 0.01 ? normalize(delta) : { x: 0, z: 1 };
    // Source Attack samples critical chance before ApplySpread even at CriPer=0.
    const critical = this.random.next() < (loadout.criticalChance ?? 0);
    let damage = critical ? loadout.damage.mul(loadout.criticalMultiplier ?? 1.25).discardDecimal() : loadout.damage;
    let damagePrecision = loadout.damagePrecision;
    if (critical) {
      // Cat._critDamage multiplies by integer percent (125), divides by int100,
      // then DiscardDecimal. A double1.25 would incorrectly promote it to p17.
      let source = OriginalInfVal.fromAmount(loadout.damage, damagePrecision)
        .mul(Math.round((loadout.criticalMultiplier ?? 1.25) * 100)).div(100);
      if (loadout.criticalRelicPercent) source = source.mul(loadout.criticalRelicPercent).div(100);
      source = source.discardDecimal();
      damage = source.amount; damagePrecision = source.precision;
    }
    const count = weapon.type === 'SHOTGUN' ? Math.max(1, weapon.pelletCount) : 1;
    const volleyId = ++this.volleyCounter;
    let fired = false;
    for (let pelletIndex = 0; pelletIndex < count; pelletIndex++) {
      // Non-shotgun spread is sampled even if the pool is full. Shotgun checks
      // the pool first, then draws one independent angle per surviving pellet.
      let angle = weapon.type !== 'SHOTGUN' && weapon.type !== 'MISSILE' && spread >= C.spreadSampleThreshold
        ? this.random.range(-spread, spread) * Math.PI / 180 : 0;
      const bullet = this.borrowBullet();
      if (!bullet) break;
      if (weapon.type === 'SHOTGUN') angle = this.random.range(-weapon.shotgunSpreadAngle, weapon.shotgunSpreadAngle) * Math.PI / 180;
      const direction = { x: base.x * Math.cos(angle) + base.z * Math.sin(angle), z: -base.x * Math.sin(angle) + base.z * Math.cos(angle) };
      this.clearBullet(bullet);
      bullet.position = copy(position);
      bullet.previousPosition = copy(position);
      bullet.direction = direction;
      bullet.active = bullet.damaging = true;
      bullet.damage = damage;
      bullet.damagePrecision = damagePrecision;
      bullet.actorId = player.actorId;
      bullet.weaponId = weapon.id;
      bullet.weaponType = weapon.type;
      bullet.critical = critical;
      bullet.volleyId = volleyId;
      bullet.pelletIndex = pelletIndex;
      bullet.explosionRadius = weapon.type === 'MISSILE' ? weapon.missileExplosionRadius :
        weapon.type === 'BLAST_SNIPER' ? weapon.blastSniperExplosionRadius : weapon.type === 'EXPLOSIVE' ? weapon.explosionRadius : 0;
      bullet.life = weapon.type === 'EXPLOSIVE' ? 1.5 :
        ['LASER', 'PIERCE', 'BLAST_SNIPER'].includes(weapon.type) ? weapon.penetratingBulletLifetime : C.bulletLifetime;
      if (weapon.type === 'MISSILE') {
        let destination = target ? this.colliderCenter(target) : targetPoint ?? { x: position.x + base.x * this.attackRange, z: position.z + base.z * this.attackRange };
        if (spread > C.spreadSampleThreshold) {
          const theta = this.random.range(0, Math.PI * 2);
          const radius = this.random.range(0, distance(position, destination) * Math.tan(spread * Math.PI / 180));
          destination = { x: destination.x + Math.cos(theta) * radius, z: destination.z + Math.sin(theta) * radius };
        }
        bullet.missileStart = copy(position);
        bullet.missileTarget = copy(destination);
        // TryFireMissile targets Collider.transform.position, not its bounds
        // center or y=0. Raid's EnemyColl transform is below the ground.
        bullet.missileTargetHeight = target?.orientedBoxCollider?.transformY ?? target?.sphereCollider?.transformY ?? target?.capsuleCollider?.transformY ?? 0;
        bullet.speed = weapon.missileSpeed;
        bullet.missileDuration = Math.max(0.001, distance(position, destination) / Math.max(0.1, weapon.missileSpeed));
        bullet.missileArcHeight = distance(position, destination) * 0.4;
        bullet.direction = normalize({ x: destination.x - position.x, z: destination.z - position.z });
        bullet.life = bullet.missileDuration + 0.5;
        this.bulletTimeouts.set(bullet.id, this.frameTime + bullet.life);
      } else {
        // Linear SpawnEx caps its scaled-time lifetime to 50 / speed.
        this.bulletTimeouts.set(bullet.id, this.frameTime + Math.min(bullet.life, C.bulletMaxDistance / Math.max(bullet.speed, 0.1)));
      }
      this.stats.shots++;
      this.events.push({ type: 'shot', position: copy(bullet.position), bulletId: bullet.id, direction: copy(bullet.direction),
        volleyId, pelletIndex, ...this.bulletMetadata(bullet) });
      fired = true;
    }
    return fired;
  }

  private borrowBullet(): BulletState | undefined {
    for (let pass = 0; pass < 2; pass++) {
      for (let offset = 0; offset < this.bullets.length; offset++) {
        const index = (this.bulletPoolCursor + offset) % this.bullets.length;
        const bullet = this.bullets[index];
        if (!bullet.active || (pass === 1 && !bullet.damaging)) {
          this.bulletPoolCursor = (index + 1) % this.bullets.length;
          return bullet;
        }
      }
    }
    return undefined;
  }

  private updateBulletTimeouts(): void {
    for (const bullet of this.bullets) {
      const deadline = this.bulletTimeouts.get(bullet.id);
      if (!bullet.active || deadline === undefined) continue;
      if (!bullet.damaging) bullet.trailTime = Math.max(0, deadline - this.frameTime);
      if (this.frameTime + 1e-10 < deadline) continue;
      if (bullet.damaging) {
        if (bullet.weaponType === 'EXPLOSIVE' || bullet.weaponType === 'MISSILE') this.explode(bullet, bullet.position, bullet.height);
        this.stopBullet(bullet);
      }
      else this.clearBullet(bullet);
    }
  }

  private updateBullets(dt: number): void {
    const previousContext = this.inFixedPhysics;
    this.inFixedPhysics = true;
    try { this.updateBulletPhysics(dt); }
    finally { this.inFixedPhysics = previousContext; }
  }

  private updateBulletPhysics(dt: number): void {
    let index: CombatSpatialIndex | null | undefined;
    for (const bullet of this.bullets) {
      if (!bullet.active || !bullet.damaging || bullet.weaponType === 'MISSILE') continue;
      if (index === undefined) index = this.prepareTargetIndex();
      bullet.age += dt;
      bullet.previousPosition = copy(bullet.position);
      const travel = bullet.speed * dt;
      const end = { x: bullet.position.x + bullet.direction.x * travel, z: bullet.position.z + bullet.direction.z * travel };
      const contacts: { time: number; tree?: Damageable; wall?: CollisionWall }[] = [];
      for (const tree of index?.sweep(bullet.position, end, C.bulletRadius, this.bulletCandidates) ?? this.damageTargets) {
        if (!this.colliderActive(tree) || bullet.hitIds.includes(tree.id)) continue;
        if (tree.capsuleCollider) {
          const time = sweepSphereHuntCapsule({ ...bullet.position, y: C.bulletHeight }, { ...end, y: C.bulletHeight }, C.bulletRadius, tree);
          if (time !== null) contacts.push({ time, tree });
        } else if (tree.sphereCollider) {
          const time = sweepSphereSphere({ ...bullet.position, y: C.bulletHeight }, { ...end, y: C.bulletHeight },
            C.bulletRadius, sphereCenter(tree), tree.sphereCollider.radius);
          if (time !== null) contacts.push({ time, tree });
        } else if (tree.orientedBoxCollider) {
          const time = sweepSphereOrientedBox({ ...bullet.position, y: C.bulletHeight }, { ...end, y: C.bulletHeight },
            C.bulletRadius, tree.orientedBoxCollider);
          if (time !== null) contacts.push({ time, tree });
        } else {
          const hit = sweepCircleAABB(bullet.position, end, C.bulletRadius, tree.collider);
          if (hit) contacts.push({ time: hit.time, tree });
        }
      }
      for (const wall of this.bulletWalls) {
        const hit = sweepCircleAABB(bullet.position, end, C.bulletRadius, wall);
        if (hit) contacts.push({ time: hit.time, wall });
      }
      contacts.sort((a, b) => a.time - b.time);
      let traveledFraction = 1;
      for (const contact of contacts) {
        if (contact.tree && (!this.colliderActive(contact.tree) || bullet.hitIds.includes(contact.tree.id))) continue;
        bullet.position = { x: bullet.previousPosition.x + (end.x - bullet.previousPosition.x) * contact.time,
          z: bullet.previousPosition.z + (end.z - bullet.previousPosition.z) * contact.time };
        // OnTriggerEnter projects the previous physics position onto the hit
        // collider (current - velocity * fixedDeltaTime), not the swept TOI.
        const impact = contact.tree?.orientedBoxCollider ? closestPointOnOrientedBox(bullet.previousPosition, C.bulletHeight, contact.tree.orientedBoxCollider)
          : contact.tree?.capsuleCollider ? closestPointOnHuntCapsule(bullet.previousPosition, C.bulletHeight, contact.tree)
          : contact.tree?.sphereCollider ? closestPointOnSphere(bullet.previousPosition, C.bulletHeight, contact.tree)
          : { ...closestPoint(bullet.previousPosition, contact.tree?.collider ?? contact.wall!), y: C.bulletHeight };
        this.collideBullet(bullet, impact, contact.tree, impact.y);
        if (!bullet.damaging) { traveledFraction = contact.time; break; }
      }
      if (bullet.damaging) bullet.position = end;
      bullet.traveled += travel * traveledFraction;
    }
  }

  private collideBullet(bullet: BulletState, point: Vec2, tree?: Damageable, height: number = C.bulletHeight): void {
    if (bullet.weaponType === 'EXPLOSIVE' || bullet.weaponType === 'MISSILE') {
      this.explode(bullet, point, height);
      this.stopBullet(bullet);
      return;
    }
    if (bullet.weaponType === 'BLAST_SNIPER' && !bullet.hasExploded) {
      const lethal = !!tree && tree.alive && bullet.damage.compare(tree.health) >= 0;
      // HitBlastSniper marks its first explosion before dispatching the FX;
      // subsequent HitPierce calls still damage, but cannot spawn enemy FX.
      bullet.hasEnemyImpactFx = true;
      this.explode(bullet, point, height);
      if (!lethal) this.stopBullet(bullet);
      return;
    }
    if (tree) {
      const lethal = tree.alive && bullet.damage.compare(tree.health) >= 0;
      bullet.hitIds.push(tree.id);
      // HitPierce remembers a dead Enemy collider but neither damages it,
      // counts a penetration nor emits its first enemy FX. A blast sniper
      // reaches this branch only after its first explosion.
      if (!tree.alive && (bullet.weaponType === 'PIERCE' || bullet.weaponType === 'BLAST_SNIPER')) return;
      this.hitTree(tree, point, bullet.damage, bullet, tree.sphereCollider || tree.orientedBoxCollider || tree.capsuleCollider ? height : undefined);
      const penetrating = bullet.weaponType === 'LASER' || bullet.weaponType === 'PIERCE' || bullet.weaponType === 'BLAST_SNIPER';
      if (!penetrating || !bullet.hasEnemyImpactFx) {
        if (penetrating) bullet.hasEnemyImpactFx = true;
        this.impact(bullet, point, 0, tree.sphereCollider || tree.orientedBoxCollider || tree.capsuleCollider ? height : bullet.height);
      }
      if (bullet.weaponType === 'LASER') {
        // HitLaser has the same UI_type.Raid (5) stop as HitPierce.
        // The collider survives a layer clear, but the laser does not.
        if (this.stage.raidBoss) this.stopBullet(bullet);
        return;
      }
      if (bullet.weaponType === 'PIERCE' || bullet.weaponType === 'BLAST_SNIPER') {
        bullet.pierceCount++;
        // Bullet.HitPierce checks UI_type.Raid after normal damage. Even a
        // lethal hit stops this bullet; it never enters the next full HP layer.
        if (this.stage.raidBoss) { this.stopBullet(bullet); return; }
        if (bullet.pierceCount === 1 || lethal) return;
      }
    } else this.impact(bullet, point, 0);
    this.stopBullet(bullet);
  }

  private explode(bullet: BulletState, point: Vec2, height: number = C.bulletHeight): void {
    if (bullet.hasExploded) return;
    bullet.hasExploded = true;
    this.impact(bullet, point, bullet.explosionRadius, height);
    if (bullet.explosionRadius <= 0) return;
    const index = this.prepareTargetIndex();
    for (const tree of index?.around(point, bullet.explosionRadius, this.explosionCandidates) ?? this.damageTargets) {
      if (!this.colliderActive(tree) || bullet.hitIds.includes(tree.id)) continue;
      const shaped = !!(tree.sphereCollider || tree.orientedBoxCollider || tree.capsuleCollider);
      const onBox = tree.orientedBoxCollider ? closestPointOnOrientedBox(point, height, tree.orientedBoxCollider)
        : tree.capsuleCollider ? closestPointOnHuntCapsule(point, height, tree)
        : tree.sphereCollider ? closestPointOnSphere(point, height, tree) : closestPoint(point, tree.collider);
      const vertical = height - (shaped ? (onBox as typeof onBox & { y: number }).y : clamp(height, tree.colliderMinY ?? 0, tree.colliderMaxY ?? 6));
      if (Math.hypot(point.x - onBox.x, point.z - onBox.z, vertical) > bullet.explosionRadius) continue;
      bullet.hitIds.push(tree.id);
      this.hitTree(tree, onBox, bullet.damage, bullet, shaped ? height - vertical : undefined);
    }
  }

  /** Source missiles move in Update and snapshot the target's full transform.
   * Substeps preserve curved contact with both tree boxes and the Raid sphere. */
  private updateMissiles(dt: number): void {
    let index: CombatSpatialIndex | null | undefined;
    for (const bullet of this.bullets) {
      if (!bullet.active || !bullet.damaging || !bullet.missileStart || !bullet.missileTarget) continue;
      if (index === undefined) index = this.prepareTargetIndex();
      const steps = Math.max(1, Math.ceil(dt / 0.01)), slice = dt / steps;
      for (let step = 0; step < steps && bullet.damaging; step++) {
        const from = { x: bullet.position.x, y: bullet.height, z: bullet.position.z };
        bullet.previousPosition = copy(bullet.position);
        bullet.age += slice;
        const t = clamp01(bullet.age / bullet.missileDuration);
        const to = { x: bullet.missileStart.x + (bullet.missileTarget.x - bullet.missileStart.x) * t,
          z: bullet.missileStart.z + (bullet.missileTarget.z - bullet.missileStart.z) * t,
          y: C.bulletHeight * (1 - t) + (bullet.missileTargetHeight ?? 0) * t + 4 * t * (1 - t) * bullet.missileArcHeight };
        let earliest = Infinity, hitTree: Damageable | undefined, hitWall: CollisionWall | undefined;
        for (const tree of index?.sweep(from, to, C.bulletRadius, this.missileCandidates) ?? this.damageTargets) {
          if (!this.colliderActive(tree)) continue;
          const hit = tree.orientedBoxCollider ? sweepSphereOrientedBox(from, to, C.bulletRadius, tree.orientedBoxCollider)
            : tree.capsuleCollider ? sweepSphereHuntCapsule(from, to, C.bulletRadius, tree)
            : tree.sphereCollider ? sweepSphereSphere(from, to, C.bulletRadius, sphereCenter(tree), tree.sphereCollider.radius)
            : sweepSphereBox(from, to, C.bulletRadius, tree.collider, tree.colliderMinY ?? 0, tree.colliderMaxY ?? 6);
          if (hit !== null && hit < earliest) { earliest = hit; hitTree = tree; }
        }
        // The map's Default walls surround the playable ground plane.
        for (const wall of this.bulletWalls) {
          const hit = sweepSphereBox(from, to, C.bulletRadius, wall, wall.minY, wall.maxY);
          if (hit !== null && hit < earliest) { earliest = hit; hitTree = undefined; hitWall = wall; }
        }
        const fraction = Number.isFinite(earliest) ? earliest : 1;
        bullet.position = { x: from.x + (to.x - from.x) * fraction, z: from.z + (to.z - from.z) * fraction };
        bullet.height = from.y + (to.y - from.y) * fraction;
        bullet.traveled += distance(from, bullet.position);
        if (hitTree || hitWall) {
          const point = hitTree?.orientedBoxCollider ? closestPointOnOrientedBox(bullet.previousPosition, from.y, hitTree.orientedBoxCollider)
            : hitTree?.capsuleCollider ? closestPointOnHuntCapsule(bullet.previousPosition, from.y, hitTree)
            : hitTree?.sphereCollider ? closestPointOnSphere(bullet.previousPosition, from.y, hitTree)
            : { ...closestPoint(bullet.previousPosition, hitTree?.collider ?? hitWall!),
              y: clamp(from.y, hitTree ? hitTree.colliderMinY ?? 0 : hitWall!.minY, hitTree ? hitTree.colliderMaxY ?? 6 : hitWall!.maxY) };
          this.collideBullet(bullet, point, hitTree, point.y);
        } else if (t >= 1) {
          this.explode(bullet, bullet.position, bullet.height);
          this.stopBullet(bullet);
        }
      }
    }
  }

  private bulletMetadata(bullet: BulletState): WeaponEventMetadata {
    return { actorId: bullet.actorId, weaponId: bullet.weaponId, weaponType: bullet.weaponType, critical: bullet.critical };
  }

  private impact(bullet: BulletState, position: Vec2, radius: number, height = bullet.height): void {
    const sourceTime = this.inFixedPhysics ? this.physicsTime : this.frameTime;
    this.events.push({ type: 'impact', position: copy(position), radius, height, sourceTime, ...this.bulletMetadata(bullet) });
  }

  /** Boss death animates its skin but leaves Enemy_Coll active until scene exit.
   * Normal trees disable their GameObject; living-target searches stay separate. */
  private colliderActive(tree: Damageable): boolean {
    return this.battlefieldActive && (tree.alive || tree === this.stage.boss);
  }

  private hitTree(tree: Damageable, position: Vec2, damage: DecimalAmount, bullet?: BulletState, height?: number): void {
    if (!this.colliderActive(tree)) return;
    const sourceTime = this.inFixedPhysics ? this.physicsTime : this.frameTime;
    if ((tree as Partial<OreState>).kind === 'ore') {
      // Gamemanager's Ore-tag route passes literal int1 to Enemy.Damaged.
      // This applies even to a high-damage/critical shot retained from Main.
      // Damage_Collider still emits the ordinary white "1" after Damage_Tag;
      // the Ore route only replaces damage and excludes tree/gold completion.
      const ore = tree as OreState, one = DecimalAmount.from(1);
      if (this.combatStopped || !tree.alive) {
        this.events.push({ type: 'damageText', position: copy(position), ...(height === undefined ? {} : { height }), sourceTime, damage: one,
          ...(bullet ? this.bulletMetadata(bullet) : { actorId: 0, weaponId: this.player.weaponId, weaponType: this.loadout[0].weapon.type }), critical: false });
        return;
      }
      ore.health = ore.health.compare(one) <= 0 ? DecimalAmount.from(0) : ore.health.sub(one);
      this.stats.hits++;
      this.events.push({ type: 'hit', position: copy(position), ...(height === undefined ? {} : { height }), sourceTime, treeId: ore.id,
        damage: one, health: ore.health, maxHealth: ore.maxHealth,
        ...(bullet ? this.bulletMetadata(bullet) : { actorId: 0, weaponId: this.player.weaponId, weaponType: this.loadout[0].weapon.type, critical: false }), critical: false });
      if (ore.health.isZero) {
        ore.alive = false; this.stats.kills++;
        this.events.push({ type: 'oreDied', position: copy(ore.position), oreId: ore.id, score: ore.score, sourceTime });
      }
      return;
    }
    // Gamemanager emits Damage_Txt even when Enemy.Damaged rejects a hit after
    // timeout or Boss death. It must not animate the enemy, change HP, or enter
    // the reward ledger; Bullet.HitPierce excludes corpses before reaching here.
    if (this.combatStopped || !tree.alive) {
      this.events.push({ type: 'damageText', position: copy(position), ...(height === undefined ? {} : { height }), sourceTime, damage,
        ...(bullet ? this.bulletMetadata(bullet) : { actorId: 0, weaponId: this.player.weaponId, weaponType: this.loadout[0].weapon.type, critical: false }) });
      return;
    }
    if (this.hunt) {
      const result = this.hunt.hit(tree.id, damage, bullet?.damagePrecision ?? OriginalInfVal.fromAmount(damage).precision);
      if (!result.damaged) return;
      this.stats.hits++;
      if (result.defeated) this.stats.kills++;
      this.events.push({ type: 'hit', position: copy(position), ...(height === undefined ? {} : { height }), sourceTime,
        treeId: tree.id, damage, health: result.health, maxHealth: result.maxHealth,
        ...(bullet ? this.bulletMetadata(bullet) : { actorId: 0, weaponId: this.player.weaponId, weaponType: this.loadout[0].weapon.type, critical: false }) });
      this.collectHuntEvents();
      return;
    }
    if (tree === this.stage.raidBoss || tree === this.stage.boss) {
      const target = this.stage.boss ?? this.stage.raidBoss!;
      const result = target.hit(damage, bullet?.damagePrecision ?? OriginalInfVal.fromAmount(damage).precision);
      this.stats.hits++;
      if (result.defeated) this.stats.kills++;
      this.events.push({ type: 'hit', position: copy(position), ...(height === undefined ? {} : { height }), sourceTime,
        treeId: tree.id, damage, health: result.health, maxHealth: result.maxHealth,
        ...(bullet ? this.bulletMetadata(bullet) : { actorId: 0, weaponId: this.player.weaponId, weaponType: this.loadout[0].weapon.type, critical: false }) });
      if (this.stage.boss && result.defeated) {
        this.events.push({ type: 'bossDied', position: copy(tree.position), treeId: tree.id, sourceTime });
        this.stopCombat();
      }
      return;
    }
    if (tree.healthPrecision !== undefined) {
      const remaining = subtractOriginalHealth(tree.health, tree.healthPrecision, damage,
        bullet?.damagePrecision ?? OriginalInfVal.fromAmount(damage).precision);
      tree.health = remaining.health; tree.healthPrecision = remaining.precision;
    } else tree.health = damage.compare(tree.health) >= 0 ? DecimalAmount.from(0) : DecimalAmount.from(tree.health).sub(damage);
    this.stats.hits++;
    this.events.push({ type: 'hit', position: copy(position), sourceTime,
      treeId: tree.id, damage, health: tree.health, maxHealth: tree.maxHealth,
      ...(bullet ? this.bulletMetadata(bullet) : { actorId: 0, weaponId: this.player.weaponId, weaponType: this.loadout[0].weapon.type, critical: false }) });
    if (tree.health.isZero) {
      tree.alive = false;
      this.stats.kills++;
      this.events.push({ type: 'treeDied', position: copy(tree.position), treeId: tree.id, sourceTime });
      // Unity disables the tree but retains Collider/Transform references.
      // The next ResolveAttackTarget / HandleAutoMove decides when to replace them.
      if (this.stats.kills === this.stats.totalTrees) {
        this.stats.complete = true;
        // Completed rounds no longer resolve targets, so release the final
        // collider reference now to hide the reticle on this death frame.
        this.autoTargetId = this.lockedAttackTargetId = null;
        for (const actor of this.players) {
          actor.targetId = null;
          actor.velocity = { x: 0, z: 0 }; actor.moving = false;
        }
        this.events.push({ type: 'complete', position: copy(this.player.position) });
      }
    }
  }

  private stopBullet(bullet: BulletState): void {
    if (!bullet.damaging) return;
    bullet.damaging = false;
    bullet.trailTime = C.bulletTrailLifetime;
    this.bulletTimeouts.set(bullet.id, this.frameTime + C.bulletTrailLifetime);
  }

  private clearBullet(bullet: BulletState): void {
    this.bulletTimeouts.delete(bullet.id);
    bullet.active = bullet.damaging = false;
    bullet.position = { x: 0, z: 0 };
    bullet.previousPosition = { x: 0, z: 0 };
    bullet.direction = { x: 0, z: 0 };
    bullet.age = bullet.trailTime = bullet.traveled = 0;
    bullet.life = C.bulletLifetime;
    bullet.damage = BASE_DAMAGE;
    bullet.damagePrecision = undefined;
    bullet.actorId = bullet.weaponId = bullet.volleyId = bullet.pelletIndex = bullet.pierceCount = 0;
    bullet.weaponType = 'SINGLE';
    bullet.critical = bullet.hasExploded = bullet.hasEnemyImpactFx = false;
    bullet.height = C.bulletHeight;
    bullet.speed = C.bulletSpeed;
    bullet.explosionRadius = 0;
    bullet.hitIds.length = 0;
    bullet.missileStart = bullet.missileTarget = null;
    bullet.missileTargetHeight = 0;
    bullet.missileDuration = bullet.missileArcHeight = 0;
  }
}
