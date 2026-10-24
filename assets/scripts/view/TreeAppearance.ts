import { Color, gfx, Node, Sprite } from 'cc';
import { DecimalAmount, projectWorld, TreeState, unprojectGround, Vec2 } from '../core';
import { ArtLibrary, ImageSpec, makeNode } from './ArtLibrary';
import { TreeAppearanceConfig } from './OriginalFeedbackAssets';
import { originalBounceScale } from './OriginalFeedbackMath';
import { OriginalTreeAmbient } from './OriginalTreeAmbient';
import { CAMERA_BASIS } from '../core/projection';
import { treeHitSurface } from './TreeHitSurface';

/** Tree_0's original Bounce_Custom and SpriteFill, with no invented fall/fade/rotation. */
export class TreeAppearance {
  readonly node: Node;
  readonly sprite: Node;
  readonly bar: Node;
  readonly healthRoot: Node;
  readonly healthFillRoot: Node;
  private readonly bounce: Node;
  private readonly healthBounce: Node;
  private readonly healthFillBounce: Node;
  private readonly fill: Sprite;
  private elapsed = 0;
  private bouncing = false;
  private healthRevealed = false;
  private waitingForNextFrame = false;
  private positionX = NaN;
  private positionZ = NaN;
  private lastHealth?: TreeState['health'];
  private lastMaxHealth?: TreeState['maxHealth'];
  private readonly healthFollowsBounce: boolean;
  private readonly ambient?: OriginalTreeAmbient;
  private readonly boundsCenter: [number,number];
  private readonly spriteSpec: ImageSpec;

  constructor(art: ArtLibrary, tree: TreeState, parent: Node, private readonly config: TreeAppearanceConfig, healthParent: Node = parent, healthFillParent: Node = healthParent) {
    const stages = art.catalog.stageTrees;
    if (stages) this.config = config = stages[tree.degree === 3 ? 'boss' : 'normal'];
    this.healthFollowsBounce = (config.healthBar as {followsBounce?: boolean}).followsBounce !== false;
    this.node = makeNode(`Tree_${tree.id}`, parent);
    const plane = makeNode('OriginalBillboard', this.node);
    plane.setScale(1, config.projectionScaleY, 1);
    this.bounce = makeNode('Bounce_Custom', plane);
    const key = tree.degree === 0 ? 'tree_pine' : 'tree_round';
    const appearance = stages ? {sprite: stages.treeSprites[(tree.stageIndex * 4 + tree.degree) % 40],
      displayScale: stages[tree.degree === 3 ? 'boss' : 'normal'].skinScale} : art.catalog.enemies[key];
    const spriteSpec=appearance.sprite ?? appearance;
    this.spriteSpec=spriteSpec;
    const propScale = stages ? (spriteSpec.localScale ?? [1, 1]) : [1, 1];
    this.boundsCenter=[(.5-spriteSpec.anchor[0])*spriteSpec.sizeUnits[0],(.5-spriteSpec.anchor[1])*spriteSpec.sizeUnits[1]];
    this.sprite = art.image(key, spriteSpec, this.bounce);
    this.sprite.setScale(appearance.displayScale[0] * propScale[0], appearance.displayScale[1] * propScale[1], 1);
    if (tree.degree === 3 && stages?.boss.sparkles) {
      const ambientRoot = makeNode('PropAmbientScale', this.node);
      ambientRoot.setScale(propScale[0], propScale[1], 1);
      this.ambient = new OriginalTreeAmbient(art, ambientRoot, stages.boss.sparkles);
    }

    // Unity orders every health bar above every tree. Mirror the same parent
    // transforms in a separate layer rather than sorting by tree-root depth.
    this.healthRoot = makeNode(`TreeHealth_${tree.id}`, healthParent);
    const healthPlane = makeNode('OriginalBillboard', this.healthRoot);
    healthPlane.setScale(1, config.projectionScaleY, 1);
    this.healthBounce = makeNode('Bounce_Custom', healthPlane);
    this.bar = makeNode('Slider_Default10', this.healthBounce);
    const bar = config.healthBar;
    this.bar.setPosition(bar.position[0] * propScale[0], bar.position[1] * propScale[1], 0);
    this.bar.setScale(bar.scale[0], bar.scale[1], 1);
    art.image('Background', bar.background, this.bar);
    // GO3 Default10 background and Default11 fill belong to the final Overlay
    // pass. Duplicate their transform chain so the original bounce stays shared.
    this.healthFillRoot = makeNode(`TreeHealthFill_${tree.id}`, healthFillParent);
    const fillPlane = makeNode('OriginalBillboard', this.healthFillRoot);
    fillPlane.setScale(1, config.projectionScaleY, 1);
    this.healthFillBounce = makeNode('Bounce_Custom', fillPlane);
    const fillBar = makeNode('Slider_Default11', this.healthFillBounce);
    fillBar.setPosition(bar.position[0] * propScale[0], bar.position[1] * propScale[1], 0);
    fillBar.setScale(bar.scale[0], bar.scale[1], 1);
    this.fill = art.image('Fill_Default11', bar.fill, fillBar).getComponent(Sprite)!;
    if (art.originalHealthFillMaterial) {
      (this.fill as any).srcBlendFactor = gfx.BlendFactor.ONE;
      this.fill.customMaterial = art.originalHealthFillMaterial;
    }
    this.fill.type = Sprite.Type.FILLED;
    this.fill.fillType = Sprite.FillType.HORIZONTAL;
    this.fill.fillStart = 0;
    this.fill.color = new Color(...bar.fillColor);
    this.reset(tree);
  }

