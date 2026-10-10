import { Node, UITransform, Vec3 } from 'cc';
import { ArtLibrary, BonePose, makeNode, RigData } from './ArtLibrary';
import { CharacterAppearance } from './CharacterAppearance';
import { MuzzleEmitterPose, OriginalMuzzleEffect } from './OriginalMuzzleEffect';
import { CAT_DIRECTION_SQUARED_THRESHOLD, CatDynamics, catAngleDelta, catRecoilWeight, OriginalCatAnimator, originalBulletSpawnOffset } from './OriginalCatAnimation';

/** Original rigid SpriteSkin parts and curves, with independent procedural aiming. */
export class CatView implements CharacterAppearance {
  readonly node: Node;
  readonly body: Node;
  readonly shadow: Node;
  readonly gunPivot: Node;
  readonly muzzle: Node;
  private readonly rig: RigData;
  private readonly poseFollowers: Node[][];
  private readonly poses: BonePose[];
  private readonly hands: {node: Node; position: [number, number]}[] = [];
  private readonly gunPosition: [number, number];
  private readonly gunBounce: Node;
  private readonly face?: Node;
  private readonly dynamics: CatDynamics;
  private readonly muzzleEffect: OriginalMuzzleEffect;
  private targetOffset: {x:number;z:number}|null = null;
  private bodyMirror = 1;
  private faceAngle = 90;
  private readonly muzzleLocal = new Vec3();
  private readonly axisLocal = new Vec3();
  private readonly axisWorld = new Vec3();
  private readonly axisProjected = new Vec3();
  private readonly rootTransform: UITransform;
  private readonly muzzleTransform: UITransform;
  private readonly animator: OriginalCatAnimator;
  private recoil = Infinity;
  private recoilJustStarted = false;
  private walking = false;
  private aimAngle = 130;

  constructor(private readonly art: ArtLibrary, parent: Node) {
    this.rig = art.rig;
    this.dynamics = this.rig.dynamics;
    this.animator = new OriginalCatAnimator(this.rig.animations, this.dynamics.animator);
    this.poseFollowers = this.rig.bones.map(() => []);
    this.poses = this.rig.bones.map(b => ({p: [b.position[0], b.position[1]], r: b.rotationDeg, s: [b.scale[0], b.scale[1]]}));
    this.node = makeNode('Cat', parent);
    this.rootTransform = this.node.getComponent(UITransform)!;
    const shadowSpec = art.catalog.effects.shadow;
    this.shadow = this.art.image('Shadow_DefaultMinus31', {...shadowSpec, ...shadowSpec.projectedTransform}, this.node);
    this.body = makeNode('CharacterAppearance', this.node);
    const plane = makeNode('OriginalBillboardProjection', this.body);
    const d = this.rig.display;
    plane.setScale(1, d.projectionScaleY, 1);
    const rigRoot = makeNode('OriginalRig', plane);
    // The original .4-unit origin offset is outside Cat_Bone's .55 local scale.
    rigRoot.setPosition(d.pivotOffset[0], d.pivotOffset[1], 0);
    rigRoot.setScale(d.scale, d.scale, 1);
    // Source Cat-layer Renderer orders: skin0, face/glow1, sparks2, gun3,
    // holding hand4 and outline5. Face and glow share the same source order.
    const drawLayers = [0,1,2,3,4,5].map(order => makeNode(`Cat_Order${order}`, rigRoot));

    // Sibling draw groups retain Unity's triangle/order ordering. Each has its
    // own tiny bone ancestry, preserving non-uniform scale without losing shear.
    const parts = this.rig.parts.slice().sort((a, b) => (a.drawOrder ?? 0) - (b.drawOrder ?? 0));
    for (const part of parts) {
      const group = makeNode(`PartOrder_${part.id}`, drawLayers[0]);
      const bone = this.createBoneChain(group, this.boneIndex(part.bone));
      this.art.image(part.id, part, bone);
    }
    const attachments = this.rig.attachments;
    if (attachments.face?.path) {
      const spec = attachments.face;
      this.face = this.art.image('Face', spec, this.createBoneChain(makeNode('Face_Order1', drawLayers[1]), this.boneIndex(spec.bone)));
    }
    const glowLayer = makeNode('MuzzleGlow_Order1',drawLayers[1]);
    const sparkLayer = makeNode('MuzzleSparks_Order2',drawLayers[2]);
    this.muzzleEffect = new OriginalMuzzleEffect(art, sparkLayer,
      point => this.projectedToRig(point), order => order === 1 ? glowLayer : sparkLayer);
    const gun = attachments.gun;
    const weapon = art.catalog.weapons[gun.weaponId];
    if (!weapon?.muzzle) throw new Error(`Missing weapon appearance: ${gun.weaponId}`);
    const gunBone = this.createBoneChain(makeNode('Gun_Order3', drawLayers[3]), this.boneIndex(gun.bone));
    this.gunPivot = makeNode('GunPivot', gunBone);
    this.gunPosition = [gun.localPosition[0], gun.localPosition[1]];
    this.gunPivot.setPosition(this.gunPosition[0], this.gunPosition[1], 0);
    this.gunPivot.angle = gun.localRotationDeg ?? 0;
    const gunScale = gun.localScale ?? [1, 1];
    this.gunPivot.setScale(gunScale[0], gunScale[1], 1);
    // This node includes [.4, -.4], the original X=180-degree sprite flip.
    this.gunBounce = makeNode('OriginalGunBounce',this.gunPivot);
    const gunImage = this.art.image('Pistol', weapon, this.gunBounce);
    this.muzzle = makeNode('Muzzle', gunImage);
    this.muzzleTransform = this.muzzle.getComponent(UITransform)!;
    this.muzzle.setPosition(weapon.muzzle.localPosition[0], weapon.muzzle.localPosition[1], 0);
    for (const name of ['hand', 'handOutline']) {
      const spec = attachments[name];
      if (!spec?.path) continue;
      const bone = this.createBoneChain(makeNode(`${name}_Order${spec.drawOrder}`, drawLayers[spec.drawOrder]), this.boneIndex(spec.bone));
      const hand = this.art.image(name, spec, bone);
      this.hands.push({node: hand, position: [spec.localPosition[0], spec.localPosition[1]]});
    }
    this.update(0, false, -1);
  }

