import { Color, Graphics, Node, Sprite, UITransform, Vec3 } from 'cc';
import { ArtLibrary, BonePose, makeNode, RigData } from './ArtLibrary';
import { CharacterAppearance } from './CharacterAppearance';
import { MuzzleEffectSpec, MuzzleEmitterPose, OriginalMuzzleEffect } from './OriginalMuzzleEffect';
import type { WeaponAppearanceSpec } from './WeaponVisualAssets';
import { getWeapon, WeaponType } from '../core/WeaponCatalog';
import { CAMERA_BASIS, unprojectGround } from '../core/projection';
import { OriginalWeaponGradeEffects } from './OriginalWeaponGradeEffects';
import { CAT_DIRECTION_SQUARED_THRESHOLD, CatDynamics, catAngleDelta, catRecoilWeight, OriginalCatAnimator, originalBulletSpawnOffset } from './OriginalCatAnimation';
import { BowStringSpec, bowStringPoints, WeaponAttackAnimator, WeaponAttackPose, WeaponAttackState, WeaponAnimationCategory } from './WeaponAttackAnimation';
import { StaffCastEffect } from './StaffCastEffect';

// Original hand.png: the alpha silhouette's rear intersection with the ray
// through its center along HandR -X. This is source-pixel geometry, not a
// guessed bone offset: source rotation 145.23482952 degrees maps it to
// HandR [-0.33605452920024226, -0.0690003], the base of the covered paw.
const GLOVE_HAND_BASE_PX: [number, number] = [179, 34.5941698919845];
// Keep the string readable at the smaller battle display scale.
const BATTLE_BOW_STRING_WIDTH_SCALE = 2;

/** Offsets use the unmirrored body plane (X right, Y up), before display scale. */
export interface BowPoseTuning {
  pivotX: number;
  pivotY: number;
  holdingRadiusScale: number;
  drawHandX: number;
  drawHandY: number;
  drawDistanceScale: number;
  drawDirectionAngle: number;
  drawHandAngle: number;
}
const DEFAULT_BOW_POSE: Readonly<BowPoseTuning> = Object.freeze({
  pivotX: .16, pivotY: .20, holdingRadiusScale: .85, drawHandX: 0, drawHandY: -.06,
  drawDistanceScale: .90, drawDirectionAngle: 0, drawHandAngle: 0,
});
const BOW_POSE_LIMITS: {[K in keyof BowPoseTuning]: readonly [number, number]} = {
  pivotX: [-5, 5], pivotY: [-5, 5], holdingRadiusScale: [.1, 2], drawHandX: [-5, 5], drawHandY: [-5, 5],
  drawDistanceScale: [0, 3], drawDirectionAngle: [-90, 90], drawHandAngle: [-180, 180],
};

/** Original rigid SpriteSkin parts and curves, with independent procedural aiming. */
export class CatView implements CharacterAppearance {
  readonly node: Node;
  /** Complete actor visibility pass, kept as one depth-sorted group. */
  readonly overlayNode?: Node;
  readonly body: Node;
  readonly shadow: Node;
  readonly gunPivot: Node;
  readonly muzzle: Node;
  private readonly rig: RigData;
  private readonly poseFollowers: Node[][];
  private readonly poses: BonePose[];
  private readonly skinLayer: Node;
  private readonly weaponDrawLayer: Node;
  private readonly weaponDrawIndex: number;
  private readonly overlayBody?: Node;
  private readonly skinFollowers = new Set<Node>();
  private readonly holdingSkinParts: Node[] = [];
  private supportPalmCenter?: [number, number];
  private skinBodyCenter?: [number, number];
  private skinId = -1;
  private handSprite?: Sprite;
  private readonly hands: {node: Node; position: [number, number]; rotation: number}[] = [];
  private readonly gunPosition: [number, number];
  private gloveHandBase?: [number, number];
  private readonly gunBounce: Node;
  private readonly face?: Node;
  private readonly dynamics: CatDynamics;
  private muzzleEffect: OriginalMuzzleEffect;
  private readonly staffCastEffect: StaffCastEffect;
  private readonly glowLayer: Node;
  private readonly sparkLayer: Node;
  private readonly gunImage: Node;
  private weaponId = -1;
  private weaponType: WeaponType = 'SINGLE';
  private weaponCategory: WeaponAnimationCategory = 'bow';
  private readonly attackAnimator = new WeaponAttackAnimator();
  private attackPose?: WeaponAttackPose;
  private holdingHandPosition?: [number, number];
  private supportHandPosition?: [number, number];
  private bowSupportGrip?: [number, number];
  private bowHandDrawOffset?: [number, number];
  private bowDrawnGrip?: [number, number];
  private bowStringNode?: Node;
  private bowStringGraphic?: Graphics;
  private bowStringDefinition?: BowStringSpec;
  private bowPoseTuning?: BowPoseTuning;
  private weaponAppearance?: WeaponAppearanceSpec;
  private muzzleDefinition: MuzzleEffectSpec;
  private targetOffset: {x:number;z:number}|null = null;
  private manualLook: Readonly<{x:number;z:number}> | null = null;
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
  private readonly gradeEffects: OriginalWeaponGradeEffects;

