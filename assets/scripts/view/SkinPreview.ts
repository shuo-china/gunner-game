import { Color, Material, Node, Sprite, UITransform } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import type { BonePose, ImageSpec, RigData, RigPart } from './ArtLibrary';
import { sampleCatPose } from './OriginalCatAnimation';

type Matrix = [number, number, number, number, number, number];
const multiply = (a: Matrix, b: Matrix): Matrix => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const matrix = (p: number[], r: number, s: number[]): Matrix => {
  const c = Math.cos(r*Math.PI/180), n = Math.sin(r*Math.PI/180);
  return [c*s[0], n*s[0], -n*s[1], c*s[1], p[0], p[1]];
};
export function skinBoneIndex(rig: RigData, id: string | number): number {
  const index = typeof id === 'number' ? id : rig.bones.findIndex(bone => bone.id === id || bone.name === id);
  if (index < 0 || index >= rig.bones.length) throw new Error(`Unknown skin bone: ${id}`);
  return index;
}

/** The showcase has no weapon: fingertips rest downward and slightly inward.
 * Work on fresh poses so battle aiming and the shared idle clip stay untouched. */
function showcasePoses(rig: RigData, base: RigPart[]): BonePose[] {
  const poses = rig.bones.map((_, i) => sampleCatPose(rig.animations.idle, 0, i));
  const world = (i: number): Matrix => {
    const pose = poses[i], parent = rig.bones[i].parent;
    const local = matrix(pose.p, pose.r, pose.s);
    return parent === null || parent === -1 ? local : multiply(world(skinBoneIndex(rig, parent)), local);
  };
  const place = (id: string, x: number, y: number, angle: number): void => {
    const part = base.find(part => part.id === id)!;
    const index = skinBoneIndex(rig, part.bone), pose = poses[index], parent = rig.bones[index].parent;
    const m: Matrix = parent === null || parent === -1 ? [1, 0, 0, 1, 0, 0] : world(skinBoneIndex(rig, parent));
    // Rig-space part centers, before the common display projection/scale.
    const dx = x-m[4], dy = y-m[5], determinant = m[0]*m[3]-m[1]*m[2];
    const target = [(m[3]*dx-m[2]*dy)/determinant, (-m[1]*dx+m[0]*dy)/determinant];
    pose.r = angle-Math.atan2(m[1], m[0])*180/Math.PI-(part.localRotationDeg ?? 0);
    const offset = matrix([0, 0], pose.r, pose.s), p = part.localPosition ?? [0, 0];
    pose.p = [target[0]-offset[0]*p[0]-offset[2]*p[1], target[1]-offset[1]*p[0]-offset[3]*p[1]];
  };
  // The two source paws have opposite wrist-to-fingertip directions. A common
  // 180-degree turn inverted both wrists and made the round fingertips face up.
  place('hand_left', -1.45, 2.35, -40);
  place('hand_right', 1.45, 2.35, 40);
  const body = base.find(part => part.id === 'body')!, bm = world(skinBoneIndex(rig, body.bone));
  const bp = body.localPosition ?? [0, 0], centerX = bm[0]*bp[0]+bm[2]*bp[1]+bm[4];
  // A front-facing still needs a balanced stance, rather than the unequal
  // offsets/angles of one frame from the battle idle animation.
  place('foot_left', centerX-1.18, -.1, 0);
  place('foot_right', centerX+1.18, -.1, 0);
  return poses;
}