  setAimTarget(offset: {x:number;z:number}|null): void { this.targetOffset = offset; }

  /** FaceTowardEnemy changes the pivot after hand/face Update, before spawning. */
  setFacing(facing: number): void {
    // LeftAngle=(40,-45,0), RightAngle=(-40,135,0); authored pose faces left.
    this.bodyMirror = facing < 0 ? 1 : -1;
    this.body.setScale(this.bodyMirror, 1, 1);
  }

  /** Offset in this.node's projected world units, before viewport pixel scale. */
  get muzzleOffset(): {x: number; y: number} {
    this.rootTransform.convertToNodeSpaceAR(this.muzzle.worldPosition, this.muzzleLocal);
    return {x: this.muzzleLocal.x, y: this.muzzleLocal.y};
  }
  getMuzzleProjectionOffset(): {x: number; y: number} { return this.muzzleOffset; }
  getBulletSpawnOffset(height: number): {x:number;z:number} {
    return originalBulletSpawnOffset(this.muzzleOffset, this.rig.display.projectionScaleY, height);
  }

  update(dt: number, moving: boolean, facing: number): void {
    this.updatePose(dt, moving, facing);
    this.updateEffects(dt);
  }

  updatePose(dt: number, moving: boolean, facing: number): void {
    // Cat.Update reads the preceding Animator/coroutine transforms. Normal
    // Animator evaluation and yield-null recoil run after Update (and Attack).
    this.walking = moving;
    this.setFacing(facing);
    const rebound = this.gunPivot.position.x - this.gunPosition[0];
    const root = this.poses[0];
    const rightIndex = this.boneIndex(this.rig.attachments.gun.bone);
    const right = this.poses[rightIndex];
    const rootAngle = root.r*Math.PI/180; const c=Math.cos(rootAngle), s=Math.sin(rootAngle);
    let desiredHand = this.dynamics.handRestAngle;
    if (this.targetOffset) {
      // Ordinary guns target nearHitPoint.XZ at the right hand's own world Y.
      // InverseTransformDirection ignores parent scale (unlike a point inverse).
      const px=this.rig.display.pivotOffset[0]+this.rig.display.scale*(root.p[0]+c*root.s[0]*right.p[0]-s*root.s[1]*right.p[1]);
      const py=this.rig.display.pivotOffset[1]+this.rig.display.scale*(root.p[1]+s*root.s[0]*right.p[0]+c*root.s[1]*right.p[1]);
      const hx=this.bodyMirror*Math.SQRT1_2*px-Math.SQRT1_2*Math.sin(40*Math.PI/180)*py;
      const hz=this.bodyMirror*Math.SQRT1_2*px+Math.SQRT1_2*Math.sin(40*Math.PI/180)*py;
      const hy=Math.cos(40*Math.PI/180)*py;
      const dx=this.targetOffset.x-hx,dz=this.targetOffset.z-hz;
      desiredHand=this.aimAngle;
      if (dx*dx+dz*dz > hx*hx+hy*hy+hz*hz && dx*dx+dz*dz > CAT_DIRECTION_SQUARED_THRESHOLD) {
        const x=this.bodyMirror*Math.SQRT1_2*(dx+dz);
        const y=Math.SQRT1_2*Math.sin(40*Math.PI/180)*(dz-dx);
        desiredHand=Math.atan2(-s*x+c*y,c*x+s*y)*180/Math.PI;
      }
    }
    this.aimAngle+=catAngleDelta(this.aimAngle,desiredHand)*Math.min(1,this.dynamics.handRotateSpeed*dt);
    right.r=this.aimAngle;
    // The support arm points at Gun_Pivot every frame, including its recoil.
    const left=this.poses[this.dynamics.leftHandBone];
    const ar=right.r*Math.PI/180,ac=Math.cos(ar),as=Math.sin(ar);
    const gx=(this.gunPosition[0]+rebound)*right.s[0],gy=this.gunPosition[1]*right.s[1];
    const lx=(right.p[0]+ac*gx-as*gy-left.p[0])*root.s[0];
    const ly=(right.p[1]+as*gx+ac*gy-left.p[1])*root.s[1];
    if ((lx*lx+ly*ly)*this.rig.display.scale*this.rig.display.scale >= CAT_DIRECTION_SQUARED_THRESHOLD) {
      left.r=Math.atan2(ly,lx)*180/Math.PI;
    }
    // Face_Pivot rotates, but Follow moves only the eyes/mouth Sprite position.
    let faceTarget=90;
    // Main-cat automatic movement has no joystick input; no target returns 90.
    const faceDir=this.targetOffset;
    if (faceDir && faceDir.x*faceDir.x+faceDir.z*faceDir.z>CAT_DIRECTION_SQUARED_THRESHOLD) {
      const x=Math.SQRT1_2*(faceDir.x+faceDir.z),z=Math.SQRT1_2*(faceDir.z-faceDir.x);
      const angle=Math.atan2(x,z)*180/Math.PI*(facing < 0 ? -1 : 1);
      faceTarget=lerp(this.dynamics.faceAngleRange[0],this.dynamics.faceAngleRange[1],Math.max(0,Math.min(1,angle/180)));
    }
    this.faceAngle+=catAngleDelta(this.faceAngle,faceTarget)*Math.min(1,this.dynamics.faceRotateSpeed*dt);
    if (this.face) {
      const fp=this.dynamics.facePivot,fr=this.faceAngle*Math.PI/180;
      this.face.setPosition(fp.position[0]+Math.cos(fr)*fp.radius,fp.position[1]+Math.sin(fr)*fp.radius,0);
    }
    for (let i = 0; i < this.poses.length; i++) this.setBone(i, this.poses[i]);
  }