  constructor(private readonly art: ArtLibrary, parent: Node, layerForOrder?: (order:number)=>Node, overlayParent?: Node) {
    this.rig = art.rig;
    this.dynamics = this.rig.dynamics;
    this.animator = new OriginalCatAnimator(this.rig.animations, this.dynamics.animator);
    this.poseFollowers = this.rig.bones.map(() => []);
    this.poses = this.rig.bones.map(b => ({p: [b.position[0], b.position[1]], r: b.rotationDeg, s: [b.scale[0], b.scale[1]]}));
    this.node = makeNode('Cat', parent);
    if (overlayParent) this.overlayNode = makeNode('Cat_Overlay', overlayParent);
    this.gradeEffects = new OriginalWeaponGradeEffects(art, parent, layerForOrder);
    this.rootTransform = this.node.getComponent(UITransform)!;
    const shadowSpec = art.catalog.effects.shadow;
    this.shadow = this.art.image('Shadow_DefaultMinus31', {...shadowSpec, ...shadowSpec.projectedTransform}, this.node);
    this.body = makeNode('CharacterAppearance', this.node);
    const d = this.rig.display;
    const makeRig = (body: Node): Node => {
      const plane = makeNode('OriginalBillboardProjection', body);
      plane.setScale(1, d.projectionScaleY, 1);
      const root = makeNode('OriginalRig', plane);
      // The original .4-unit origin offset is outside Cat_Bone's .55 scale.
      root.setPosition(d.pivotOffset[0], d.pivotOffset[1], 0);
      root.setScale(d.scale, d.scale, 1);
      return root;
    };
    const rigRoot = makeRig(this.body);
    let overlayRig: Node | undefined;
    if (this.overlayNode) {
      this.overlayBody = makeNode('CharacterAppearance', this.overlayNode);
      overlayRig = makeRig(this.overlayBody);
    }
    // Preserve the source's internal orders: skin0, face/glow1, sparks2,
    // gun3, holding hand4 and outline5. The original GO3 overlay protects
    // only the weapon/holding hand; dense world particles hide GO0 skin/face.
    // Extend that pass to the whole actor so the body cannot disappear while
    // its weapon remains visible. Reuse each sprite once; shadows stay below.
    // Standalone previews use the same combined order in their local rig.
    const drawLayers = new Map([0,1,2,3,4,5]
      .map(order => [order, makeNode(`Cat_Order${order}`, overlayRig ?? rigRoot)] as const));
    const overlayLayers = drawLayers;

    this.skinLayer = drawLayers.get(0)!;
    this.weaponDrawLayer = overlayLayers.get(3)!;
    this.weaponDrawIndex = this.weaponDrawLayer.parent!.children.indexOf(this.weaponDrawLayer);
    const attachments = this.rig.attachments;
    if (attachments.face?.path) {
      const spec = attachments.face;
      this.face = this.art.image('Face', spec, this.createBoneChain(makeNode('Face_Order1', drawLayers.get(1)!), this.boneIndex(spec.bone)));
    }
    const glowLayer = makeNode('MuzzleGlow_Order1',overlayLayers.get(1)!);
    const sparkLayer = makeNode('MuzzleSparks_Order2',overlayLayers.get(2)!);
    this.glowLayer = glowLayer; this.sparkLayer = sparkLayer;
    const assets = art.weaponVisuals;
    if (!assets) throw new Error('Weapon appearances must load before creating a character');
    const weapon = assets.appearance(0);
    this.muzzleDefinition = assets.config.muzzleSkins[weapon.muzzleSkin];
    this.muzzleEffect = new OriginalMuzzleEffect(art, sparkLayer,
      point => this.projectedToRig(point), order => order === 1 ? glowLayer : sparkLayer,
      this.muzzleDefinition, assets.config.images);
    const gun = attachments.gun;
    const gunBone = this.createBoneChain(makeNode('Gun_Order3', overlayLayers.get(3)!), this.boneIndex(gun.bone));
    this.gunPivot = makeNode('GunPivot', gunBone);
    this.gunPosition = [gun.localPosition[0], gun.localPosition[1]];
    this.gunPivot.setPosition(this.gunPosition[0], this.gunPosition[1], 0);
    this.gunPivot.angle = gun.localRotationDeg ?? 0;
    const gunScale = gun.localScale ?? [1, 1];
    this.gunPivot.setScale(gunScale[0], gunScale[1], 1);
    // This node includes [.4, -.4], the original X=180-degree sprite flip.
    this.gunBounce = makeNode('OriginalGunBounce',this.gunPivot);
    const gunImage = this.art.image('bow_0', weapon.image, this.gunBounce);
    this.gunImage = gunImage;
    this.muzzle = makeNode('Muzzle', gunImage);
    this.muzzleTransform = this.muzzle.getComponent(UITransform)!;
    this.muzzle.setPosition(weapon.muzzle.localPosition[0], weapon.muzzle.localPosition[1], 0);
    this.staffCastEffect = new StaffCastEffect(art, sparkLayer, this.muzzle);
    for (const name of ['hand', 'handOutline']) {
      const spec = attachments[name];
      if (!spec?.path) continue;
      const bone = this.createBoneChain(makeNode(`${name}_Order${spec.drawOrder}`, overlayLayers.get(spec.drawOrder)!), this.boneIndex(spec.bone));
      const hand = this.art.image(name, spec, bone);
      if (name === 'hand') this.handSprite = hand.getComponent(Sprite)!;
      this.hands.push({node: hand, position: [spec.localPosition[0], spec.localPosition[1]], rotation: spec.localRotationDeg ?? 0});
    }
    this.setSkin(0);
    this.setWeapon(0);
    this.update(0, false, -1);
  }

  setAimTarget(offset: {x:number;z:number}|null): void { this.targetOffset = offset; }
  setManualLookDirection(direction?: Readonly<{x:number;z:number}>): void { this.manualLook = direction ?? null; }

  getBowPoseTuning(): BowPoseTuning { return {...(this.bowPoseTuning ?? DEFAULT_BOW_POSE)}; }

  /** Instance-only preview settings; no equipment, save data or other cat is changed. */
  setBowPoseTuning(settings: Partial<BowPoseTuning> = {}): void {
    const next = {...DEFAULT_BOW_POSE};
    for (const key of Object.keys(next) as (keyof BowPoseTuning)[]) {
      const value = settings[key], [min, max] = BOW_POSE_LIMITS[key];
      if (typeof value === 'number' && Number.isFinite(value)) next[key] = Math.max(min, Math.min(max, value));
    }
    this.bowPoseTuning = next;
  }

  setAttackState(state: WeaponAttackState, dt: number): void {
    this.attackPose = this.attackAnimator.sample(this.weaponCategory, state, dt,
      this.weaponAppearance?.recoil ?? this.dynamics.recoil);
  }