/** Common front-facing pose and framing from the base battle rig. No per-skin fitting. */
export function skinPreviewGeometry(rig: RigData, base: RigPart[]) {
  // Keep the existing idle framing when the paws move inward: no size/position jump.
  const framing = rig.bones.map((_, i) => sampleCatPose(rig.animations.idle, 0, i));
  const d = rig.display, world: Matrix[] = [];
  const display = multiply(matrix([0, 0], 0, [1, d.projectionScaleY]), matrix(d.pivotOffset, 0, [d.scale, d.scale]));
  const boneMatrix = (i: number): Matrix => {
    if (world[i]) return world[i];
    const parent = rig.bones[i].parent, pose = framing[i];
    return world[i] = multiply(parent === null || parent === -1 ? display : boneMatrix(skinBoneIndex(rig, parent)), matrix(pose.p, pose.r, pose.s));
  };
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of base) {
    const m = multiply(boneMatrix(skinBoneIndex(rig, part.bone)), matrix(part.localPosition ?? [0, 0], part.localRotationDeg ?? 0, part.localScale ?? [1, 1]));
    for (const x of [-part.anchor[0]*part.sizeUnits[0], (1-part.anchor[0])*part.sizeUnits[0]]) {
      for (const y of [-part.anchor[1]*part.sizeUnits[1], (1-part.anchor[1])*part.sizeUnits[1]]) {
        const px = m[0]*x+m[2]*y+m[4], py = m[1]*x+m[3]*y+m[5];
        bounds[0] = Math.min(bounds[0], px); bounds[1] = Math.min(bounds[1], py);
        bounds[2] = Math.max(bounds[2], px); bounds[3] = Math.max(bounds[3], py);
      }
    }
  }
  const head = base.find(part => part.id === 'head')!, hp = head.localPosition ?? [0, 0];
  const pivot = rig.dynamics.facePivot, facePosition: [number, number] = [pivot.position[0], pivot.position[1]+pivot.radius];
  const r = (head.localRotationDeg ?? 0)*Math.PI/180, c = Math.cos(r), s = Math.sin(r);
  // Remove the sideways aiming offset while retaining the authored facial height.
  const sideways = (facePosition[0]-hp[0])*c+(facePosition[1]-hp[1])*s;
  facePosition[0] -= sideways*c; facePosition[1] -= sideways*s;
  const poses = showcasePoses(rig, base);
  // The battle idle torso leans slightly. Level only its showcase sprite so
  // the hem meets the two resting feet at the same height.
  const body = base.find(part => part.id === 'body')!;
  let bodyRotationDeg = 0, index = skinBoneIndex(rig, body.bone);
  while (index >= 0) {
    bodyRotationDeg -= poses[index].r;
    const parent = rig.bones[index].parent;
    index = parent === null || parent === -1 ? -1 : skinBoneIndex(rig, parent);
  }
  return { poses, bodyRotationDeg, facePosition, bounds, width: bounds[2]-bounds[0], height: bounds[3]-bounds[1],
    center: [(bounds[0]+bounds[2])/2, (bounds[1]+bounds[3])/2] };
}

/** Live battle SpriteFrames and rig transforms. There is no portrait texture or snapshot bake.
 * Pose is held still so the containing HUD can retain its existing draw cache. */
export class SkinPreview {
  readonly node: Node;
  private readonly rigRoot: Node;
  private readonly parts = new Map<string, { node: Node; sprite: Sprite }>();
  private readonly geometry: ReturnType<typeof skinPreviewGeometry>;
  private skinId = -1;

  constructor(private readonly parent: Node, private readonly art: ArtLibrary,
    private readonly material?: Material, private readonly tint = Color.WHITE) {
    if (!art.skinVisuals) throw new Error('Battle skin assets must be ready before the skin UI');
    this.geometry = skinPreviewGeometry(art.rig, art.skinVisuals.appearance(0).parts);
    this.node = makeNode('BattleSkinPreview', parent);
    this.node.setSiblingIndex(0); // Existing lock icon and overlay stay above the model.
    const plane = makeNode('OriginalBillboardProjection', this.node), d = art.rig.display;
    plane.setScale(1, d.projectionScaleY, 1);
    this.rigRoot = makeNode('OriginalRig', plane);
    this.rigRoot.setPosition(d.pivotOffset[0], d.pivotOffset[1], 0);
    this.rigRoot.setScale(d.scale, d.scale, 1);
    const base = art.skinVisuals.appearance(0).parts.slice().sort((a, b) => (a.drawOrder ?? 0)-(b.drawOrder ?? 0));
    for (const part of base) {
      const bone = this.boneChain(makeNode(`PartOrder_${part.id}`, this.rigRoot), skinBoneIndex(art.rig, part.bone));
      const node = art.image(part.id, part, bone);
      this.parts.set(part.id, { node, sprite: node.getComponent(Sprite)! });
    }
    const face = art.rig.attachments.face;
    if (face?.path) {
      const node = art.image('Face', face, this.boneChain(makeNode('Face_Order1', this.rigRoot), skinBoneIndex(art.rig, face.bone)));
      node.setPosition(this.geometry.facePosition[0], this.geometry.facePosition[1], 0);
      const sprite = node.getComponent(Sprite)!;
      sprite.customMaterial = material ?? null; sprite.color = tint;
    }
    this.setSkin(0); this.resize();
  }

