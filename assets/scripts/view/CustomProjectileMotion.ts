import { CAMERA_BASIS as C } from '../core/projection';
import { evaluateParticleCurve, ParticleCurve } from './OriginalParticleSimulation';

export interface CustomProjectileProfile {
  body: 'painted';
  sprite: { path: string; width: number; height: number; uv: number[]; aspect: number };
  bodyLength: number; spinSpeed: number; anchor: 'tip' | 'center';
  hitTrigger: 'impact' | 'hit';
  flightRamp: { duration: number; spinStart?: number };
  afterimage?: { angleLag: number; alpha: number };
  bodyPalette?: { shadow: number[]; mid: number[]; highlight: number[]; strength: number };
  airFlow?: {
    image: { path: string }; period: number; flowPeriod: number; maxSizeScale: number;
    extension: { start: number; duration: number; length: number }; innerColor: number[];
  };
  cometTrail?: {
    image: { path: string }; minLifetime: number; lifetime: number; distanceStep: number;
    scale: number; coreScale: number; sizeCurve: ParticleCurve; attachment: number;
    coreBlendLength: number; outerColor: number[]; innerColor: number[];
  };
}
export interface ProjectileSample {
  x: number; z: number; height: number; age: number; traveled: number;
}
export interface ProjectileHead extends ProjectileSample { dx: number; dz: number; speed: number }
export interface ProjectileGeometry { positions: number[][]; uv: number[][]; indices: number[]; colors: number[][] }
export interface ProjectileBodyPose { x: number; y: number; tipX: number; tipY: number; angle: number; width: number; height: number }
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const smooth = (n: number): number => { n = clamp(n); return n * n * (3 - 2 * n); };
export const projectileGrowth = (profile: CustomProjectileProfile, age: number): number => smooth(age / profile.flightRamp.duration);
export const projectedPoint = (p: ProjectileSample): [number, number] =>
  [C.rightX * p.x + C.rightZ * p.z, C.upX * p.x + C.upY * p.height + C.upZ * p.z];

export function projectileBodyPose(profile: CustomProjectileProfile, b: ProjectileHead): ProjectileBodyPose {
  const [tipX, tipY] = projectedPoint(b), duration = profile.flightRamp.duration;
  const base = profile.flightRamp.spinStart ?? 1, t = Math.min(1, b.age / duration);
  const spinAge = base * b.age + (1 - base) * (duration * (t * t * t - .5 * t * t * t * t) + Math.max(0, b.age - duration));
  // Preview coordinates were canvas Y-down. Negate its rotation for Cocos Y-up.
  const angle = Math.atan2(C.upX * b.dx + C.upZ * b.dz, C.rightX * b.dx + C.rightZ * b.dz) - spinAge * profile.spinSpeed;
  const width = profile.bodyLength, shift = profile.anchor === 'tip' ? width / 2 : 0;
  return { x: tipX - Math.cos(angle) * shift, y: tipY - Math.sin(angle) * shift,
    tipX, tipY, angle, width, height: width / profile.sprite.aspect };
}