  /** Cat.Skin_Reload changes the rigid body mesh and holding hand colour only. */
  setSkin(id: number): void {
    if (id === this.skinId) return;
    const skin = this.art.skinVisuals?.appearance(id);
    if (!skin && id !== 0) throw new Error(`Missing original skin artwork: ${id}`);
    const parts = (skin?.parts ?? this.rig.parts).slice().sort((a, b) => (a.drawOrder ?? 0) - (b.drawOrder ?? 0));
    const palm = parts.find(part => part.id === 'hand_left');
    this.supportPalmCenter = [...(palm?.localPosition ?? [.65, .12])];
    // All source torso sprites have centered anchors and attach to bone_1.
    const torso = parts.find(part => part.id === 'body')?.localPosition;
    this.skinBodyCenter = torso ? [torso[0], torso[1]] : undefined;
    for (let i = 0; i < this.poseFollowers.length; i++) {
      this.poseFollowers[i] = this.poseFollowers[i].filter(node => !this.skinFollowers.has(node));
    }
    this.skinFollowers.clear();
    this.holdingSkinParts.length = 0;
    for (const child of this.skinLayer.children.slice()) {
      child.active = false; child.removeFromParent(); child.destroy();
    }
    // Preserve source triangle ordering and each group's bone ancestry so
    // animated non-uniform scales do not lose shear at limb intersections.
    for (const part of parts) {
      const group = makeNode(`PartOrder_${part.id}`, this.skinLayer);
      const bone = this.createBoneChain(group, this.boneIndex(part.bone), true);
      const image = this.art.image(part.id, part, bone);
      if (part.id === 'body') {
        const material = this.art.skinVisuals?.bodyMaterial(this.art.linearSpriteMaterial, id);
        if (material) image.getComponent(Sprite)!.customMaterial = material;
      } else {
        const material = this.art.skinVisuals?.paletteMaterial(id, this.art.linearSpriteMaterial);
        if (material) image.getComponent(Sprite)!.customMaterial = material;
      }
      if (part.id === 'hand_right') this.holdingSkinParts.push(image);
    }
    if (this.handSprite) {
      const c = skin?.handColor ?? this.rig.attachments.hand?.color ?? [255, 255, 255, 255];
      this.handSprite.color = new Color(c[0], c[1], c[2], c[3]);
    }
    this.skinId = id;
    this.updateHoldingHandVisibility();
    for (let i = 0; i < this.poses.length; i++) this.setBone(i, this.poses[i]);
  }

  /** A weapon changes the source sprite/muzzle/effect, without rebuilding its cat or animation. */
  setWeapon(weaponId: number): void {
    if (this.weaponId === weaponId) return;
    this.weaponId = weaponId;
    this.gradeEffects.setWeapon(weaponId);
    const weaponDefinition = getWeapon(weaponId);
    const previousCategory = this.weaponCategory;
    this.weaponType = weaponDefinition.type;
    this.weaponCategory = weaponDefinition.category;
    this.attackAnimator?.reset();
    this.staffCastEffect?.reset();
    this.attackPose = undefined;
    for (const hand of this.hands) hand.node.angle = hand.rotation;
    this.holdingHandPosition = undefined;
    this.supportHandPosition = undefined;
    if (previousCategory === 'bow' || this.weaponCategory === 'bow') {
      const arm = this.boneIndex(this.rig.attachments.gun.bone);
      this.poses[arm].p[0] = this.rig.bones[arm].position[0];
      this.poses[arm].p[1] = this.rig.bones[arm].position[1];
    }
    if (this.weaponCategory === 'crossbow' || this.weaponCategory === 'glove' ||
      this.weaponCategory === 'staff' || previousCategory === 'staff') {
      // Restore the original sampled arm positions immediately after a bow
      // or two-hand weapon; the source gun logic only changes their angles.
      this.animator.pose(this.boneIndex(this.rig.attachments.gun.bone), this.poses[this.boneIndex(this.rig.attachments.gun.bone)]);
      this.animator.pose(this.dynamics.leftHandBone, this.poses[this.dynamics.leftHandBone]);
    }
    if (this.weaponCategory === 'bow' && !this.targetOffset) this.aimAngle = 180 - this.poses[0].r;
    this.updateHoldingHandVisibility();
    const assets = this.art.weaponVisuals;
    if (!assets) return;
    const weapon = assets.appearance(weaponId), spec = weapon.image;
    this.weaponAppearance = weapon;
    this.staffCastEffect?.setColor(weapon.castColor);
    this.gunImage.name = `${this.weaponCategory}_${weaponId}`;
    const sprite = this.gunImage.getComponent(Sprite)!;
    sprite.spriteFrame = this.art.frames.get(spec.path)!;
    // Weapon PNGs contain their full painted frame and contour. A shader
    // outline would thicken that structure and depend on obsolete canvas sizes.
    sprite.customMaterial = this.art.linearSpriteMaterial ?? null;
    const transform = this.gunImage.getComponent(UITransform)!;
    transform.setContentSize(spec.sizeUnits[0], spec.sizeUnits[1]);
    transform.setAnchorPoint(spec.anchor[0], spec.anchor[1]);
    this.gunImage.setPosition(...(spec.localPosition ?? [0, 0]), 0);
    if (this.weaponCategory === 'staff') this.gunImage.setPosition(...this.staffGripPivot(), 0);
    this.gunImage.angle = spec.localRotationDeg ?? 0;
    this.gunImage.setScale(...(spec.localScale ?? [1, 1]), 1);
    this.gunBounce.setScale(1, 1, 1);
    this.gunBounce.setPosition(0, 0, 0);
    this.gunBounce.angle = 0;
    const grip = this.weaponGripPosition();
    this.gunPivot.setPosition(grip[0], grip[1], 0);
    this.muzzle.setPosition(...weapon.muzzle.localPosition, 0);
    // Shoot_trans's original Y=90 cone rotation is represented by muzzleEmitterPose,
    // not a 2D Z rotation. The exporter supplies an optional projected Z angle only.
    this.muzzle.angle = weapon.muzzle.localRotationDeg ?? 0;
    this.muzzle.setScale(...(weapon.muzzle.localScale ?? [1, 1]), 1);
    const definition = assets.config.muzzleSkins[weapon.muzzleSkin];
    if (definition && definition !== this.muzzleDefinition) {
      this.muzzleEffect.destroy();
      this.muzzleDefinition = definition;
      this.muzzleEffect = new OriginalMuzzleEffect(this.art, this.sparkLayer,
        point => this.projectedToRig(point), order => order === 1 ? this.glowLayer : this.sparkLayer,
        definition, assets.config.images);
    }
    this.updateBowString();
  }

