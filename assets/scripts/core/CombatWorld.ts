import { COMBAT_CONFIG as C } from './config';
import { generateFirstMap } from './map';
import { clamp, clamp01, closestPoint, distance, length, normalize, Random, rayAABB, sweepCircleAABB } from './math';
import { CAMERA_BASIS, screenSpeedMultiplier } from './projection';
import { DecimalAmount } from './DecimalAmount';
import { BulletState, CombatEvent, CombatModifiers, CombatStats, Damageable, MuzzleProvider, PlayerState, TreeState, Vec2 } from './types';

const copy = (p: Vec2): Vec2 => ({ x: p.x, z: p.z });
const ATTACK_RAYS: readonly Vec2[] = Array.from({ length: C.rayCount }, (_, ray) => {
  const angle = ray * Math.PI * 2 / C.rayCount;
  return { x: Math.sin(angle), z: Math.cos(angle) };
});
const BASE_DAMAGE = DecimalAmount.from(C.damage);
function maximumSpread(interval: number): number {
  const blend = 1 - clamp01((Math.log(Math.max(0.05, interval)) + Math.log(20)) / Math.log(40));
  return C.spreadMinimum + (C.spreadMaximum - C.spreadMinimum) * blend;
}

/** Seeded simulation with frame-driven Cat.Update and the source fixed physics step. */
export class CombatWorld {
  readonly player: PlayerState = {
    position: { x: 0, z: 0 }, velocity: { x: 0, z: 0 }, facing: 1,
    aim: { x: 0, z: 1 }, moving: false, targetId: null,
  };
  readonly trees: TreeState[] = [];
  readonly bullets: BulletState[] = [];
  readonly stats: CombatStats = { shots: 0, hits: 0, kills: 0, totalTrees: C.treeCount, elapsed: 0, complete: false };
  private events: CombatEvent[] = [];
  private random = new Random(1);
  private seed = 1;
  private physicsAccumulator = 0;
  private frameTime = 0;
  private physicsTime = 0;
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
  private aspect: number = C.defaultAspect;
  private muzzleOffset: Vec2 | null = null;
  private muzzleProvider: MuzzleProvider | null = null;
  private damage = BASE_DAMAGE;
  private attackInterval: number = C.attackInterval;
  private maximumSpread = maximumSpread(C.attackInterval);

  constructor(seed = 1) { this.reset(seed); }

  get isPaused(): boolean { return this.paused; }
  get cameraAnchor(): Vec2 { return this.player.position; }
  /** Scaled frame clock also advances after the stage counter stops. */
  get simulationTime(): number { return this.frameTime; }

  /** Cat.Balance_Reload updates AtkCool_Max without resetting AtkCool_Now.
   * Keep this state across round resets, just like the session upgrades. */
  setCombatModifiers(modifiers: CombatModifiers): void {
    if (modifiers.damage.compare(0) <= 0 || !Number.isFinite(modifiers.attackInterval) || modifiers.attackInterval <= 0) {
      throw new Error('Invalid combat modifiers');
    }
    this.damage = modifiers.damage;
    this.attackInterval = clamp(modifiers.attackInterval, 0.05, 2);
    this.maximumSpread = maximumSpread(this.attackInterval);
    // Balance_Reload resets _spreadAngle for every upgrade, including money.
    this.spread = 0;
  }

  /** Width / height of the actual gameplay viewport, after safe-area fitting. */
  setViewport(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) this.aspect = aspect;
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