  private boneChain(parent: Node, index: number): Node {
    const indices: number[] = [], rig = this.art.rig;
    while (index >= 0) {
      indices.push(index);
      const next = rig.bones[index].parent;
      index = next === null || next === -1 ? -1 : skinBoneIndex(rig, next);
    }
    let node = parent;
    for (let i = indices.length-1; i >= 0; i--) {
      const id = indices[i], pose: BonePose = this.geometry.poses[id];
      node = makeNode(rig.bones[id].name, node);
      node.setPosition(pose.p[0], pose.p[1], 0); node.angle = pose.r; node.setScale(pose.s[0], pose.s[1], 1);
    }
    return node;
  }

  setSkin(id: number): void {
    if (id === this.skinId) return;
    const assets = this.art.skinVisuals!, appearance = assets.appearance(id);
    const monochrome = this.tint.r === 0 && this.tint.g === 0 && this.tint.b === 0;
    for (const spec of appearance.parts) {
      const part = this.parts.get(spec.id)!;
      this.setImage(part.node, part.sprite, spec);
      if (spec.id === 'body') part.node.angle = this.geometry.bodyRotationDeg;
      if (spec.id === 'foot_left' || spec.id === 'foot_right') {
        // Equal rectangles cannot balance the different baked foot-root edges.
        // Mirror the left battle frame for the right resting foot in this UI.
        // Battle still uses both original frames and their animated transforms.
        const foot = appearance.parts.find(item => item.id === 'foot_left')!;
        part.sprite.spriteFrame = this.art.frames.get(foot.path)!;
        part.node.getComponent(UITransform)!.setContentSize(2.44, 1.49);
        if (spec.id === 'foot_right') part.node.setScale(-part.node.scale.x, part.node.scale.y, 1);
      }
      // Exactly the battle palette branch; clothing and face retain their authored colors.
      part.sprite.customMaterial = (spec.id === 'body' ? assets.bodyMaterial(this.material, id)
        : !monochrome ? assets.paletteMaterial(id, this.material) : this.material) ?? null;
      part.sprite.color = this.tint;
    }
    this.skinId = id;
  }

  private setImage(node: Node, sprite: Sprite, spec: ImageSpec): void {
    const frame = this.art.frames.get(spec.path);
    if (!frame) throw new Error(`Missing battle skin frame: ${spec.path}`);
    sprite.spriteFrame = frame;
    const transform = node.getComponent(UITransform)!;
    transform.setContentSize(spec.sizeUnits[0], spec.sizeUnits[1]); transform.setAnchorPoint(spec.anchor[0], spec.anchor[1]);
    node.setPosition(...(spec.localPosition ?? [0, 0]), 0); node.angle = spec.localRotationDeg ?? 0;
    node.setScale(...(spec.localScale ?? [1, 1]), 1);
  }

  resize(): void {
    const tr = this.parent.getComponent(UITransform)!, g = this.geometry;
    const scale = .92*Math.min(tr.width/g.width, tr.height/g.height);
    this.node.setScale(scale, scale, 1);
    this.node.setPosition(tr.width*(.5-tr.anchorX)-g.center[0]*scale, tr.height*(.5-tr.anchorY)-g.center[1]*scale, 0);
  }
}