  /** FaceTowardEnemy changes the pivot after hand/face Update, before spawning. */
  setFacing(facing: number): void {
    // LeftAngle=(40,-45,0), RightAngle=(-40,135,0); authored pose faces left.
    this.bodyMirror = facing < 0 ? 1 : -1;
    this.body.setScale(this.bodyMirror, 1, 1);
    this.overlayBody?.setScale(this.bodyMirror, 1, 1);
    this.syncOverlayTransform();
  }

  /** Offset in this.node's projected world units, before viewport pixel scale. */
  get muzzleOffset(): {x: number; y: number} {
    this.syncOverlayTransform();
    this.rootTransform.convertToNodeSpaceAR(this.muzzle.worldPosition, this.muzzleLocal);
    return {x: this.muzzleLocal.x, y: this.muzzleLocal.y};
  }
  /** Camera-forward depth of the original Cat_Bone SortingGroup origin. */
  get sortingDepth(): number {
    const ground = unprojectGround(this.node.position);
    const x = this.rig.display.pivotOffset[0] * this.bodyMirror, y = this.rig.display.pivotOffset[1];
    const sine = Math.sin(40 * Math.PI / 180), cosine = Math.cos(40 * Math.PI / 180);
    const gx = ground.x + Math.SQRT1_2 * (x - sine * y);
    const gy = cosine * y;
    const gz = ground.z + Math.SQRT1_2 * (x + sine * y);
    return gx * CAMERA_BASIS.forwardX + gy * CAMERA_BASIS.forwardY + gz * CAMERA_BASIS.forwardZ;
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
    if (this.attackPose) this.applyWeaponAttackPose(this.attackPose);
    // The glove draws from the paw base. Preserve the original gun target
    // for both arm equations by subtracting only its visual rest position.
    const rebound = this.gunPivot.position.x - (this.weaponCategory === 'glove'
      ? this.weaponGripPosition()[0] : this.gunPosition[0]);
    const root = this.poses[0];
    const rightIndex = this.boneIndex(this.rig.attachments.gun.bone);
    const right = this.poses[rightIndex];
    if (this.weaponCategory === 'staff') {
      // Keep both arms on the original Idle/Walk baseline, including the
      // first frame after another weapon's hand-placement overlay.
      this.animator.pose(rightIndex, right);
      this.animator.pose(this.dynamics.leftHandBone, this.poses[this.dynamics.leftHandBone]);
    }
    this.holdingHandPosition = undefined;
    // Long-weapon stances are absolute, never added to last frame's offset.
    if (this.weaponCategory === 'bow') {
      right.p[0] = this.rig.bones[rightIndex].position[0];
      right.p[1] = this.rig.bones[rightIndex].position[1];
    }
    const rootAngle = root.r*Math.PI/180; const c=Math.cos(rootAngle), s=Math.sin(rootAngle);
    // Bow aiming and holding share a chest-centered pivot, independently of
    // where the drawing hand finishes its pull.
    const bowAnchor = this.weaponCategory === 'bow' && this.bowDrawnGrip ? this.bowRotationPivot() : undefined;
    const aimOrigin = bowAnchor ?? right.p;
    let desiredHand = this.weaponCategory === 'bow' ? 180 - root.r : this.dynamics.handRestAngle;
    if (this.targetOffset) {
      // Ordinary guns target nearHitPoint.XZ at the right hand's own world Y.
      // InverseTransformDirection ignores parent scale (unlike a point inverse).
      const px=this.rig.display.pivotOffset[0]+this.rig.display.scale*(root.p[0]+c*root.s[0]*aimOrigin[0]-s*root.s[1]*aimOrigin[1]);
      const py=this.rig.display.pivotOffset[1]+this.rig.display.scale*(root.p[1]+s*root.s[0]*aimOrigin[0]+c*root.s[1]*aimOrigin[1]);
      const hx=this.bodyMirror*Math.SQRT1_2*px-Math.SQRT1_2*Math.sin(40*Math.PI/180)*py;
      const hz=this.bodyMirror*Math.SQRT1_2*px+Math.SQRT1_2*Math.sin(40*Math.PI/180)*py;
      const hy=Math.cos(40*Math.PI/180)*py;
      let dx=this.targetOffset.x-hx,dz=this.targetOffset.z-hz,dy=0;
      if (this.weaponType === 'MISSILE') {
        // Cat.UpdateHandRotation aims along the initial arc tangent from HandR
        // to the target transform (Y=0), then uses a point ten units along it.
        // ARM64 0x2b3b12c..294: the factor 4 is not a firing height.
        dy=-hy+Math.hypot(dx,dz)*Math.fround(0.4)*4;
        const magnitude=Math.hypot(dx,dy,dz);
        if(magnitude>0.00001){const scale=10/magnitude;dx*=scale;dy*=scale;dz*=scale;}
        else dx=dy=dz=0;
      }
      desiredHand=this.aimAngle;
      if ((bowAnchor || dx*dx+dy*dy+dz*dz > hx*hx+hy*hy+hz*hz) && dx*dx+dy*dy+dz*dz > CAT_DIRECTION_SQUARED_THRESHOLD) {
        const x=this.bodyMirror*Math.SQRT1_2*(dx+dz);
        const y=Math.SQRT1_2*Math.sin(40*Math.PI/180)*(dz-dx)+Math.cos(40*Math.PI/180)*dy;
        desiredHand=Math.atan2(-s*x+c*y,c*x+s*y)*180/Math.PI;
      }
    }
    this.aimAngle+=catAngleDelta(this.aimAngle,desiredHand)*Math.min(1,this.dynamics.handRotateSpeed*dt);
    right.r=this.aimAngle + (this.attackPose?.rightArmRotation ?? 0);
    // The support arm points at Gun_Pivot every frame, including its recoil.
    const left=this.poses[this.dynamics.leftHandBone];
    if (this.weaponCategory === 'bow') {
      // Sample the original scale before applying an absolute draw pose.
      this.animator.pose(this.dynamics.leftHandBone, left);
    }
    const ar=right.r*Math.PI/180,ac=Math.cos(ar),as=Math.sin(ar);
    const reach = this.attackPose?.holdingArmReach ?? 0;
    if (bowAnchor && this.bowDrawnGrip) {
      // The outer palm follows one circle around the chest at 76% of its
      // original reach. The drawing hand pulls from a separate fixed start.
      const grip = this.weaponGripPosition();
      const radius = Math.hypot(...this.bowDrawnGrip) * (this.bowPoseTuning ?? DEFAULT_BOW_POSE).holdingRadiusScale;
      const tx = radius - grip[0] - (this.attackPose?.weaponOffset[0] ?? 0);
      const ty = -grip[1] - (this.attackPose?.weaponOffset[1] ?? 0);
      right.p[0] = bowAnchor[0] + ac * tx * right.s[0] - as * ty * right.s[1];
      right.p[1] = bowAnchor[1] + as * tx * right.s[0] + ac * ty * right.s[1];
      this.holdingHandPosition = [right.p[0], right.p[1]];
    } else if (reach) {
      right.p[0] += ac * reach * right.s[0];
      right.p[1] += as * reach * right.s[1];
      this.holdingHandPosition = [right.p[0], right.p[1]];
    }
    const gx=(this.gunPosition[0]+rebound)*right.s[0],gy=this.gunPosition[1]*right.s[1];
    const lx=(right.p[0]+ac*gx-as*gy-left.p[0])*root.s[0];
    const ly=(right.p[1]+as*gx+ac*gy-left.p[1])*root.s[1];
    if ((lx*lx+ly*ly)*this.rig.display.scale*this.rig.display.scale >= CAT_DIRECTION_SQUARED_THRESHOLD) {
      left.r=Math.atan2(ly,lx)*180/Math.PI;
    }
    this.supportHandPosition = undefined;
    if (this.attackPose) {
      const support = this.bowSupportGrip ?? this.attackPose.supportGripOffset;
      if (support) {
        // Other two-hand weapons use the registered support point directly.
        const grip = this.weaponGripPosition();
        const tx = grip[0] + this.attackPose.weaponOffset[0] + support[0];
        const ty = grip[1] + this.attackPose.weaponOffset[1] + support[1];
        let targetX = right.p[0] + ac * tx * right.s[0] - as * ty * right.s[1];
        let targetY = right.p[1] + as * tx * right.s[0] + ac * ty * right.s[1];
        const originalLeft = this.rig.bones[this.dynamics.leftHandBone];
        const center = this.supportPalmCenter ?? this.rig.parts.find(part => part.id === 'hand_left')?.localPosition ?? [.65, .12];
        if (this.weaponCategory === 'bow') {
          // The resting palm sits at the established chest center, not at the
          // old gun-support pose. Aim only turns it there; drawing translates
          // it straight away from the holding palm along the aiming axis.
          const tuning = this.bowPoseTuning ?? DEFAULT_BOW_POSE;
          const start = this.bowDrawingStart();
          const draw = this.bowHandDrawOffset ?? [-.92 * (this.attackPose.bowHandPull ?? 0), 0];
          const distance = Math.hypot(...draw) * right.s[0];
          const direction = ar + tuning.drawDirectionAngle * Math.PI / 180;
          targetX = start[0] - Math.cos(direction) * distance;
          targetY = start[1] - Math.sin(direction) * distance;
          left.r = right.r + originalLeft.rotationDeg - this.rig.bones[rightIndex].rotationDeg + tuning.drawHandAngle;
        } else left.r = Math.atan2(targetY - originalLeft.position[1], targetX - originalLeft.position[0]) * 180 / Math.PI;
        const la = left.r * Math.PI / 180;
        left.p[0] = targetX - Math.cos(la) * center[0] * left.s[0] + Math.sin(la) * center[1] * left.s[1];
        left.p[1] = targetY - Math.sin(la) * center[0] * left.s[0] - Math.cos(la) * center[1] * left.s[1];
        this.supportHandPosition = [left.p[0], left.p[1]];
      } else if (this.weaponCategory !== 'crossbow' && this.weaponCategory !== 'glove' && this.weaponCategory !== 'staff') {
        // Single-hand weapons leave the free paw in a relaxed walking pose.
        left.r = this.rig.bones[this.dynamics.leftHandBone].rotationDeg;
        left.p[0] = this.rig.bones[this.dynamics.leftHandBone].position[0];
        left.p[1] = this.rig.bones[this.dynamics.leftHandBone].position[1];
      }
    }
    // Face_Pivot rotates, but Follow moves only the eyes/mouth Sprite position.
    let faceTarget=90;
    // Target has priority; main-cat manual look uses raw joystick direction,
    // without the anisotropic movement-speed correction or a fabricated target.
    const faceDir=this.targetOffset ?? this.manualLook;
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
    this.syncBowStringToDrawingHand();
  }

