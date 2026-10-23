import { CHARACTER_CONFIG as C } from './config';
import { clamp01, distance, length, normalize, Random } from './math';
import { screenSpeedMultiplier } from './projection';
import { ActorLoadout, PlayerState, Vec2 } from './types';

export type FollowerState = 'Follow' | 'Chase' | 'Attack' | 'Reposition' | 'Assist';
export interface LeaderSample { time: number; position: Vec2 }
export interface FollowerContext {
  leader: PlayerState;
  leaderTarget: Vec2 | null;
  ownTarget: Vec2 | null;
  ownTargetCenter?: Vec2 | null;
  ownTargetHeight?: number;
  history: readonly LeaderSample[];
  time: number;
  movementMultiplier?: number;
  separation: Vec2;
  pathClear: (from: Vec2, to: Vec2) => boolean;
  breadcrumb: (position: Vec2) => Vec2;
}

/** Cat.HandleAI's five movement states. Target search and shooting are per actor. */
export class FollowerAI {
  readonly player: PlayerState;
  loadout: ActorLoadout;
  state: FollowerState = 'Follow';
  stateTime = 0;
  attackClock: number;
  searchTimer = 0;
  spread = 0;
  previouslyHadTarget = false;
  nearHitPoint: Vec2 = { x: 0, z: 0 };
  muzzleOffset: Vec2 | null = null;
  readonly lag: number;
  readonly speedMultiplier: number;
  readonly formationOffset: Vec2;
  private readonly random: Random;
  private fidgetTimer = 0;
  private fidgetInterval: number;
  private fidgetOffset: Vec2 = { x: 0, z: 0 };

  constructor(loadout: ActorLoadout, leader: PlayerState, seed: number) {
    this.loadout = loadout;
    this.random = new Random(seed ^ Math.imul(loadout.actorIndex, 0x45d9f3b));
    this.lag = this.random.range(0.15, 0.6);
    this.speedMultiplier = this.random.range(0.88, 1.12);
    this.fidgetInterval = this.random.range(1.8, 3.5);
    this.attackClock = this.random.range(0, 0.4);
    // SetupFormation includes both serialized AI cats, even with one unequipped.
    this.formationOffset = { x: 0, z: loadout.actorIndex === 1 ? C.formationRadius : -C.formationRadius };
    this.player = {
      actorId: loadout.actorIndex, weaponId: loadout.weapon.id, starLevel: loadout.starLevel ?? 0,
      position: { x: leader.position.x + this.formationOffset.x, z: leader.position.z + this.formationOffset.z },
      velocity: { x: 0, z: 0 }, aim: { ...leader.aim }, facing: leader.facing, moving: false, targetId: null,
    };
  }