  updateEffects(dt: number): void {
    // Bounce_Start only resets time; a newly started coroutine first yields
    // null. An already active bounce resumes this frame after a retrigger.
    if (this.recoilJustStarted) this.recoilJustStarted = false;
    else if (Number.isFinite(this.recoil)) {
      this.recoil += dt;
      if (this.recoil > this.dynamics.recoil.duration) this.recoil = Infinity;
      const pulse=catRecoilWeight(this.recoil,this.dynamics.recoil.duration);
      const rebound=this.dynamics.recoil.position[0]*pulse;
      this.gunPivot.setPosition(this.gunPosition[0]+rebound,this.gunPosition[1],0);
      for (const hand of this.hands) hand.node.setPosition(hand.position[0]+rebound,hand.position[1],0);
      this.gunBounce.setScale(lerp(1,this.dynamics.recoil.gunScale[0],pulse),lerp(1,this.dynamics.recoil.gunScale[1],pulse),1);
    }
    this.animator.update(dt,this.walking);
    const rightIndex=this.boneIndex(this.rig.attachments.gun.bone);
    for (let i=0;i<this.poses.length;i++) {
      const pose=this.poses[i],proceduralAngle=pose.r;
      this.animator.pose(i,pose);
      // Neither source clip binds the two arm rotations: retain Cat.Update's
      // local angles while their animated parent changes beneath them.
      if (i===rightIndex || i===this.dynamics.leftHandBone) pose.r=proceduralAngle;
      this.setBone(i,pose);
    }
    this.muzzleEffect.update(dt,this.muzzleEmitterPose(),this.bodyMirror,this.rig.display);
  }