  updateEffects(dt: number): void {
    this.syncOverlayTransform();
    const ground=unprojectGround(this.node.position);
    this.gradeEffects.update(dt,[ground.x,0,ground.z]);
    // Bounce_Start only resets time; a newly started coroutine first yields
    // null. An already active bounce resumes this frame after a retrigger.
    if (!this.attackPose && this.recoilJustStarted) this.recoilJustStarted = false;
    else if (!this.attackPose && Number.isFinite(this.recoil)) {
      this.recoil += dt;
      const definition=this.weaponAppearance?.recoil??this.dynamics.recoil;
      if (this.recoil > definition.duration) this.recoil = Infinity;
      const pulse=catRecoilWeight(this.recoil,definition.duration);
      const rebound=definition.position[0]*pulse;
      const grip=this.weaponCategory==='glove'?this.weaponGripPosition():this.gunPosition;
      this.gunPivot.setPosition(grip[0]+rebound,grip[1],0);
      for (const hand of this.hands) hand.node.setPosition(hand.position[0]+rebound,hand.position[1],0);
      this.gunBounce.setScale(lerp(1,definition.gunScale[0],pulse),lerp(1,definition.gunScale[1],pulse),1);
    }
    const bowAnchor = this.weaponCategory === 'bow' && this.holdingHandPosition ? this.bowRotationPivot() : undefined;
    const drawStart = bowAnchor && this.supportHandPosition ? this.bowDrawingStart() : undefined;
    this.animator.update(dt,this.walking);
    const rightIndex=this.boneIndex(this.rig.attachments.gun.bone);
    for (let i=0;i<this.poses.length;i++) {
      const pose=this.poses[i],proceduralAngle=pose.r;
      this.animator.pose(i,pose);
      // Neither source clip binds the two arm rotations: retain Cat.Update's
      // local angles while their animated parent changes beneath them.
      if (i===rightIndex || i===this.dynamics.leftHandBone) pose.r=proceduralAngle;
      if (i === rightIndex && this.holdingHandPosition) {
        pose.p[0] = this.holdingHandPosition[0]; pose.p[1] = this.holdingHandPosition[1];
      }
      if (i === this.dynamics.leftHandBone && this.supportHandPosition) {
        pose.p[0] = this.supportHandPosition[0]; pose.p[1] = this.supportHandPosition[1];
      }
      this.setBone(i,pose);
    }
    if (bowAnchor) {
      // Idle/Walk can change the root after aiming. Both the holding orbit
      // and the fixed drawing start follow the same chest center.
      const next = this.bowRotationPivot(), dx = next[0] - bowAnchor[0], dy = next[1] - bowAnchor[1];
      const nextStart = drawStart ? this.bowDrawingStart() : undefined;
      for (const [index, position] of [[rightIndex, this.holdingHandPosition],
        [this.dynamics.leftHandBone, this.supportHandPosition]] as const) {
        if (!position) continue;
        position[0] += index === this.dynamics.leftHandBone && nextStart && drawStart ? nextStart[0] - drawStart[0] : dx;
        position[1] += index === this.dynamics.leftHandBone && nextStart && drawStart ? nextStart[1] - drawStart[1] : dy;
        const pose = this.poses[index]; pose.p[0] = position[0]; pose.p[1] = position[1];
        this.setBone(index, pose);
      }
    }
    this.syncBowStringToDrawingHand();
    this.muzzleEffect.update(dt,this.muzzleEmitterPose(),this.bodyMirror,this.rig.display);
    if (this.weaponCategory === 'staff' && this.attackPose?.staffCast) this.staffCastEffect?.update(this.attackPose.staffCast);
    else this.staffCastEffect?.reset();
  }