  reset(seed = this.seed): void {
    this.seed = seed >>> 0;
    this.random = new Random(this.seed ^ 0x9e3779b9);
    this.trees.splice(0, this.trees.length, ...generateFirstMap(this.seed));
    this.player.position = { x: 0, z: 0 };
    this.player.velocity = { x: 0, z: 0 };
    this.player.facing = 1;
    this.player.aim = { x: 0, z: 1 };
    this.player.moving = false;
    this.player.targetId = null;
    if (!this.bullets.length) {
      for (let id = 0; id < C.bulletPoolSize; id++) this.bullets.push({
        id, active: false, damaging: false, position: { x: 0, z: 0 }, previousPosition: { x: 0, z: 0 },
        direction: { x: 0, z: 0 }, age: 0, life: C.bulletLifetime, trailTime: 0, traveled: 0, damage: BASE_DAMAGE,
      });
    }
    for (const bullet of this.bullets) this.clearBullet(bullet);
    Object.assign(this.stats, { shots: 0, hits: 0, kills: 0, totalTrees: this.trees.length, elapsed: 0, complete: false });
    this.attackSearchTimer = this.autoSearchTimer = this.attackClock = this.spread = 0;
    this.autoTargetId = null;
    this.lockedAttackTargetId = null;
    this.nearHitPoint = { x: 0, z: 0 };
    this.physicsAccumulator = 0;
    this.frameTime = 0;
    this.physicsTime = 0;
    this.bulletPoolCursor = 0;
    this.bulletTimeouts.clear();
    this.previouslyHadTarget = false;
    this.muzzleOffset = null;
    this.events.length = 0;
    this.paused = false;
  }

  pause(): void { this.paused = true; this.physicsAccumulator = 0; }
  resume(): void { this.paused = false; this.physicsAccumulator = 0; }

  drainEvents(): CombatEvent[] {
    const result = this.events;
    this.events = [];
    return result;
  }