  fire(): void {
    if (!Number.isFinite(this.recoil)) this.recoilJustStarted=true;
    this.recoil=0;
    const pose=this.muzzleEmitterPose();
    this.muzzleEffect.fire(pose);
    this.muzzleEffect.update(0,pose,this.bodyMirror,this.rig.display);
  }
  reset(): void {
    this.animator.reset(); this.recoil = Infinity; this.targetOffset=null;
    this.recoilJustStarted=false;this.walking=false;
    for (let i=0;i<this.poses.length;i++) this.animator.pose(i,this.poses[i]);
    this.gunPivot.setPosition(this.gunPosition[0],this.gunPosition[1],0);
    for (const hand of this.hands) hand.node.setPosition(hand.position[0],hand.position[1],0);
    this.gunBounce.setScale(1,1,1);
    this.aimAngle=130; this.faceAngle=90;this.muzzleEffect.reset();
    this.update(0, false, -1);
  }

  private projectedToRig(point:{x:number;y:number}):{x:number;y:number} {
    const d=this.rig.display;
    return {x:((point.x-this.node.position.x)*this.bodyMirror-d.pivotOffset[0])/d.scale,
      y:((point.y-this.node.position.y)/d.projectionScaleY-d.pivotOffset[1])/d.scale};
  }

  private muzzleEmitterPose():MuzzleEmitterPose {
    const offset=this.muzzleOffset;
    const emitter=this.art.catalog.effects.muzzle.emitter;
    const axis=(x:number,y:number):{x:number;y:number}=>{
      this.axisLocal.set(x,y,0);
      this.muzzleTransform.convertToWorldSpaceAR(this.axisLocal,this.axisWorld);
      const p=this.rootTransform.convertToNodeSpaceAR(this.axisWorld,this.axisProjected);
      return {x:(p.x-offset.x)*emitter.localScale,y:(p.y-offset.y)*emitter.localScale};
    };
    // Shoot_trans Y=90 maps cone Z to the barrel and cone Y to the gun's Y.
    // Its remaining axis is the billboard normal, unchanged by in-plane bones.
    const normalScale=emitter.localScale*emitter.gunScale*emitter.rigScale;
    return {origin:{x:this.node.position.x+offset.x,y:this.node.position.y+offset.y},
      xAxis:{x:0,y:-this.bodyMirror*Math.sin(emitter.projectionGapDegrees*Math.PI/180)*normalScale},
      yAxis:axis(0,1),zAxis:axis(1,0)};
  }

  private boneIndex(id: string | number): number {
    if (typeof id === 'number') return id;
    const index = this.rig.bones.findIndex(b => b.id === id || b.name === id);
    if (index < 0) throw new Error(`Unknown original bone: ${id}`);
    return index;
  }

  private createBoneChain(parent: Node, boneIndex: number): Node {
    const order: number[] = [];
    let index = boneIndex;
    while (index >= 0) {
      order.push(index);
      const p = this.rig.bones[index].parent;
      index = p === null ? -1 : typeof p === 'number' ? p : this.boneIndex(p);
    }
    let node = parent;
    for (let i = order.length - 1; i >= 0; i--) {
      index = order[i];
      node = makeNode(this.rig.bones[index].name, node);
      this.poseFollowers[index].push(node);
    }
    return node;
  }

  private setBone(i: number, pose: BonePose): void {
    for (const node of this.poseFollowers[i]) {
      node.setPosition(pose.p[0], pose.p[1], 0);
      node.angle = pose.r;
      node.setScale(pose.s[0], pose.s[1], 1);
    }
  }
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