  fire(): void {
    if (!this.attackPose) {
      if (!Number.isFinite(this.recoil)) this.recoilJustStarted=true;
      this.recoil=0;
    }
    const pose=this.muzzleEmitterPose();
    this.muzzleEffect.fire(pose);
    this.muzzleEffect.update(0,pose,this.bodyMirror,this.rig.display);
    if (this.weaponCategory === 'staff' && this.attackPose?.staffCast) this.staffCastEffect?.update(this.attackPose.staffCast);
  }
  reset(): void {
    this.gradeEffects.reset();
    this.animator.reset(); this.recoil = Infinity; this.targetOffset=null; this.manualLook=null;
    this.recoilJustStarted=false;this.walking=false;
    this.attackAnimator?.reset();this.attackPose=undefined;this.holdingHandPosition=undefined;this.supportHandPosition=undefined;
    this.staffCastEffect?.reset();
    for (let i=0;i<this.poses.length;i++) this.animator.pose(i,this.poses[i]);
    const grip = this.weaponGripPosition();
    this.gunPivot.setPosition(grip[0],grip[1],0);
    for (const hand of this.hands) {
      hand.node.setPosition(hand.position[0],hand.position[1],0);
      hand.node.angle = hand.rotation;
    }
    this.gunBounce.setScale(1,1,1);
    this.gunBounce.setPosition(0,0,0);
    this.gunBounce.angle=0;
    this.aimAngle=this.weaponCategory === 'bow' ? 180 - this.poses[0].r : 130;
    this.faceAngle=90;this.muzzleEffect.reset();this.updateBowString();
    this.update(0, false, -1);
    this.syncOverlayTransform();
  }

  destroy(): void {
    this.gradeEffects.destroy();
    this.muzzleEffect.destroy();
    this.staffCastEffect?.destroy();
    if(this.shadow.isValid)this.shadow.destroy();
    if(this.overlayNode?.isValid)this.overlayNode.destroy();
    if(this.node.isValid)this.node.destroy();
  }

  setActive(active: boolean): void {
    this.node.active=active;this.shadow.active=active;
    if(this.overlayNode)this.overlayNode.active=active;
    this.gradeEffects.setActive(active);
    if(!active){this.muzzleEffect.reset();this.staffCastEffect?.reset();}
  }

  private syncOverlayTransform(): void {
    if (!this.overlayNode) return;
    // World transforms allow the two pass roots to be independent without
    // changing any socket or palm location. Facing lives one level below.
    this.overlayNode.setWorldPosition(this.node.worldPosition);
    this.overlayNode.setWorldRotation(this.node.worldRotation);
    this.overlayNode.setWorldScale(this.node.worldScale);
    this.overlayNode.active = this.node.active;
  }

  private projectedToRig(point:{x:number;y:number}):{x:number;y:number} {
    const d=this.rig.display;
    return {x:((point.x-this.node.position.x)*this.bodyMirror-d.pivotOffset[0])/d.scale,
      y:((point.y-this.node.position.y)/d.projectionScaleY-d.pivotOffset[1])/d.scale};
  }

