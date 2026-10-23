import { Color, Material, Node, Sprite, UITransform, Vec3 } from 'cc';
import { ArtLibrary, ImageSpec, makeNode } from './ArtLibrary';
import { visibleInHierarchy } from './OriginalWeaponFeedback';

type Source = Record<string, any>;
export interface DiamondFxConfig { source: string; image: string; count: number; particle: Source; }
export interface DiamondBounceConfig { node: string; scale: number; duration: number; }
interface Particle { node: Node; sprite: Sprite; age: number; life: number; x: number; y: number;
  vx: number; vy: number; size: number; random: number; }

/** Unity AnimationCurve weighted handles are fractions of the key interval.
 * The source attraction and scatter curves contain weighted tangents. */
export function diamondCurve(curve: Source, time: number, random = .5): number {
  if (!curve) return 1;
  const evaluate = (keys: Source[]): number => {
    if (!keys?.length) return 0;
    if (time <= keys[0].time) return keys[0].value;
    if (time >= keys[keys.length - 1].time) return keys[keys.length - 1].value;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i];
      if (time > b.time) continue;
      const span = b.time - a.time;
      if (!(span > 0)) return b.value;
      if (!Number.isFinite(a.outSlope)) return a.value;
      const out = a.weightedMode & 2 ? a.outWeight : 1 / 3;
      const into = b.weightedMode & 1 ? b.inWeight : 1 / 3;
      const bezier = (u: number, p0: number, p1: number, p2: number, p3: number): number => {
        const v = 1 - u; return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3;
      };
      let lo = 0, hi = 1;
      for (let j = 0; j < 22; j++) {
        const u = (lo + hi) / 2;
        if (bezier(u, a.time, a.time + out * span, b.time - into * span, b.time) < time) lo = u; else hi = u;
      }
      return bezier((lo + hi) / 2, a.value, a.value + a.outSlope * out * span,
        b.value - b.inSlope * into * span, b.value);
    }
    return keys[keys.length - 1].value;
  };
  if (curve.m_Mode === 0) return curve.m_ConstantMax;
  if (curve.m_Mode === 3) return curve.m_ConstantMin + (curve.m_ConstantMax - curve.m_ConstantMin) * random;
  const max = evaluate(curve.m_CurveMax?.m_Curve);
  const value = curve.m_Mode === 2 ? evaluate(curve.m_CurveMin?.m_Curve) * (1 - random) + max * random : max;
  return value * curve.m_CurveMultiplier;
}

/** The original shared ParticleImage: eight sprite particles scatter before
 * their weighted normalized-life curves attract them to the active UI target.
 * No currency is awarded here; each finished particle only sounds/bounces. */