export function projectileGeometry(vertices: number, indices: number[]): ProjectileGeometry {
  return { positions: Array.from({ length: vertices }, () => [0, 0, 0]),
    uv: Array.from({ length: vertices }, () => [0, 0]), indices,
    colors: Array.from({ length: vertices }, () => [1, 1, 1, 0]) };
}
function vertex(g: ProjectileGeometry, i: number, x: number, y: number, u: number, v: number, c: readonly number[], alpha = 1): void {
  const p = g.positions[i], uv = g.uv[i], color = g.colors[i];
  p[0] = x; p[1] = y; uv[0] = u; uv[1] = v;
  color[0] = c[0]; color[1] = c[1]; color[2] = c[2]; color[3] = c[3] * alpha;
}
const WHITE = [1, 1, 1, 1];
const PRESSURE_RADII = [0, .25, .5, .75, .88, 1];
export function fillProjectileBody(g: ProjectileGeometry, profile: CustomProjectileProfile, pose: ProjectileBodyPose, alpha = 1, angle = pose.angle): void {
  const cs = Math.cos(angle), sn = Math.sin(angle), [u0, v0, u1, v1] = profile.sprite.uv;
  for (let i = 0; i < 4; i++) {
    const x = (i % 2 ? .5 : -.5) * pose.width, y = (i < 2 ? -.5 : .5) * pose.height;
    // OriginalParticleMesh uses bottom-left UVs; imported runtime PNGs are untrimmed.
    vertex(g, i, pose.x + x * cs - y * sn, pose.y + x * sn + y * cs,
      i % 2 ? u1 : u0, i < 2 ? 1 - v1 : 1 - v0, WHITE, alpha);
  }
}
export function pressureGeometry(): ProjectileGeometry {
  const indices: number[] = [];
  for (let i = 1; i <= 40; i++) for (let j = 1; j < 6; j++) {
    const k = i * 6 + j, a = k - 6; indices.push(a - 1, a, k - 1, k - 1, a, k);
  }
  return projectileGeometry(246, indices);
}
export function fillPressureFront(g: ProjectileGeometry, profile: CustomProjectileProfile, b: ProjectileHead, p = projectileBodyPose(profile, b)): void {
  const air = profile.airFlow!, growth = projectileGrowth(profile, b.age), w = p.width;
  const compression = .5 - .5 * Math.cos(b.age / air.period * Math.PI * 2);
  const frontScale = 1 - (1 - air.maxSizeScale) * growth;
  const rx = w * (.05 + .145 * growth) * (1 - .05 * compression * growth) * frontScale;
  const ry = w * (.045 + .14 * growth) * (.94 + .045 * compression * growth) * frontScale;
  const depth = w * (.055 + .085 * growth) * frontScale, extension = smooth((b.age - air.extension.start) / air.extension.duration);
  const tail = w * air.extension.length * extension, offset = -w * .018, cs = Math.cos(p.angle), sn = Math.sin(p.angle);
  for (let i = 0; i <= 40; i++) {
    const theta = (i / 40 * 2 - 1) * 1.65, ax = Math.cos(theta), ay = Math.sin(theta), edge = Math.abs(theta) / 1.65;
    const fade = Math.max(0, 1 - Math.pow(edge, 3)), travel = (edge * .9 - b.age / air.flowPeriod) * Math.PI * 2;
    const sweep = Math.pow(.5 + .5 * Math.cos(travel), 3), flowAlpha = 1 + growth * (.12 + .88 * edge) * (-.3 + .58 * sweep);
    for (let j = 0; j < 6; j++) {
      const r = PRESSURE_RADII[j], sample = .66 + .34 * r + .025 * Math.sin(travel) * (1 - r) * growth;
      const shoulder = edge * edge, thickness = depth * (1 - .65 * extension * shoulder);
      const x = offset + rx * (ax - .14 * Math.abs(ay)) - tail * shoulder - thickness * (1 - r);
      const y = -ry * ay * (.74 + .26 * r);
      vertex(g, i * 6 + j, p.tipX + x * cs - y * sn, p.tipY + x * sn + y * cs,
        .5 + .5 * sample * ax, .5 + .5 * sample * ay, air.innerColor,
        (.36 + .64 * growth) * 2.25 * fade * flowAlpha * (j === 0 ? 0 : 1));
    }
  }
}
export function sampleProjectilePath(history: readonly ProjectileSample[], distance: number, out: ProjectileSample): ProjectileSample {
  let upper = history[history.length - 1];
  for (let i = history.length - 2; i >= 0; i--) {
    const lower = history[i];
    if (lower.traveled <= distance) {
      const span = upper.traveled - lower.traveled, t = span > 1e-7 ? clamp((distance - lower.traveled) / span) : 0;
      out.x = lower.x + (upper.x - lower.x) * t; out.z = lower.z + (upper.z - lower.z) * t;
      out.height = lower.height + (upper.height - lower.height) * t; out.age = lower.age + (upper.age - lower.age) * t;
      out.traveled = distance; return out;
    }
    upper = lower;
  }
  Object.assign(out, upper); return out;
}
export const RIBBON_POINTS = 80;
export function ribbonGeometry(): ProjectileGeometry {
  const indices: number[] = [];
  for (let i = 1; i < RIBBON_POINTS + 2; i++) { const k = i * 2; indices.push(k - 2, k - 1, k, k, k - 1, k + 1); }
  return projectileGeometry((RIBBON_POINTS + 2) * 2, indices);
}
export interface RibbonPoint { x: number; y: number; width: number; alpha: number }
export function ribbonPoints(): RibbonPoint[] { return Array.from({ length: RIBBON_POINTS }, () => ({ x: 0, y: 0, width: 0, alpha: 0 })); }
export function sampleRibbon(profile: CustomProjectileProfile, head: ProjectileHead, history: readonly ProjectileSample[], stoppedFor: number,
  outer: RibbonPoint[], core: RibbonPoint[], scratch: ProjectileSample): number {
  const trail = profile.cometTrail!;
  if (!history.length || stoppedFor >= trail.lifetime) return 0;
  const now = head.age + stoppedFor, distance = Math.max(0, head.traveled - profile.bodyLength * trail.attachment);
  const first = Math.max(0, Math.ceil((head.traveled - head.speed * trail.lifetime * 1.25) / trail.distanceStep));
  const last = Math.floor(distance / trail.distanceStep), start = Math.max(first, last - RIBBON_POINTS + 2);
  const curve0 = evaluateParticleCurve(trail.sizeCurve, 0), curve1 = evaluateParticleCurve(trail.sizeCurve, 1);
  let count = 0;
  const add = (d: number): void => {
    if (count >= RIBBON_POINTS) return;
    const birth = sampleProjectilePath(history, d, scratch), growth = projectileGrowth(profile, birth.age);
    const life = trail.minLifetime + (trail.lifetime - trail.minLifetime) * growth, age = Math.max(0, now - birth.age), t = age / life;
    if (t >= 1) return;
    const shrink = Math.max(0, (evaluateParticleCurve(trail.sizeCurve, t) - curve1) / (curve0 - curve1));
    const width = profile.bodyLength * trail.scale * (.55 + .45 * growth) * shrink;
    if (width < .01) return;
    const [x, y] = projectedPoint(birth), alpha = Math.min(1, (1 - t) / .23), a = outer[count], b = core[count++];
    a.x = b.x = x; a.y = b.y = y; a.width = width; b.width = width * trail.coreScale; a.alpha = alpha;
    b.alpha = alpha * (.35 + .65 * Math.min(1, (distance - d) / trail.coreBlendLength));
  };
  for (let i = start; i <= last; i++) add(i * trail.distanceStep);
  if (distance - last * trail.distanceStep > 1e-4) add(distance);
  return count;
}
export function fillRibbon(g: ProjectileGeometry, points: readonly RibbonPoint[], count: number, color: readonly number[]): void {
  for (const c of g.colors) c[3] = 0;
  if (count === 0) return;
  const first = points[0], second = points[Math.min(1, count - 1)], dx = second.x - first.x, dy = second.y - first.y;
  const distance = Math.hypot(dx, dy) || 1;
  const tx = first.x - dx / distance * Math.min(distance, .5), ty = first.y - dy / distance * Math.min(distance, .5);
  vertex(g, 0, tx, ty, .5, 1, color, 0); vertex(g, 1, tx, ty, .5, 0, color, 0);
  let ux = 1, uy = 0;
  for (let i = 0; i < count; i++) {
    const p = points[i], a = i ? points[i - 1] : { x: tx, y: ty }, b = points[Math.min(count - 1, i + 1)];
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1; ux = (b.x - a.x) / length; uy = (b.y - a.y) / length;
    const nx = -uy * p.width / 2, ny = ux * p.width / 2;
    vertex(g, (i + 1) * 2, p.x + nx, p.y + ny, .5, 1, color, p.alpha);
    vertex(g, (i + 1) * 2 + 1, p.x - nx, p.y - ny, .5, 0, color, p.alpha);
  }
  const p = points[count - 1], k = (count + 1) * 2, a = g.positions[k - 2], b = g.positions[k - 1];
  vertex(g, k, a[0] + ux * p.width / 2, a[1] + uy * p.width / 2, 1, 1, color, p.alpha);
  vertex(g, k + 1, b[0] + ux * p.width / 2, b[1] + uy * p.width / 2, 1, 0, color, p.alpha);
  // Fixed-capacity triangles after the live ribbon collapse at its end.
  for (let i = k + 2; i < g.positions.length; i++) vertex(g, i, g.positions[k][0], g.positions[k][1], 1, 0, color, 0);
}