  update(dt: number, context: FollowerContext): void {
    const p = this.player, target = context.ownTarget;
    const moveSpeed = C.followerSpeed * (context.movementMultiplier ?? 1);
    this.stateTime += dt;
    const leaderDistance = distance(p.position, context.leader.position);
    let next: FollowerState;
    if (leaderDistance > C.followerMaximumDistance) next = 'Follow';
    else if (!target) next = context.leaderTarget ? 'Assist' : 'Follow';
    else {
      const d = Math.hypot(distance(p.position, target), context.ownTargetHeight ?? 0);
      if (d < C.minimumEnemyDistance * (this.state === 'Reposition' ? 1 + C.followerHysteresis : 1)) next = 'Reposition';
      else if (d <= C.stopDistance * (this.state === 'Attack' ? 1 + C.followerHysteresis : 1)) next = 'Attack';
      else if (this.state === 'Attack') next = 'Chase';
      else next = distance(this.approach(context.ownTargetCenter ?? target, C.stopDistance), context.leader.position) <= C.followerMaximumDistance ? 'Chase' : 'Follow';
    }
    if (next !== this.state && this.stateTime >= C.followerMinimumStateDuration) { this.state = next; this.stateTime = 0; }
    // AIChase/AIReposition return immediately when their ray target disappears.
    // The state dwell timer can retain either state until a later Update.
    if ((this.state === 'Chase' || this.state === 'Reposition') && !target) return;
    let destination: Vec2 | null = null;
    let drift = 0;
    const targetCenter = context.ownTargetCenter ?? target;
    let facingDirection: Vec2 | null = null;
    // AIFollow and AIAttackStay face the collider transform even when stopping
    // or drifting. nearHitPoint remains the independent projectile aim point.
    if (targetCenter && (this.state === 'Follow' || this.state === 'Attack')) {
      facingDirection = { x: targetCenter.x - p.position.x, z: targetCenter.z - p.position.z };
    }
    if (this.state === 'Follow') {
      let lagged = context.leader.position;
      for (let i = context.history.length - 1; i >= 0; i--) {
        if (context.history[i].time <= context.time - this.lag) { lagged = context.history[i].position; break; }
      }
      destination = { x: lagged.x + this.formationOffset.x + this.fidgetOffset.x, z: lagged.z + this.formationOffset.z + this.fidgetOffset.z };
      if (distance(p.position, destination) < C.followerIdealDistance * 0.5) {
        destination = null;
        if (context.separation.x ** 2 + context.separation.z ** 2 > 0.1) drift = 0.3;
        this.fidgetTimer += dt;
        if (this.fidgetTimer >= this.fidgetInterval) {
          this.fidgetTimer = 0;
          this.fidgetInterval = this.random.range(1.8, 3.5);
          const angle = this.random.range(0, Math.PI * 2), radius = this.random.range(0.3, 0.8);
          this.fidgetOffset = { x: Math.sin(angle) * radius, z: Math.cos(angle) * radius };
        }
      }
    } else if (this.state === 'Chase' && target) destination = this.approach(target, C.stopDistance);
    else if (this.state === 'Reposition' && target) destination = this.approach(target, C.minimumEnemyDistance + 0.5);
    else if (this.state === 'Assist' && context.leaderTarget) {
      destination = this.approach(context.leaderTarget, C.stopDistance);
      const d = distance(destination, context.leader.position);
      if (d > C.followerMaximumDistance * 0.85) {
        const scale = C.followerMaximumDistance * 0.85 / d;
        destination = { x: context.leader.position.x + (destination.x - context.leader.position.x) * scale,
          z: context.leader.position.z + (destination.z - context.leader.position.z) * scale };
      }
    } else if (this.state === 'Attack' && context.separation.x ** 2 + context.separation.z ** 2 > 0.3) drift = 0.4;
    if (destination && (this.state === 'Chase' || this.state === 'Assist') &&
      Math.hypot(distance(p.position, destination), this.state === 'Chase' ? context.ownTargetHeight ?? 0 : 0) < 0.5) destination = null;
    let desired: Vec2 = { x: 0, z: 0 };
    if (destination) {
      if (!context.pathClear(p.position, destination)) destination = context.breadcrumb(p.position);
      const delta = { x: destination.x - p.position.x, z: destination.z - p.position.z };
      const d = length(delta), direction = normalize(delta), t = clamp01(d / C.decelerationRange);
      if (d <= 0.0010000000474974513) {
        // SmoothMoveTowardWithAvoidance returns through SmoothStop or the
        // half-speed separation branch when its breadcrumb is at the cat.
        destination = null;
        if (context.separation.x ** 2 + context.separation.z ** 2 > 0.009999999776482582) drift = 0.5;
      } else {
        const ratio = C.followerMinimumSpeedRatio + (1 - C.followerMinimumSpeedRatio) * t * t * (3 - 2 * t);
        const speed = moveSpeed * this.speedMultiplier * screenSpeedMultiplier(direction) * ratio;
        desired = { x: direction.x * speed + context.separation.x * moveSpeed,
          z: direction.z * speed + context.separation.z * moveSpeed };
        // SmoothMoveTowardWithAvoidance faces the target's transform or its
        // requested movement direction, before velocity smoothing/separation.
        facingDirection = targetCenter
          ? { x: targetCenter.x - p.position.x, z: targetCenter.z - p.position.z }
          : direction;
      }
    }
    if (drift) {
      const direction = normalize(context.separation), speed = moveSpeed * drift * screenSpeedMultiplier(direction);
      desired = { x: direction.x * speed, z: direction.z * speed };
    }
    const factor = clamp01(dt * C.velocitySmoothing);
    p.velocity.x += (desired.x - p.velocity.x) * factor;
    p.velocity.z += (desired.z - p.velocity.z) * factor;
    p.moving = !!destination || drift > 0 || p.velocity.x ** 2 + p.velocity.z ** 2 >= C.autoStopSquaredSpeed;
    if (!p.moving) p.velocity = { x: 0, z: 0 };
    const aim = target ? { x: target.x - p.position.x, z: target.z - p.position.z } : p.velocity;
    if (length(aim) > 0.0001) p.aim = normalize(aim);
    // SmoothStop and ApplySeparationDrift leave body facing unchanged.
    if (facingDirection) p.facing = facingDirection.x + facingDirection.z > 0 ? 1 : -1;
  }

  private approach(target: Vec2, stopDistance: number): Vec2 {
    const delta = { x: this.player.position.x - target.x, z: this.player.position.z - target.z };
    // GetApproachPosition and AIReposition test the unnormalized squared
    // distance, then use Vector3.right (static offset 0x3c) for near ties.
    const away = delta.x * delta.x + delta.z * delta.z < C.retreatDirectionSquaredThreshold
      ? { x: 1, z: 0 } : normalize(delta);
    return { x: target.x + away.x * stopDistance, z: target.z + away.z * stopDistance };
  }
}