  /** Source SpriteRenderer center in the original 40-degree billboard plane. */
  get sortingDepth():number {
    const x=(this.boundsCenter[0]*this.sprite.scale.x+this.sprite.position.x)*this.bounce.scale.x;
    const y=(this.boundsCenter[1]*this.sprite.scale.y+this.sprite.position.y)*this.bounce.scale.y;
    const s=Math.sin(40*Math.PI/180),c=Math.cos(40*Math.PI/180);
    return (this.positionX+Math.SQRT1_2*(x-s*y))*CAMERA_BASIS.forwardX+
      c*y*CAMERA_BASIS.forwardY+(this.positionZ+Math.SQRT1_2*(x+s*y))*CAMERA_BASIS.forwardZ;
  }

  /** Match effects to the current painted silhouette, including its hit bounce. */
  impactPosition(position: Vec2, height: number): Vec2 {
    const origin = projectWorld({ x: this.positionX, z: this.positionZ });
    const bx = this.bounce.scale.x, by = this.bounce.scale.y * this.config.projectionScaleY;
    origin.x += this.sprite.position.x * bx; origin.y += this.sprite.position.y * by;
    const angle = this.sprite.angle * Math.PI / 180, cs = Math.cos(angle), sn = Math.sin(angle);
    const point = treeHitSurface(projectWorld(position, height), this.spriteSpec, origin,
      { x: cs * this.sprite.scale.x * bx, y: sn * this.sprite.scale.x * by },
      { x: -sn * this.sprite.scale.y * bx, y: cs * this.sprite.scale.y * by });
    return unprojectGround({ x: point.x, y: point.y - CAMERA_BASIS.upY * height });
  }

  hit(): void {
    // Enemy.Slider_Reload reveals the bar on every accepted Damaged call,
    // including weak hits whose InfVal subtraction leaves the HP unchanged.
    this.healthRevealed = true;
    // A new Coroutine_NoRepeat first yields null. Retriggering an existing
    // coroutine only resets its timer, without adding another yielded frame.
    if (!this.bouncing) this.waitingForNextFrame = true;
    this.elapsed = 0;
    this.bouncing = true;
  }

  update(dt: number, tree: TreeState): void {
    if (tree.position.x !== this.positionX || tree.position.z !== this.positionZ) {
      this.positionX = tree.position.x; this.positionZ = tree.position.z;
      const p = projectWorld(tree.position);
      this.node.setPosition(p.x, p.y, 0);
      this.healthRoot.setPosition(p.x, p.y, 0);
      this.healthFillRoot.setPosition(p.x, p.y, 0);
    }
    this.node.active = tree.alive;
    this.healthRoot.active = tree.alive && this.healthRevealed;
    this.healthFillRoot.active = this.healthRoot.active;
    if (!tree.alive) return;
    this.ambient?.update(dt);
    // DecimalAmount values are frozen. Enemy.Slider_Reload changes the fill
    // only with HP, rather than repeating large-number division every frame.
    if (tree.health !== this.lastHealth || tree.maxHealth !== this.lastMaxHealth) {
      this.fill.fillRange = DecimalAmount.from(tree.health).ratio(DecimalAmount.from(tree.maxHealth));
      this.lastHealth = tree.health; this.lastMaxHealth = tree.maxHealth;
    }
    if (!this.bouncing) return;
    if (this.waitingForNextFrame) { this.waitingForNextFrame = false; return; }
    this.elapsed += Math.max(0, dt);
    const scale = originalBounceScale(this.elapsed, this.config.hit.duration, this.config.hit.peakScale);
    this.bounce.setScale(scale.x, scale.y, 1);
    if (this.healthFollowsBounce) {
      this.healthBounce.setScale(scale.x, scale.y, 1);
      this.healthFillBounce.setScale(scale.x, scale.y, 1);
    }
    if (this.elapsed > this.config.hit.duration) {
      this.elapsed = 0;
      this.bouncing = false;
    }
  }

  reset(tree: TreeState): void {
    this.elapsed = 0;
    this.bouncing = false;
    this.healthRevealed = false;
    this.waitingForNextFrame = false;
    this.lastHealth = this.lastMaxHealth = undefined;
    this.ambient?.reset();
    this.bounce.setScale(1, 1, 1);
    this.healthBounce.setScale(1, 1, 1);
    this.healthFillBounce.setScale(1, 1, 1);
    this.update(0, tree);
  }

  destroy(): void { this.node.destroy(); this.healthRoot.destroy(); this.healthFillRoot.destroy(); }
}