  private weaponGripPosition(): [number, number] {
    if (this.weaponCategory === 'glove') {
      if (!this.gloveHandBase) {
        const hand = this.rig.attachments.hand, scale = hand.localScale ?? [1, 1];
        const x = (GLOVE_HAND_BASE_PX[0] / hand.sizePx[0] - hand.anchor[0]) * hand.sizeUnits[0] * scale[0];
        const y = (1 - GLOVE_HAND_BASE_PX[1] / hand.sizePx[1] - hand.anchor[1]) * hand.sizeUnits[1] * scale[1];
        const a = (hand.localRotationDeg ?? 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        this.gloveHandBase = [hand.localPosition[0] + c * x - s * y, hand.localPosition[1] + s * x + c * y];
      }
      return this.gloveHandBase;
    }
    // Bow grips register on the palm; other weapons retain the source gun pivot.
    return this.weaponCategory === 'bow'
      ? this.rig.attachments.hand.localPosition : this.gunPosition;
  }

  private bowRotationPivot(): [number, number] {
    // Center horizontally on the current torso in its parent plane, then lift
    // the previous chest height slightly. Root +X is only approximately up;
    // inverse rotation keeps the pivot on the visual vertical centerline even
    // while walking. Both render passes share this same sampled pose.
    const root = this.poses[0], a = root.r * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const torso = this.skinBodyCenter ?? this.rig.parts.find(part => part.id === 'body')?.localPosition ?? [0, 0];
    const tuning = this.bowPoseTuning ?? DEFAULT_BOW_POSE;
    const x = c * torso[0] * root.s[0] - s * torso[1] * root.s[1] + tuning.pivotX;
    const y = s * 2.60 * root.s[0] + .22 + tuning.pivotY;
    return [(c * x + s * y) / root.s[0], (-s * x + c * y) / root.s[1]];
  }

  private bowDrawingStart(): [number, number] {
    const pivot = this.bowRotationPivot(), tuning = this.bowPoseTuning ?? DEFAULT_BOW_POSE;
    const root = this.poses[0], a = root.r * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [pivot[0] + (c * tuning.drawHandX + s * tuning.drawHandY) / root.s[0],
      pivot[1] + (-s * tuning.drawHandX + c * tuning.drawHandY) / root.s[1]];
  }

  private updateHoldingHandVisibility(): void {
    // A glove replaces the whole holding paw from its base. Hide both hand
    // representations so compression cannot reveal fingers or their outline.
    const visible = this.weaponCategory !== 'glove';
    for (const hand of this.hands ?? []) hand.node.active = visible;
    for (const part of this.holdingSkinParts ?? []) part.active = visible;
    const layer = this.weaponDrawLayer;
    if (layer?.parent) layer.setSiblingIndex(this.weaponCategory === 'glove'
      ? layer.parent.children.length - 1 : this.weaponDrawIndex);
  }

  private applyWeaponAttackPose(pose: WeaponAttackPose): void {
    const grip = this.weaponGripPosition();
    this.gunPivot.setPosition(grip[0] + pose.weaponOffset[0], grip[1] + pose.weaponOffset[1], 0);
    this.gunBounce.angle = pose.weaponRotation;
    this.gunBounce.setScale(pose.weaponScale[0], pose.weaponScale[1], 1);
    if (this.weaponCategory === 'staff') {
      // Artwork is registered on the source holding palm while Gun_Pivot
      // remains the support arm's original aim target. Compensate the bounce
      // translation so rotation takes place about that palm, not Gun_Pivot.
      const q = this.staffGripPivot(), angle = pose.weaponRotation * Math.PI / 180;
      const c = Math.cos(angle), s = Math.sin(angle);
      this.gunBounce.setPosition(q[0] - c * q[0] * pose.weaponScale[0] + s * q[1] * pose.weaponScale[1],
        q[1] - s * q[0] * pose.weaponScale[0] - c * q[1] * pose.weaponScale[1], 0);
    } else this.gunBounce.setPosition(0, 0, 0);
    for (const hand of this.hands) {
      hand.node.setPosition(hand.position[0] + pose.weaponOffset[0], hand.position[1] + pose.weaponOffset[1], 0);
      // Rotate the holding palm and its outline about their centered anchors.
      // Arm positions and the free palm continue to use the original gun pose.
      hand.node.angle = hand.rotation + (this.weaponCategory === 'staff' ? pose.staffCast?.holdingRotation ?? 0 : 0);
    }
    this.updateBowString(pose);
  }

  private staffGripPivot(): [number, number] {
    const gun = this.rig.attachments.gun, hand = this.rig.attachments.hand.localPosition;
    const angle = -(gun.localRotationDeg ?? 0) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    const dx = hand[0] - this.gunPosition[0], dy = hand[1] - this.gunPosition[1], scale = gun.localScale ?? [1, 1];
    return [(c * dx - s * dy) / scale[0], (s * dx + c * dy) / scale[1]];
  }

  private updateBowString(pose?: WeaponAttackPose): void {
    const appearance = this.weaponAppearance;
    const definition = this.weaponCategory === 'bow' ? appearance?.bowString : undefined;
    this.bowSupportGrip = undefined;
    this.bowHandDrawOffset = undefined;
    this.bowDrawnGrip = undefined;
    if (!definition || !appearance) {
      if (this.bowStringNode) this.bowStringNode.active = false;
      return;
    }
    if (!this.bowStringGraphic) {
      this.bowStringNode = makeNode('BowString', this.gunImage);
      this.bowStringGraphic = this.bowStringNode.addComponent(Graphics);
      if (this.art.linearGraphicsMaterial) this.bowStringGraphic.customMaterial = this.art.linearGraphicsMaterial;
    }
    this.bowStringNode!.active = true;
    const graphic = this.bowStringGraphic, image = appearance.image;
    if (this.bowStringDefinition !== definition) {
      this.bowStringDefinition = definition;
      graphic.strokeColor = new Color(...(definition.color ?? [76, 49, 30, 255]));
    }
    graphic.lineWidth = (definition.lineWidthPx ?? 1.5) * BATTLE_BOW_STRING_WIDTH_SCALE * image.sizeUnits[0] / image.sizePx[0];
    const local = (point: [number, number]): [number, number] => [
      (point[0] / image.sizePx[0] - image.anchor[0]) * image.sizeUnits[0],
      (1 - point[1] / image.sizePx[1] - image.anchor[1]) * image.sizeUnits[1],
    ];
    const drawScale = (this.bowPoseTuning ?? DEFAULT_BOW_POSE).drawDistanceScale;
    const points = bowStringPoints(definition, pose ?? {}, drawScale);
    const upper = local(points.upper), lower = local(points.lower), nock = local(points.nock), hand = local(points.hand);
    graphic.clear(); graphic.moveTo(...upper); graphic.lineTo(...nock); graphic.lineTo(...lower); graphic.stroke();
    // Extract the pull displacement independently of the fixed starting point.
    // Convert through the sprite, bounce and pivot instead of assuming a size,
    // image anchor or mirrored Y scale shared by every bow grade.
    const rotate = (p: [number, number], scale: [number, number], degrees: number): [number, number] => {
      const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      return [c * p[0] * scale[0] - s * p[1] * scale[1], s * p[0] * scale[0] + c * p[1] * scale[1]];
    };
    const gun = this.rig.attachments.gun;
    const gripPoint = (point: [number, number]): [number, number] => {
      const p = rotate(point, image.localScale ?? [1, 1], image.localRotationDeg ?? 0);
      p[0] += image.localPosition?.[0] ?? 0; p[1] += image.localPosition?.[1] ?? 0;
      const bounce = rotate(p, pose?.weaponScale ?? [1, 1], pose?.weaponRotation ?? 0);
      return rotate(bounce, gun.localScale ?? [1, 1], gun.localRotationDeg ?? 0);
    };
    this.bowSupportGrip = gripPoint(hand);
    const ready = gripPoint(local(bowStringPoints(definition, {bowHandPull: 0}, drawScale).hand));
    this.bowHandDrawOffset = [this.bowSupportGrip[0] - ready[0], this.bowSupportGrip[1] - ready[1]];
    // Preserve the original full-draw span as the size reference for the
    // shortened holding radius. Hand retreat only shifts the drawing path.
    this.bowDrawnGrip = gripPoint(local([definition.bracePx[0] - definition.drawPx, definition.bracePx[1]]));
  }

  private syncBowStringToDrawingHand(): void {
    const appearance = this.weaponAppearance, pose = this.attackPose;
    if (this.weaponCategory !== 'bow' || !appearance?.bowString || !pose || !this.bowStringGraphic) return;
    const image = appearance.image, definition = appearance.bowString;
    const left = this.poses[this.dynamics.leftHandBone], right = this.poses[this.boneIndex(this.rig.attachments.gun.bone)];
    const center = this.supportPalmCenter ?? this.rig.parts.find(part => part.id === 'hand_left')?.localPosition ?? [.65, .12];
    const a = left.r * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    let palm: [number, number] = [left.p[0] + c * center[0] * left.s[0] - s * center[1] * left.s[1],
      left.p[1] + s * center[0] * left.s[0] + c * center[1] * left.s[1]];
    const inverse = (point: [number, number], offset: [number, number], scale: [number, number], angle: number): [number, number] => {
      const r = angle * Math.PI / 180, x = point[0] - offset[0], y = point[1] - offset[1];
      return [(Math.cos(r) * x + Math.sin(r) * y) / scale[0], (-Math.sin(r) * x + Math.cos(r) * y) / scale[1]];
    };
    const gun = this.rig.attachments.gun, grip = this.weaponGripPosition();
    palm = inverse(palm, right.p, right.s, right.r);
    palm = inverse(palm, [grip[0] + pose.weaponOffset[0], grip[1] + pose.weaponOffset[1]],
      gun.localScale ?? [1, 1], gun.localRotationDeg ?? 0);
    palm = inverse(palm, [0, 0], pose.weaponScale, pose.weaponRotation);
    palm = inverse(palm, image.localPosition ?? [0, 0], image.localScale ?? [1, 1], image.localRotationDeg ?? 0);
    const points = bowStringPoints(definition, pose, (this.bowPoseTuning ?? DEFAULT_BOW_POSE).drawDistanceScale);
    const local = (point: [number, number]): [number, number] => [
      (point[0] / image.sizePx[0] - image.anchor[0]) * image.sizeUnits[0],
      (1 - point[1] / image.sizePx[1] - image.anchor[1]) * image.sizeUnits[1]];
    const upper = local(points.upper), lower = local(points.lower), nock = local(points.nock);
    // Keep the held string on the moving palm. Release and recovery blend
    // through the original spring motion while the hand returns to its start.
    const held = pose.phase === 'release' ? 0 : pose.phase === 'recover' ? 1 - (pose.bowHandPull ?? 0) : 1;
    nock[0] += (palm[0] - nock[0]) * held; nock[1] += (palm[1] - nock[1]) * held;
    const graphic = this.bowStringGraphic;
    graphic.clear(); graphic.moveTo(...upper); graphic.lineTo(...nock); graphic.lineTo(...lower); graphic.stroke();
  }

  private muzzleEmitterPose():MuzzleEmitterPose {
    const offset=this.muzzleOffset;
    const emitter=this.muzzleDefinition.emitter;
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
      xAxis:{x:0,y:-this.bodyMirror*Math.sin((emitter.projectionGapDegrees??4.736)*Math.PI/180)*normalScale},
      yAxis:axis(0,1),zAxis:axis(1,0)};
  }

  private boneIndex(id: string | number): number {
    if (typeof id === 'number') return id;
    const index = this.rig.bones.findIndex(b => b.id === id || b.name === id);
    if (index < 0) throw new Error(`Unknown original bone: ${id}`);
    return index;
  }

  private createBoneChain(parent: Node, boneIndex: number, skin = false): Node {
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
      if (skin) this.skinFollowers.add(node);
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
