import { Color, gfx, Node, Sprite, UITransform } from 'cc';
import { projectWorld } from '../core/projection';
import { ArtLibrary, ImageSpec, makeNode } from './ArtLibrary';
import { sampleCatChannel, CatCurveKey, catRecoilWeight } from './OriginalCatAnimation';
import { OriginalParticleSimulation, ParticlePose, ParticleSpec } from './OriginalParticleSimulation';

interface Transform { position: number[]; scale: number[]; rotation: number[]; source: string; }
interface RaidBossPart { name: string; image: ImageSpec; transform: Transform; order: number; color: number[]; }
export interface RaidVisualConfig {
  version: number;
  ground: ImageSpec & { transform: Transform; tiling: [number, number]; clipRadius: number };
  skins: { transform: Transform; parts: RaidBossPart[] }[];
  idle: { duration: number; channels: Record<string, CatCurveKey[]>; bindings: { part: string; property: 'position' | 'scale' | 'euler'; firstChannel: number }[] };
  bounce: { scale: number; duration: number };
  worldOrigin: number[]; bossPosition: number[];
  portalParticles: ParticleSpec[]; bossDeathParticles: ParticleSpec[];
}
interface RaidBossState { position: { x: number; z: number }; alive: boolean; level?: number; }
interface PartInstance { spec: RaidBossPart; plane: Node; image: Node; }

/** Raid（突袭）boss enemy artwork, not the separate Boss gameplay module.
 * Source RaidBoss/Bounce/0..4 and clip271. Part motion remains in Unity XYZ;
 * billboard projection happens only after evaluating the original cubic curves. */
export class RaidBossView {
  readonly node: Node;
  private readonly bounce: Node;
  private readonly partRoots = new Map<number, Node>();
  private readonly deathRoot: Node;
  private readonly config: RaidVisualConfig;
  private parts: PartInstance[] = [];
  private skin = -1;
  private clock = 0;
  private hitClock = Infinity;
  private hitYield = false;
  private previousLevel = 1;
  private readonly death: RaidDeathParticles;
  private visible = true;
  private alive = true;

  constructor(private readonly art: ArtLibrary, raidBoss: RaidBossState, parent: Node, skin = 0,
    private readonly layerForOrder?: (order: number) => Node) {
    this.config = art.catalog.raid;
    if (!this.config || this.config.skins.length !== 5) throw new Error('Missing original Raid boss artwork');
    this.node = makeNode('RaidBoss', parent);
    this.bounce = makeNode('Bounce_Custom', this.node);
    this.deathRoot = makeNode('GibletExplodeDirt', this.layerForOrder?.(this.config.bossDeathParticles[0].sortingOrder) ?? this.node);
    this.death = new RaidDeathParticles(art, this.deathRoot, this.config.bossDeathParticles);
    this.previousLevel = raidBoss.level ?? 1;
    this.setSkin(skin); this.update(0, raidBoss);
  }
  hit(): void {
    if (this.hitClock >= this.config.bounce.duration) this.hitYield = true;
    this.hitClock = 0;
  }
  setActive(active: boolean): void { this.visible = active; this.syncVisibility(); }
  update(dt: number, raidBoss: RaidBossState, skin = this.skin): void {
    this.setSkin(skin);
    const p = projectWorld(raidBoss.position); this.node.setPosition(p.x, p.y, 0);
    this.alive = raidBoss.alive; this.syncVisibility();
    if (this.layerForOrder) this.deathRoot.setPosition(p.x, p.y, 0);
    if (!raidBoss.alive) return;
    const elapsed = Math.max(0, dt); this.clock += elapsed;
    const level = raidBoss.level ?? this.previousLevel;
    for (let i = this.previousLevel; i < level; i++) this.death.play();
    this.previousLevel = level; this.death.update(elapsed);
    if (this.hitYield) this.hitYield = false; else this.hitClock += elapsed;
    const scale = 1 + (this.config.bounce.scale - 1) * catRecoilWeight(this.hitClock, this.config.bounce.duration);
    this.bounce.setScale(scale, scale, 1);
    // Source Raid parts have no SortingGroup: Default5/6 must remain between
    // other world orders. Replicate the parent transforms on each external band.
    if (this.layerForOrder) for (const root of this.partRoots.values()) {
      root.setPosition(p.x, p.y, 0); root.setScale(scale, scale, 1);
    }
    const time = this.clock % this.config.idle.duration;
    for (const part of this.parts) {
      const position = part.spec.transform.position.slice(), size = part.spec.transform.scale.slice();
      let angle = 0;
      for (const binding of this.config.idle.bindings) {
        if (binding.part !== part.spec.name) continue;
        const values = [0, 1, 2].map(axis => sampleCatChannel(this.config.idle.channels[binding.firstChannel + axis], time));
        if (binding.property === 'position') position.splice(0, 3, ...values);
        else if (binding.property === 'scale') size.splice(0, 3, ...values);
        else angle = values[2]; // Unity Euler Z-X-Y: Z rolls inside the fixed billboard plane.
      }
      const point = projectWorld({ x: position[0], z: position[2] }, position[1]);
      part.plane.setPosition(point.x, point.y, 0);
      part.image.setScale(size[0], size[1], 1); part.image.angle = angle;
    }
  }
  destroy(): void {
    for (const root of this.partRoots.values()) if (root.isValid) root.destroy();
    this.partRoots.clear();
    if (this.deathRoot.isValid) this.deathRoot.destroy();
    if (this.node.isValid) this.node.destroy(); this.parts.length = 0;
  }

