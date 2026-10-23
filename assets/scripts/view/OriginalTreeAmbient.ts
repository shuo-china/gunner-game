import { Color, gfx, Node, Sprite, UITransform } from 'cc';
import { BulletState, DecimalAmount } from '../core';
import { ArtLibrary } from './ArtLibrary';
import { OriginalParticleSimulation, ParticlePose, ParticleSpec } from './OriginalParticleSimulation';

/** BossTree/Pivot/Tinysparkles uses the same Unity particle modules as projectiles.
 * A stationary, zero-height emitter adapts that visual simulator to the tree's
 * local world coordinates. It is never inserted into CombatWorld.bullets.
 */
export class OriginalTreeAmbient {
  private readonly simulation: OriginalParticleSimulation;
  private readonly views: Array<{node: Node; sprite: Sprite; transform: UITransform}> = [];
  private readonly pose: ParticlePose = {x: 0, y: 0, width: 0, height: 0, angle: 0, color: []};
  private readonly color = new Color();
  private readonly emitter: BulletState = {
    id: 0, active: true, damaging: true, position: {x: 0, z: 0}, previousPosition: {x: 0, z: 0},
    direction: {x: 0, z: 1}, age: 0, life: Infinity, trailTime: 0, traveled: 0,
    damage: DecimalAmount.from(0), actorId: 0, weaponId: 0, weaponType: 'SINGLE', critical: false,
    volleyId: 0, pelletIndex: 0, height: 0, speed: 0, explosionRadius: 0, hitIds: [], pierceCount: 0,
    hasExploded: false, hasEnemyImpactFx: false, missileStart: null, missileTarget: null,
    missileDuration: 0, missileArcHeight: 0,
  };
  private readonly emitters = [this.emitter];

  constructor(art: ArtLibrary, parent: Node, spec: ParticleSpec) {
    this.simulation = new OriginalParticleSimulation([spec]);
    for (const particle of this.simulation.particles) {
      const node = art.image('Tinysparkles_' + particle.index, spec.image, parent);
      const sprite = node.getComponent(Sprite)!;
      const blend = sprite as unknown as {srcBlendFactor: number; _dstBlendFactor: number; updateMaterial(): void};
      blend.srcBlendFactor = spec.blend.source === 1 ? gfx.BlendFactor.ONE : gfx.BlendFactor.SRC_ALPHA;
      blend._dstBlendFactor = spec.blend.destination === 1 ? gfx.BlendFactor.ONE : gfx.BlendFactor.ONE_MINUS_SRC_ALPHA;
      blend.updateMaterial(); node.active = false;
      this.views.push({node, sprite, transform: node.getComponent(UITransform)!});
    }
  }

  update(dt: number): void {
    this.emitter.age += Math.max(0, dt);
    this.simulation.update(dt, this.emitters);
    for (const particle of this.simulation.particles) {
      const view = this.views[particle.index];
      view.node.active = particle.active;
      if (!particle.active) continue;
      const pose = this.simulation.pose(particle, this.pose);
      view.node.setPosition(pose.x, pose.y, 0); view.node.angle = pose.angle;
      view.transform.setContentSize(pose.width, pose.height);
      const c = pose.color, byte = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
      this.color.set(byte(c[0]), byte(c[1]), byte(c[2]), byte(c[3])); view.sprite.color = this.color;
    }
  }

  reset(): void {
    this.emitter.age = 0; this.simulation.reset();
    for (const view of this.views) view.node.active = false;
  }
}
