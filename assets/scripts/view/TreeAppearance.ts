import { Color, gfx, Node, Sprite } from 'cc';
import { projectWorld, TreeState } from '../core';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { TreeAppearanceConfig } from './OriginalFeedbackAssets';
import { originalBounceScale } from './OriginalFeedbackMath';

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
  private waitingForNextFrame = false;
  private positionX = NaN;
  private positionZ = NaN;

  constructor(art: ArtLibrary, tree: TreeState, parent: Node, private readonly config: TreeAppearanceConfig, healthParent: Node = parent, healthFillParent: Node = healthParent) {
    this.node = makeNode(`Tree_${tree.id}`, parent);
    const plane = makeNode('OriginalBillboard', this.node);
    plane.setScale(1, config.projectionScaleY, 1);
    this.bounce = makeNode('Bounce_Custom', plane);
    const key = tree.degree === 0 ? 'tree_pine' : 'tree_round';
    const appearance = art.catalog.enemies[key];
    this.sprite = art.image(key, appearance.sprite ?? appearance, this.bounce);
    this.sprite.setScale(appearance.displayScale[0], appearance.displayScale[1], 1);

    // Unity orders every health bar above every tree. Mirror the same parent
    // transforms in a separate layer rather than sorting by tree-root depth.
    this.healthRoot = makeNode(`TreeHealth_${tree.id}`, healthParent);
    const healthPlane = makeNode('OriginalBillboard', this.healthRoot);
    healthPlane.setScale(1, config.projectionScaleY, 1);
    this.healthBounce = makeNode('Bounce_Custom', healthPlane);
    this.bar = makeNode('Slider_Default10', this.healthBounce);
    const bar = config.healthBar;
    this.bar.setPosition(bar.position[0], bar.position[1], 0);
    this.bar.setScale(bar.scale[0], bar.scale[1], 1);
    art.image('Background', bar.background, this.bar);
    // Default10 background and Default11 fill must straddle projectile order10.
    // Duplicate only their transform chain so the original bounce stays shared.
    this.healthFillRoot = makeNode(`TreeHealthFill_${tree.id}`, healthFillParent);
    const fillPlane = makeNode('OriginalBillboard', this.healthFillRoot);
    fillPlane.setScale(1, config.projectionScaleY, 1);
    this.healthFillBounce = makeNode('Bounce_Custom', fillPlane);
    const fillBar = makeNode('Slider_Default11', this.healthFillBounce);
    fillBar.setPosition(bar.position[0], bar.position[1], 0);
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

  hit(): void {
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
    this.healthRoot.active = tree.alive && tree.health < tree.maxHealth;
    this.healthFillRoot.active = this.healthRoot.active;
    if (!tree.alive) return;
    this.fill.fillRange = Math.max(0, Math.min(1, tree.health / tree.maxHealth));
    if (!this.bouncing) return;
    if (this.waitingForNextFrame) { this.waitingForNextFrame = false; return; }
    this.elapsed += Math.max(0, dt);
    const scale = originalBounceScale(this.elapsed, this.config.hit.duration, this.config.hit.peakScale);
    this.bounce.setScale(scale.x, scale.y, 1);
    this.healthBounce.setScale(scale.x, scale.y, 1);
    this.healthFillBounce.setScale(scale.x, scale.y, 1);
    if (this.elapsed > this.config.hit.duration) {
      this.elapsed = 0;
      this.bouncing = false;
    }
  }

  reset(tree: TreeState): void {
    this.elapsed = 0;
    this.bouncing = false;
    this.waitingForNextFrame = false;
    this.bounce.setScale(1, 1, 1);
    this.healthBounce.setScale(1, 1, 1);
    this.healthFillBounce.setScale(1, 1, 1);
    this.update(0, tree);
  }

  destroy(): void { this.node.destroy(); this.healthRoot.destroy(); this.healthFillRoot.destroy(); }
}
