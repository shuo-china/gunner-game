import { EffectAsset, Material, Node, Sprite, Vec4 } from 'cc';
import type { BulletState } from '../core';
import { ArtLibrary } from './ArtLibrary';
import { OriginalParticleMesh } from './OriginalParticleMesh';
import {
  CustomProjectileProfile, ProjectileGeometry, ProjectileHead, ProjectileSample, RibbonPoint,
  fillPressureFront, fillProjectileBody, fillRibbon, pressureGeometry, projectileBodyPose,
  projectileGeometry, projectileGrowth, ribbonGeometry, ribbonPoints, sampleRibbon,
} from './CustomProjectileMotion';

interface MeshView { node: Node; geometry: ProjectileGeometry; mesh: OriginalParticleMesh }
interface Emitter {
  id: number; seen: boolean; stoppedFor: number; active: boolean; last: ProjectileHead;
  history: ProjectileSample[]; samples: ProjectileSample[];
  body: MeshView; ghost?: MeshView; air?: MeshView; outer?: MeshView; core?: MeshView;
  outerPoints: RibbonPoint[]; corePoints: RibbonPoint[];
  contact?: { x: number; z: number; height: number; remaining: number };
}
const sample = (): ProjectileSample => ({ x: 0, z: 0, height: 0, age: 0, traveled: 0 });

/** Approved arrow pressure surface and continuous shuriken ribbon. These views
 * follow real combat bullets; they never simulate another damaging projectile. */
export class CustomProjectiles {
  private readonly emitters = new Map<number, Emitter>();
  private readonly bodyMaterial: Material;
  private readonly effectMaterial: Material;
  private readonly scratch = sample();

  constructor(private readonly art: ArtLibrary, readonly profile: CustomProjectileProfile,
    private readonly layer: (order: number) => Node, effect: EffectAsset) {
    this.effectMaterial = new Material(); this.effectMaterial.initialize({ effectAsset: effect });
    this.bodyMaterial = new Material(); this.bodyMaterial.initialize({ effectAsset: effect });
    const palette = profile.bodyPalette;
    if (palette) {
      const vec = (values: readonly number[], w = 1): Vec4 => new Vec4(values[0], values[1], values[2], w);
      this.bodyMaterial.setProperty('paletteShadow', vec(palette.shadow, palette.strength));
      this.bodyMaterial.setProperty('paletteMid', vec(palette.mid));
      this.bodyMaterial.setProperty('paletteHighlight', vec(palette.highlight));
    }
  }