  /** One call per rendered frame, using Unity's maximum delta. Pause excludes background time. */
  step(dt: number): void {
    if (this.paused || !Number.isFinite(dt) || dt <= 0) return;
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
      this.moveAndSlide({ x: this.player.velocity.x * C.physicsStep, z: this.player.velocity.z * C.physicsStep });
      this.updateBullets(C.physicsStep);
    }
    this.updateBulletTimeouts();
    if (!this.stats.complete) {
      this.attackSearchTimer += dt;
      if (this.attackSearchTimer + 1e-10 >= C.attackSearchInterval) {
        this.attackSearchTimer = 0;
        this.player.targetId = this.findRayTarget()?.id ?? null;
      }
      // Resolve uses LAST Update's auto target. HandleAutoMove reselects only
      // afterwards, so an auto target change takes effect on attack next tick.
      this.resolveAttackTarget();
      // Cat.UpdateSpreadState resets both spread and the attack clock only on
      // the no-target -> target transition, not when switching between targets.
      const hasTarget = this.player.targetId !== null;
      if (hasTarget && !this.previouslyHadTarget) this.spread = this.attackClock = 0;
      if (!hasTarget) this.spread = Math.max(0, this.spread - Math.max(1, this.maximumSpread) * C.spreadDecayMultiplier * dt);
      this.previouslyHadTarget = hasTarget;
      this.updateAutoTarget(dt);
      this.movePlayer(dt);
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
    } else this.sampleMuzzle(dt);
  }

  private sampleMuzzle(dt: number, target?: Damageable, attackFacing?: -1 | 1): void {
    if (!this.muzzleProvider) return;
    const offset = this.muzzleProvider({ dt, player: this.player,
      targetPoint: target ? copy(this.nearHitPoint) : null, attackFacing });
    this.muzzleOffset = offset && Number.isFinite(offset.x) && Number.isFinite(offset.z) ? copy(offset) : null;
  }

  private getTree(id: number | null): TreeState | undefined {
    return id === null ? undefined : this.trees.find(tree => tree.id === id);
  }

  private colliderCenter(tree: Damageable): Vec2 {
    return { x: (tree.collider.minX + tree.collider.maxX) / 2, z: (tree.collider.minZ + tree.collider.maxZ) / 2 };
  }

  private isVisible(tree: Damageable): boolean {
    // IsOnScreen receives the Collider Transform (tree root + [-2,0,+2]),
    // not the tree root, Bounds center or SpriteRenderer bounds.
    const centerX = (tree.collider.minX + tree.collider.maxX) / 2;
    const centerZ = (tree.collider.minZ + tree.collider.maxZ) / 2;
    const projectedX = CAMERA_BASIS.rightX * centerX + CAMERA_BASIS.rightZ * centerZ;
    const projectedY = CAMERA_BASIS.upX * centerX + CAMERA_BASIS.upZ * centerZ;
    const cameraX = CAMERA_BASIS.rightX * this.player.position.x + CAMERA_BASIS.rightZ * this.player.position.z;
    const cameraY = CAMERA_BASIS.upX * this.player.position.x + CAMERA_BASIS.upZ * this.player.position.z;
    const depth = (centerX - this.player.position.x - C.cameraPosition.x) * CAMERA_BASIS.forwardX -
      C.cameraPosition.y * CAMERA_BASIS.forwardY +
      (centerZ - this.player.position.z - C.cameraPosition.z) * CAMERA_BASIS.forwardZ;
    return depth > 0 && Math.abs(projectedX - cameraX - C.cameraOffsetX) <= C.cameraHalfHeight * this.aspect * (1 + 2 * C.viewportMargin) &&
      Math.abs(projectedY - cameraY - C.cameraOffsetY) <= C.cameraHalfHeight * (1 + 2 * C.viewportMargin);
  }

  private isValidTarget(tree?: Damageable): boolean { return !!tree?.alive && this.isVisible(tree); }

  private targetRange(tree: Damageable): number {
    // Ray_trans.y=2; Collider Transform.y=0 (its Box center.y=3 is unrelated).
    return Math.hypot(distance(this.player.position, this.colliderCenter(tree)), C.rayHeight);
  }

  private resolveAttackTarget(): void {
    const auto = this.getTree(this.autoTargetId);
    if (this.isValidTarget(auto)) {
      this.nearHitPoint = closestPoint(this.player.position, auto!.collider);
      this.player.targetId = this.lockedAttackTargetId = this.targetRange(auto!) <= C.attackRange ? auto!.id : null;
      return;
    }
    const locked = this.getTree(this.lockedAttackTargetId);
    if (this.isValidTarget(locked) && this.targetRange(locked!) <= C.attackRange) {
      this.player.targetId = locked!.id;
    } else this.lockedAttackTargetId = this.player.targetId;
    // Source fallback tests Object!=null only, even for a recently disabled
    // Collider. Its transform can survive until the next ray/auto selection.
    const near = this.getTree(this.player.targetId);
    if (near) this.nearHitPoint = this.colliderCenter(near);
  }

  private updateAutoTarget(dt: number): void {
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

  private findRayTarget(): TreeState | undefined {
    let best: TreeState | undefined;
    let bestDistance = Infinity;
    for (const direction of ATTACK_RAYS) {
      let firstTree: TreeState | undefined;
      let firstDistance = Infinity;
      for (const tree of this.trees) {
        if (!tree.alive) continue;
        // Physics.Raycast ignores colliders containing its origin. Ray.y=2
        // lies within the source tree box's height range [0,6].
        const p = this.player.position, box = tree.collider;
        if (p.x > box.minX && p.x < box.maxX && p.z > box.minZ && p.z < box.maxZ) continue;
        const hit = rayAABB(this.player.position, direction, C.attackRange, tree.collider);
        if (hit !== null && hit < firstDistance) { firstDistance = hit; firstTree = tree; }
      }
      // A ray cannot select a farther target through an off-screen foreground collider.
      if (firstTree && this.isVisible(firstTree) && firstDistance < bestDistance) {
        bestDistance = firstDistance; best = firstTree;
      }
    }
    return best;
  }

  private findAutoTarget(): TreeState | undefined {
    let result: TreeState | undefined;
    let bestScore = Infinity;
    for (const tree of this.trees) {
      if (!tree.alive) continue;
      const d = distance(this.player.position, tree.position);
      const score = d + (d > C.autoNearbyRadius ? C.autoZWeight * Math.max(0, tree.position.z - this.player.position.z) : 0);
      if (score < bestScore) { bestScore = score; result = tree; }
    }
    return result;
  }

  private movePlayer(dt: number): void {
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
        const speed = C.playerSpeed * speedRatio * screenSpeedMultiplier(direction);
        desiredVelocity = { x: direction.x * speed, z: direction.z * speed };
      }
      if (facingPoint) this.player.facing = this.facingToward(facingPoint);
    }
    const factor = clamp01(dt * C.velocitySmoothing);
    this.player.velocity.x += (desiredVelocity.x - this.player.velocity.x) * factor;
    this.player.velocity.z += (desiredVelocity.z - this.player.velocity.z) * factor;
    // Main Cat.HandleAutoMove sets Walk from its movement branch. Its stop
    // branch starts Idle immediately while AutoSmoothStop still decelerates.
    this.player.moving = moving;
    const v = this.player.velocity;
    if (!this.player.moving && v.x * v.x + v.z * v.z < C.autoStopSquaredSpeed) this.player.velocity = { x: 0, z: 0 };
  }

  private moveAndSlide(displacement: Vec2): void {
    let remaining = copy(displacement);
    for (let attempt = 0; attempt < 4 && length(remaining) > 1e-7; attempt++) {
      const start = this.player.position;
      const end = { x: start.x + remaining.x, z: start.z + remaining.z };
      let earliest: ReturnType<typeof sweepCircleAABB> = null;
      for (const tree of this.trees) {
        if (!tree.alive) continue;
        const hit = sweepCircleAABB(start, end, C.playerRadius, tree.collider);
        if (hit && (!earliest || hit.time < earliest.time)) earliest = hit;
      }
      if (!earliest) { this.player.position = end; break; }
      const safeTime = Math.max(0, earliest.time - 0.0001);
      this.player.position = { x: start.x + remaining.x * safeTime, z: start.z + remaining.z * safeTime };
      remaining.x *= 1 - earliest.time;
      remaining.z *= 1 - earliest.time;
      const into = remaining.x * earliest.normal.x + remaining.z * earliest.normal.z;
      if (into < 0) {
        remaining.x -= earliest.normal.x * into;
        remaining.z -= earliest.normal.z * into;
      }
    }
    this.player.position.x = clamp(this.player.position.x, C.mapMinX + C.playerRadius, C.mapMaxX - C.playerRadius);
    this.player.position.z = clamp(this.player.position.z, C.mapMinZ + C.playerRadius, C.mapMaxZ - C.playerRadius);
  }

  private fire(): boolean {
    const aim = this.player.aim;
    const muzzle = this.muzzleOffset ?? { x: aim.x * C.muzzleDistance, z: aim.z * C.muzzleDistance };
    const position = { x: this.player.position.x + muzzle.x, z: this.player.position.z + muzzle.z };
    // Cat.Attack passes GetFirePosition and nearHitPoint to CalcBulletDir.
    // A muzzle displaced by animation must not fire parallel to the cat's aim.
    const target = this.getTree(this.player.targetId);
    const targetPoint = target ? this.nearHitPoint : null;
    const delta = targetPoint ? { x: targetPoint.x - position.x, z: targetPoint.z - position.z } : aim;
    const base = length(delta) > 0.01 ? normalize(delta) : { x: 0, z: 1 };
    // Source Attack samples critical chance before ApplySpread even at CriPer=0.
    this.random.next();
    const angle = this.spread >= C.spreadSampleThreshold ? this.random.range(-this.spread, this.spread) * Math.PI / 180 : 0;
    // Unity Quaternion.Euler(0, yaw, 0) on an XZ direction.
    const direction = { x: base.x * Math.cos(angle) + base.z * Math.sin(angle), z: -base.x * Math.sin(angle) + base.z * Math.cos(angle) };
    // Attack samples critical/spread before TrySpawnBulletEx can fail. The
    // source pool cycles through inactive objects, then reclaims dead trails.
    const bullet = this.borrowBullet();
    if (!bullet) return false;
    this.clearBullet(bullet);
    bullet.position = position;
    bullet.previousPosition = copy(bullet.position);
    bullet.direction = direction;
    bullet.active = true;
    bullet.damaging = true;
    bullet.damage = this.damage;
    // SpawnEx schedules Destroy using scaled frame time; MaxTravelDistance
    // limits this delay, rather than clamping a physics displacement.
    this.bulletTimeouts.set(bullet.id, this.frameTime + Math.min(bullet.life, C.bulletMaxDistance / Math.max(C.bulletSpeed, 0.1)));
    this.stats.shots++;
    this.events.push({ type: 'shot', position: copy(bullet.position), bulletId: bullet.id, direction: copy(direction) });
    this.spread += (this.maximumSpread - this.spread) * C.spreadGrowth;
    return true;
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
      if (bullet.damaging) this.stopBullet(bullet);
      else this.clearBullet(bullet);
    }
  }

  private updateBullets(dt: number): void {
    for (const bullet of this.bullets) {
      if (!bullet.active || !bullet.damaging) continue;
      bullet.age += dt;
      bullet.previousPosition = copy(bullet.position);
      const travel = C.bulletSpeed * dt;
      const end = { x: bullet.position.x + bullet.direction.x * travel, z: bullet.position.z + bullet.direction.z * travel };
      let hitTree: TreeState | undefined;
      let hitWall: typeof C.bulletWalls[number] | undefined;
      let hitTime = Infinity;
      for (const tree of this.trees) {
        if (!tree.alive) continue;
        const hit = sweepCircleAABB(bullet.position, end, C.bulletRadius, tree.collider);
        if (hit && hit.time < hitTime) { hitTime = hit.time; hitTree = tree; }
      }
      for (const wall of C.bulletWalls) {
        const hit = sweepCircleAABB(bullet.position, end, C.bulletRadius, wall);
        if (hit && hit.time < hitTime) { hitTime = hit.time; hitTree = undefined; hitWall = wall; }
      }
      if (hitTree || hitWall) {
        bullet.position = { x: bullet.position.x + (end.x - bullet.position.x) * hitTime, z: bullet.position.z + (end.z - bullet.position.z) * hitTime };
        bullet.traveled += travel * hitTime;
        // OnTriggerEnter projects the previous physics position onto the hit
        // collider (current - velocity * fixedDeltaTime), not the swept TOI.
        if (hitTree) this.hitTree(hitTree, closestPoint(bullet.previousPosition, hitTree.collider), bullet.damage);
        else this.events.push({ type: 'impact', position: closestPoint(bullet.previousPosition, hitWall!) });
        this.stopBullet(bullet);
      } else {
        bullet.position = end;
        bullet.traveled += travel;
      }
    }
  }

  private hitTree(tree: Damageable, position: Vec2, damage: DecimalAmount): void {
    if (!tree.alive) return;
    // This map's finite tree HP need not be converted to Infinity when damage
    // grows beyond Number's range. The event retains the full original amount.
    tree.health = damage.compare(tree.health) >= 0 ? 0 : DecimalAmount.from(tree.health).sub(damage).toNumber();
    this.stats.hits++;
    this.events.push({ type: 'hit', position: copy(position), sourceTime: this.physicsTime,
      treeId: tree.id, damage, health: tree.health, maxHealth: tree.maxHealth });
    if (tree.health === 0) {
      tree.alive = false;
      this.stats.kills++;
      this.events.push({ type: 'treeDied', position: copy(tree.position), treeId: tree.id, sourceTime: this.physicsTime });
      // Unity disables the tree but retains Collider/Transform references.
      // The next ResolveAttackTarget / HandleAutoMove decides when to replace them.
      if (this.stats.kills === this.stats.totalTrees) {
        this.stats.complete = true;
        this.player.velocity = { x: 0, z: 0 };
        this.player.moving = false;
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
  }
}
