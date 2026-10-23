import { Node, Sprite, UITransform } from 'cc';
import { CAMERA_BASIS, projectWorld } from '../core/projection';
import { ArtLibrary, ImageSpec, makeNode } from './ArtLibrary';
import { BossAnimator, BossBone, BossBonePose, BossClip } from './BossAnimation';
import { catRecoilWeight } from './OriginalCatAnimation';

interface Transform { position: number[]; scale: number[]; rotation: number[]; source: string; }
interface BossImage extends ImageSpec { boundsCenter: [number, number, number]; }
interface Part { bone: string; image: BossImage; order: number; color: number[]; }
interface Skin { name: string; transform: Transform; bones: BossBone[]; parts: Part[]; idleHead: BossImage; deadHead: BossImage; }
export interface BossVisualConfig {
  version: number; ground: ImageSpec & { transform: Transform; tiling: [number, number]; clipRadius: number };
  skins: Skin[]; plane: Transform; clips: Record<string, BossClip>; transitionDuration: number;
  shadow: { image: ImageSpec; transform: Transform; color: [number, number, number, number] };
  bounce: { scale: number[]; duration: number }; worldOrigin: number[]; bossPosition: number[];
}
interface BossState { position: { x: number; z: number }; alive: boolean; stageIndex: number; facing: number; moving: boolean; }
interface Matrix { a: number; b: number; c: number; d: number; x: number; y: number; }

/** Nine original dragon skins and their Body/Head/limb hierarchy. Bone motion
 * runs in the authored billboard plane before its projection into screen space. */