  private syncVisibility(): void {
    const active = this.visible && this.alive;
    this.node.active = active; this.deathRoot.active = active;
    for (const root of this.partRoots.values()) root.active = active;
  }

  private partRoot(order: number): Node {
    let root = this.partRoots.get(order);
    if (!root) {
      root = makeNode(`RaidParts_Default${order}`, this.layerForOrder?.(order) ?? this.bounce);
      this.partRoots.set(order, root);
      if (!this.layerForOrder) Array.from(this.partRoots.keys()).sort((a,b)=>a-b)
        .forEach((key,index)=>this.partRoots.get(key)!.setSiblingIndex(index));
    }
    return root;
  }

  private setSkin(value: number): void {
    const skin = Math.max(0, Math.min(4, Math.trunc(value))); if (skin === this.skin) return;
    for (const part of this.parts) part.plane.destroy(); this.parts = []; this.skin = skin; this.clock = 0;
    for (const spec of this.config.skins[skin].parts) {
      const plane = makeNode(spec.name, this.partRoot(spec.order)), q = spec.transform.rotation;
      const [x, y, z, w] = q;
      const a = projectWorld({ x: 1 - 2 * (y * y + z * z), z: 2 * (x * z - y * w) }, 2 * (x * y + z * w));
      const b = projectWorld({ x: 2 * (x * y - z * w), z: 2 * (y * z + x * w) }, 1 - 2 * (x * x + z * z));
      plane.angle = Math.atan2(a.y, a.x) * 180 / Math.PI;
      plane.setScale(Math.hypot(a.x, a.y), Math.hypot(b.x, b.y), 1);
      const image = this.art.image(spec.name, spec.image, plane);
      this.parts.push({ spec, plane, image });
    }
  }
}

/** The source Play() on each cleared boss emits its authored 50-particle burst. */
class RaidDeathParticles {
  private readonly simulation: OriginalParticleSimulation;
  private readonly views: { node: Node; sprite: Sprite; transform: UITransform }[] = [];
  private readonly pose: ParticlePose = { x: 0, y: 0, width: 0, height: 0, angle: 0, color: [] };
  constructor(art: ArtLibrary, parent: Node, specs: ParticleSpec[]) {
    this.simulation = new OriginalParticleSimulation(specs);
    for (const particle of this.simulation.particles) {
      const spec = particle.spec, node = art.image('Dirt_' + particle.index, spec.image, parent), sprite = node.getComponent(Sprite)!;
      const blend = sprite as unknown as { srcBlendFactor: number; _dstBlendFactor: number; updateMaterial(): void };
      blend.srcBlendFactor = spec.blend.source === 1 ? gfx.BlendFactor.ONE : gfx.BlendFactor.SRC_ALPHA;
      blend._dstBlendFactor = spec.blend.destination === 1 ? gfx.BlendFactor.ONE : gfx.BlendFactor.ONE_MINUS_SRC_ALPHA;
      blend.updateMaterial(); node.active = false;
      this.views.push({ node, sprite, transform: node.getComponent(UITransform)! });
    }
  }
  play(): void { this.simulation.hit({ x: 0, z: 0 }, 0, 0); }
  update(dt: number): void {
    this.simulation.update(dt, []);
    for (const particle of this.simulation.particles) {
      const view = this.views[particle.index]; view.node.active = particle.active;
      if (!particle.active) continue;
      const p = this.simulation.pose(particle, this.pose); view.node.setPosition(p.x, p.y); view.node.angle = p.angle;
      view.transform.setContentSize(p.width, p.height); view.sprite.color = new Color(...p.color.map(c => Math.round(Math.max(0, Math.min(1, c)) * 255)) as [number, number, number, number]);
    }
  }
}