  shot(id: number): void { const emitter = this.emitters.get(id); if (emitter) this.clear(emitter); }
  clearEmitter(id: number): void { this.shot(id); }
  contact(id: number, position: { x: number; z: number }, height: number): void {
    // Only an accepted collision can produce this final arrow pose. A timeout
    // must still disappear normally, and spinning/penetrating bodies keep moving.
    if (this.profile.anchor !== 'tip' || this.profile.spinSpeed !== 0) return;
    let emitter = this.emitters.get(id);
    if (!emitter) { emitter = this.createEmitter(id); this.emitters.set(id, emitter); }
    emitter.contact = { ...position, height, remaining: .05 };
  }
  update(dt: number, bullets: readonly BulletState[]): void {
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    for (const emitter of this.emitters.values()) emitter.seen = false;
    for (const bullet of bullets) {
      let emitter = this.emitters.get(bullet.id);
      // Impacts can retire a shot before the first rendered frame. Do not show
      // a projectile body or fabricate a path for an already stopped bullet.
      if (!emitter && !bullet.damaging) continue;
      if (!emitter) { emitter = this.createEmitter(bullet.id); this.emitters.set(bullet.id, emitter); }
      emitter.seen = true;
      if (bullet.damaging) {
        emitter.contact = undefined;
        if (!emitter.active || bullet.age < emitter.last.age || bullet.traveled < emitter.last.traveled) this.clear(emitter);
        const head = emitter.last;
        head.x = bullet.position.x; head.z = bullet.position.z; head.height = bullet.height;
        head.age = bullet.age; head.traveled = bullet.traveled; head.dx = bullet.direction.x; head.dz = bullet.direction.z; head.speed = bullet.speed;
        emitter.active = true; emitter.stoppedFor = 0;
        if (this.profile.cometTrail) this.record(emitter);
        this.render(emitter, true);
      } else if (emitter.contact && emitter.contact.remaining > 0) {
        const head = emitter.last, contact = emitter.contact;
        head.x = contact.x; head.z = contact.z; head.height = contact.height;
        head.age = bullet.age; head.traveled = bullet.traveled; head.dx = bullet.direction.x; head.dz = bullet.direction.z; head.speed = bullet.speed;
        emitter.active = true; this.render(emitter, false, true); contact.remaining -= dt;
      } else if (emitter.active) {
        // The collision point is newer than the final damaging render frame.
        const head = emitter.last;
        if (bullet.age > head.age || bullet.traveled > head.traveled) {
          head.x = bullet.position.x; head.z = bullet.position.z; head.height = bullet.height;
          head.age = bullet.age; head.traveled = bullet.traveled;
          if (this.profile.cometTrail) this.record(emitter);
        }
        emitter.stoppedFor = emitter.body.node.active ? 0 : emitter.stoppedFor + dt; this.render(emitter, false);
      }
    }
    for (const emitter of this.emitters.values()) if (!emitter.seen && emitter.active) {
      emitter.stoppedFor = emitter.body.node.active ? 0 : emitter.stoppedFor + dt; this.render(emitter, false);
    }
  }
  reset(): void { for (const emitter of this.emitters.values()) this.clear(emitter); }
  get hasActiveParticles(): boolean { for (const emitter of this.emitters.values()) if (emitter.active) return true; return false; }
  diagnostics(): { pooled: number; active: number } {
    let pooled = 0, active = 0;
    for (const emitter of this.emitters.values()) for (const view of this.views(emitter)) { pooled++; if (view.node.active) active++; }
    return { pooled, active };
  }
  destroy(): void {
    for (const emitter of this.emitters.values()) for (const view of this.views(emitter)) if (view.node.isValid) view.node.destroy();
    this.emitters.clear(); this.bodyMaterial.destroy(); this.effectMaterial.destroy();
  }
  private createEmitter(id: number): Emitter {
    const p = this.profile, path = p.sprite.path;
    const quad = (): ProjectileGeometry => projectileGeometry(4, [0, 1, 2, 2, 1, 3]);
    // The source projectile sorting band is 10-14; put the continuous tail
    // behind its spinning body and keep hits in their existing order 40+.
    const outer = p.cometTrail ? this.view(id, 'tail', p.cometTrail.image.path, ribbonGeometry(), 11) : undefined;
    const core = p.cometTrail ? this.view(id, 'tail-core', p.cometTrail.image.path, ribbonGeometry(), 12) : undefined;
    const air = p.airFlow ? this.view(id, 'pressure', p.airFlow.image.path, pressureGeometry(), 13) : undefined;
    const ghost = p.afterimage ? this.view(id, 'afterimage', path, quad(), 14, true) : undefined;
    const body = this.view(id, 'body', path, quad(), 14, true);
    return { id, seen: false, stoppedFor: 0, active: false, last: { ...sample(), dx: 0, dz: 0, speed: 0 },
      history: [], samples: [], body, ghost, air, outer, core, outerPoints: ribbonPoints(), corePoints: ribbonPoints() };
  }
  private view(id: number, name: string, path: string, geometry: ProjectileGeometry, order: number, painted = false): MeshView {
    const node = this.art.image(`Projectile_${id}_${name}`, { path, sizePx: [1, 1], sizeUnits: [1, 1], anchor: [.5, .5] }, this.layer(order));
    const sprite = node.getComponent(Sprite)!; sprite.customMaterial = painted ? this.bodyMaterial : this.effectMaterial;
    const mesh = new OriginalParticleMesh(sprite, geometry); node.active = false;
    return { node, geometry, mesh };
  }
  private record(emitter: Emitter): void {
    const head = emitter.last, history = emitter.history;
    if (!history.length) {
      // Reconstruct the exact straight launch segment when a render frame
      // contains multiple physics steps. Both custom profiles are linear.
      const start = emitter.samples.pop() ?? sample(); Object.assign(start, head);
      start.x -= head.dx * head.traveled; start.z -= head.dz * head.traveled; start.age = 0; start.traveled = 0;
      history.push(start);
    }
    const previous = history[history.length - 1];
    if (head.age === previous.age && head.traveled === previous.traveled) return;
    const next = emitter.samples.pop() ?? sample();
    next.x = head.x; next.z = head.z; next.height = head.height; next.age = head.age; next.traveled = head.traveled; history.push(next);
    const cutoff = head.age - (this.profile.cometTrail?.lifetime ?? .18) * 1.5;
    // Keep one sample on either side of the oldest needed distance.
    while (history.length > 2 && history[1].age < cutoff) emitter.samples.push(history.shift()!);
    while (history.length > 128) emitter.samples.push(history.shift()!);
  }
  private render(emitter: Emitter, damaging: boolean, contact = false): void {
    const p = this.profile, head = emitter.last;
    emitter.body.node.active = damaging || contact;
    if (emitter.ghost) emitter.ghost.node.active = damaging;
    if (emitter.air) emitter.air.node.active = damaging;
    if (damaging || contact) {
      const pose = projectileBodyPose(p, head);
      fillProjectileBody(emitter.body.geometry, p, pose); emitter.body.mesh.updateProjected();
      if (emitter.ghost && p.afterimage) {
        const growth = projectileGrowth(p, head.age);
        fillProjectileBody(emitter.ghost.geometry, p, pose, p.afterimage.alpha * (.35 + .65 * growth),
          pose.angle + p.afterimage.angleLag * (.45 + .55 * growth)); emitter.ghost.mesh.updateProjected();
      }
      if (emitter.air && damaging) { fillPressureFront(emitter.air.geometry, p, head, pose); emitter.air.mesh.updateProjected(); }
    }
    if (p.cometTrail && emitter.outer && emitter.core) {
      const count = sampleRibbon(p, head, emitter.history, emitter.stoppedFor, emitter.outerPoints, emitter.corePoints, this.scratch);
      emitter.outer.node.active = emitter.core.node.active = count > 0;
      if (count) {
        fillRibbon(emitter.outer.geometry, emitter.outerPoints, count, p.cometTrail.outerColor); emitter.outer.mesh.updateProjected();
        fillRibbon(emitter.core.geometry, emitter.corePoints, count, p.cometTrail.innerColor); emitter.core.mesh.updateProjected();
      }
    }
    if (!damaging && !contact && (!p.cometTrail || emitter.stoppedFor >= p.cometTrail.lifetime)) this.clear(emitter);
  }
  private clear(emitter: Emitter): void {
    emitter.contact = undefined;
    emitter.active = false; emitter.stoppedFor = 0;
    emitter.samples.push(...emitter.history); emitter.history.length = 0;
    for (const view of this.views(emitter)) view.node.active = false;
  }
  private views(emitter: Emitter): MeshView[] {
    return [emitter.body, emitter.ghost, emitter.air, emitter.outer, emitter.core].filter((v): v is MeshView => !!v);
  }
}