export class BossView {
  readonly node: Node;
  private readonly planes = new Map<number, Node>();
  private readonly config: BossVisualConfig;
  private readonly animator: BossAnimator;
  private readonly shadow: Node;
  private readonly parts: { spec: Part; node: Node }[] = [];
  private readonly skin: Skin;
  private hitClock = Infinity;
  private hitYield = false;
  private groupDepth = 0;
  constructor(private readonly art: ArtLibrary, boss: BossState, parent: Node, shadowParent: Node,
    _layerForOrder: (order: number) => Node) {
    this.config = art.catalog.boss;
    if (!this.config || this.config.skins.length !== 9) throw new Error('Missing original Boss artwork');
    this.skin = this.config.skins[Math.max(0, boss.stageIndex) % 9];
    this.node = makeNode('OriginalBoss', parent);
    this.animator = new BossAnimator(this.config.clips, this.config.transitionDuration);
    this.shadow = art.image('BossShadow', { ...this.config.shadow.image, color: this.config.shadow.color }, shadowParent);
    for (const spec of this.skin.parts) {
      let plane = this.planes.get(spec.order);
      if (!plane) {
        // Each source dragon skin owns a Default/order0 SortingGroup. Limb
        // orders are local to that group, never global projectile bands.
        plane = makeNode(`${this.skin.name}_GroupOrder${spec.order}`, this.node);
        this.planes.set(spec.order, plane);
      }
      const image = spec.bone === 'Body/Head' ? this.skin.idleHead : spec.image;
      this.parts.push({ spec, node: art.image(spec.bone, { ...image, color: spec.color as [number, number, number, number] }, plane) });
    }
    // Creator's loose spread transform treats a Map iterator as one element.
    Array.from(this.planes.keys()).sort((a,b)=>a-b).forEach((order,index)=>this.planes.get(order)!.setSiblingIndex(index));
    this.update(0, boss);
  }
  /** Source SortingGroup distance uses its root, not individual limb bounds. */
  get sortingDepth(): number { return this.groupDepth; }
  hit(): void { if (this.hitClock >= this.config.bounce.duration) this.hitYield = true; this.hitClock = 0; }
  setActive(active: boolean): void { this.node.active = active; this.shadow.active = active; for (const plane of this.planes.values()) plane.active = active; }
  update(dt: number, boss: BossState): void {
    const elapsed = Math.max(0, dt), p = projectWorld(boss.position);
    this.animator.update(elapsed, boss.moving, boss.alive);
    if (this.hitYield) this.hitYield = false; else this.hitClock += elapsed;
    const weight = catRecoilWeight(this.hitClock, this.config.bounce.duration);
    const bx = 1 + (this.config.bounce.scale[0] - 1) * weight;
    const by = 1 + (this.config.bounce.scale[1] - 1) * weight;
    const bz = 1 + ((this.config.bounce.scale[2] ?? 0) - 1) * weight;
    const face = boss.facing < 0 ? 1 : -1;
    const q = this.config.plane.rotation, t = this.skin.transform;
    const offset = rotate(q, [t.position[0] * bx * face, t.position[1] * by, t.position[2] * face * bz]);
    const point = projectWorld({ x: offset[0], z: offset[2] }, offset[1]);
    this.node.setPosition(p.x + point.x, p.y + point.y, 0);
    this.groupDepth = (boss.position.x + offset[0]) * CAMERA_BASIS.forwardX +
      offset[1] * CAMERA_BASIS.forwardY + (boss.position.z + offset[2]) * CAMERA_BASIS.forwardZ;
    const x = rotate(q, [t.scale[0] * bx * face, 0, 0]), y = rotate(q, [0, t.scale[1] * by, 0]);
    const a = projectWorld({ x: x[0], z: x[2] }, x[1]), b = projectWorld({ x: y[0], z: y[2] }, y[1]);
    for (const plane of this.planes.values()) {
      plane.setPosition(0, 0, 0);
      plane.angle = Math.atan2(a.y, a.x) * 180 / Math.PI;
      plane.setScale(Math.hypot(a.x, a.y), (a.x * b.y - a.y * b.x < 0 ? -1 : 1) * Math.hypot(b.x, b.y), 1);
    }
    const matrices = new Map<string, Matrix>();
    for (const bone of this.skin.bones) {
      const pose = this.animator.pose(bone), own = matrix(pose);
      matrices.set(bone.path, bone.parent ? multiply(matrices.get(bone.parent)!, own) : own);
    }
    const depths = new Map<number, { node: Node; depth: number }[]>();
    for (const { spec, node } of this.parts) {
      const m = matrices.get(spec.bone)!;
      const image = spec.bone === 'Body/Head' ? (boss.alive ? this.skin.idleHead : this.skin.deadHead) : spec.image;
      node.setPosition(m.x, m.y, 0); node.angle = Math.atan2(m.b, m.a) * 180 / Math.PI;
      node.setScale(Math.hypot(m.a, m.b), (m.a * m.d - m.b * m.c < 0 ? -1 : 1) * Math.hypot(m.c, m.d), 1);
      if (spec.bone === 'Body/Head') {
        node.getComponent(Sprite)!.spriteFrame = this.art.frames.get(image.path)!;
        node.getComponent(UITransform)!.setContentSize(...image.sizeUnits);
        node.getComponent(UITransform)!.setAnchorPoint(...image.anchor);
      }
      // Retain the existing equal-order limb tie-break inside the group. The
      // external sorting key above must always use the shared group root.
      const [cx, cy, cz] = image.boundsCenter;
      const center = rotate(q, [(m.a * cx + m.c * cy + m.x) * t.scale[0] * bx * face,
        (m.b * cx + m.d * cy + m.y) * t.scale[1] * by, cz * t.scale[2] * bz * face]);
      const depth = center[0] * CAMERA_BASIS.forwardX + center[1] * CAMERA_BASIS.forwardY + center[2] * CAMERA_BASIS.forwardZ;
      const group = depths.get(spec.order) ?? []; group.push({ node, depth }); depths.set(spec.order, group);
    }
    for (const group of depths.values()) group.sort((a, b) => b.depth - a.depth).forEach(({ node }, i) => node.setSiblingIndex(i));
    const shadow = this.config.shadow.transform;
    const sp = projectWorld({ x: boss.position.x + shadow.position[0], z: boss.position.z + shadow.position[2] }, shadow.position[1]);
    this.shadow.setPosition(sp.x, sp.y, 0);
    const u = rotate(shadow.rotation, [shadow.scale[0], 0, 0]), v = rotate(shadow.rotation, [0, shadow.scale[1], 0]);
    const sa = projectWorld({ x: u[0], z: u[2] }, u[1]), sb = projectWorld({ x: v[0], z: v[2] }, v[1]);
    this.shadow.angle = Math.atan2(sa.y, sa.x) * 180 / Math.PI;
    this.shadow.setScale(Math.hypot(sa.x, sa.y), (sa.x * sb.y - sa.y * sb.x < 0 ? -1 : 1) * Math.hypot(sb.x, sb.y), 1);
  }
  destroy(): void { for (const plane of this.planes.values()) if (plane.isValid) plane.destroy(); this.planes.clear(); if (this.shadow.isValid) this.shadow.destroy(); if (this.node.isValid) this.node.destroy(); }
}

function rotate([x, y, z, w]: number[], [vx, vy, vz]: number[]): number[] {
  return [(1 - 2 * (y*y + z*z))*vx + 2*(x*y-z*w)*vy + 2*(x*z+y*w)*vz,
    2*(x*y+z*w)*vx + (1-2*(x*x+z*z))*vy + 2*(y*z-x*w)*vz,
    2*(x*z-y*w)*vx + 2*(y*z+x*w)*vy + (1-2*(x*x+y*y))*vz];
}
function matrix(p: BossBonePose): Matrix {
  const c = Math.cos(p.angle * Math.PI / 180), s = Math.sin(p.angle * Math.PI / 180);
  return { a: c*p.sx, b: s*p.sx, c: -s*p.sy, d: c*p.sy, x: p.x, y: p.y };
}
function multiply(p: Matrix, q: Matrix): Matrix {
  return { a: p.a*q.a+p.c*q.b, b: p.b*q.a+p.d*q.b, c: p.a*q.c+p.c*q.d, d: p.b*q.c+p.d*q.d,
    x: p.a*q.x+p.c*q.y+p.x, y: p.b*q.x+p.d*q.y+p.y };
}