export class OriginalDiamondAttraction {
  readonly node: Node;
  private readonly particles: Particle[] = [];
  private readonly pool: Particle[] = [];
  private readonly bounces = new Map<Node, { elapsed: number; base: Vec3 }>();
  private material: Material | null = null;
  private destroyed = false;
  constructor(private readonly art: ArtLibrary, parent: Node, private readonly image: ImageSpec,
    private readonly config: DiamondFxConfig, private readonly bounce: DiamondBounceConfig,
    private readonly target: () => Node | null, private readonly onArrival: () => void,
    private readonly random: () => number = Math.random, private readonly bounceTarget?: () => Node | null) {
    this.node = makeNode('OriginalDiamondAttraction', parent);
  }
  get active(): boolean { return this.particles.length > 0 || this.bounces.size > 0; }
  get count(): number { return this.particles.length; }
  setPresentation(parent: Node, material: Material | null = null): void {
    if (this.destroyed) return;
    if (this.node.parent !== parent) this.node.parent = parent;
    this.node.layer = parent.layer; this.material = material;
    for (const p of [...this.particles, ...this.pool]) { p.node.layer = parent.layer; p.sprite.customMaterial = material; }
  }
  spawn(from: Node): void {
    if (this.destroyed || !this.validTarget()) return;
    const origin = this.node.getComponent(UITransform)!.convertToNodeSpaceAR(from.worldPosition);
    const source = this.config.particle;
    for (let i = 0; i < this.config.count; i++) {
      let p = this.pool.pop();
      if (!p) {
        const node = makeNode('DiamondParticle', this.node), sprite = node.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM; sprite.spriteFrame = this.art.frames.get(this.image.path)!;
        p = { node, sprite, age: 0, life: 1, x: 0, y: 0, vx: 0, vy: 0, size: 60, random: .5 };
      }
      // ParticleImage circle shape uses insideUnitCircle when emitOnSurface is set.
      const angle = this.random() * Math.PI * 2;
      const radius = source._radius * (source._emitOnSurface ? Math.sqrt(this.random()) : 1);
      const speed = diamondCurve(source._startSpeed, this.random(), this.random());
      p.age = 0; p.life = Math.max(.001, diamondCurve(source._lifetime, this.random(), this.random()));
      p.x = origin.x + Math.cos(angle) * radius; p.y = origin.y + Math.sin(angle) * radius;
      p.vx = Math.cos(angle) * speed; p.vy = Math.sin(angle) * speed; p.random = this.random();
      p.size = diamondCurve(source._startSize.mainCurve, this.random(), this.random());
      p.node.active = true; p.node.layer = this.node.layer; p.sprite.customMaterial = this.material;
      p.sprite.color = new Color(255, 255, 255, 255); p.node.setScale(1, 1, 1);
      p.node.getComponent(UITransform)!.setContentSize(p.size, p.size); p.node.setPosition(p.x, p.y);
      this.particles.push(p);
    }
  }
  update(dt: number): void {
    if (this.destroyed || !(dt > 0) || !Number.isFinite(dt)) return;
    // Bounce_Start first yields. Newly arriving particles reset the elapsed
    // clock below; their bounce starts on the next frame, even after a long dt.
    for (const [node, motion] of this.bounces) {
      if (!node.isValid) { this.bounces.delete(node); continue; }
      motion.elapsed += dt;
      const half = this.bounce.duration / 2;
      const amount = motion.elapsed <= half ? 1 + (this.bounce.scale - 1) * motion.elapsed / half
        : this.bounce.scale + (1 - this.bounce.scale) * Math.min(1, (motion.elapsed - half) / half);
      node.setScale(motion.base.x * amount, motion.base.y * amount, motion.base.z);
      if (motion.elapsed >= this.bounce.duration) this.bounces.delete(node);
    }
    const source = this.config.particle, target = this.validTarget();
    const at = target ? this.node.getComponent(UITransform)!.convertToNodeSpaceAR(target.worldPosition) : null;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i], step = Math.min(dt, Math.max(0, p.life - p.age));
      p.age += step;
      const t = Math.min(1, p.age / p.life), speed = diamondCurve(source._speedOverLifetime, t, p.random);
      const velocity = source._velocityOverLifetime;
      const vx = source._velocityModule.enabled ? diamondCurve(velocity.xCurve, t, p.random) : 0;
      const vy = source._velocityModule.enabled ? diamondCurve(velocity.yCurve, t, p.random) : 0;
      p.x += (p.vx * speed + vx) * step * 100; p.y += (p.vy * speed + vy) * step * 100;
      if (source._vortexModule.enabled) {
        const angle = diamondCurve(source._vortexStrength, t, p.random) * step * 100 * Math.PI / 180;
        const x = p.x; p.x = x * Math.cos(angle) - p.y * Math.sin(angle); p.y = x * Math.sin(angle) + p.y * Math.cos(angle);
      }
      const attraction = at ? diamondCurve(source._toTarget, t, p.random) : 0;
      p.node.setPosition(p.x + ((at?.x ?? p.x) - p.x) * attraction, p.y + ((at?.y ?? p.y) - p.y) * attraction);
      const scale = diamondCurve(source._sizeOverLifetime.mainCurve, t, p.random);
      p.node.setScale(scale, scale, 1);
      if (p.age >= p.life) {
        p.node.active = false; this.particles.splice(i, 1); this.pool.push(p);
        // Dia_FX_End plays its sound even when the last target was disabled.
        this.onArrival();
        if (target) {
          const bounceNode = this.bounceTarget?.() ?? target;
          const previous = this.bounces.get(bounceNode);
          this.bounces.set(bounceNode, { elapsed: 0, base: previous?.base ?? bounceNode.scale.clone() });
        }
      }
    }
  }
  clear(): void {
    for (const p of this.particles.splice(0)) { p.node.active = false; this.pool.push(p); }
    for (const [node, motion] of this.bounces) if (node.isValid) node.setScale(motion.base);
    this.bounces.clear();
  }
  destroy(): void { if (!this.destroyed) { this.clear(); this.destroyed = true; this.node.destroy(); this.pool.length = 0; } }
  private validTarget(): Node | null {
    const node = this.target(); return node?.isValid && visibleInHierarchy(node) ? node : null;
  }
}
