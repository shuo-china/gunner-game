import { Color, Node, Sprite, UITransform, Vec3 } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import type { ImageSpec } from './ArtLibrary';
import type { TutorialSnapshot, TutorialStep } from '../session/TutorialManager';

export type TutorialHudStep = TutorialStep;
export type TutorialHudState = TutorialSnapshot;
export interface TutorialHudTargets {
  upgrade: Node | null; entry: Node | null; buy: Node | null; from: Node | null; to: Node | null;
  canUpgrade: boolean; weaponOpen: boolean; blocked: boolean;
}
export interface TutorialHudAssets {
  version: number; referenceWidth: number; hand: ImageSpec;
  opacity: { upgrade: number; other: number };
  pulse: { duration: number; endScale: number; ease: 'OutQuad'; loop: 'Yoyo' };
  drag: { moveDuration: number; pauseAtTarget: number; scaleSmall: number; scaleDuration: number };
}

export async function loadTutorialHudAssets(art: ArtLibrary): Promise<TutorialHudAssets> {
  const assets = await art.json<TutorialHudAssets>('art/tutorial-system/config');
  if (assets.version !== 1 || assets.referenceWidth <= 0 || assets.pulse.duration <= 0 ||
    assets.drag.moveDuration <= 0 || assets.drag.scaleDuration <= 0 || assets.drag.pauseAtTarget < 0) {
    throw new Error('Invalid original tutorial UI');
  }
  await art.loadFrame(assets.hand.path);
  return assets;
}

function visible(node: Node | null): node is Node {
  if (!node || !node.isValid) return false;
  for (let current: Node | null = node; current; current = current.parent) if (!current.active) return false;
  return true;
}
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** A visual hint only: no blocker or input listeners. Targets retain their normal interaction. */
export class TutorialHud {
  readonly node: Node;
  private readonly pointer: Node;
  private readonly hand: Sprite;
  private readonly fromCenter = new Vec3();
  private readonly toCenter = new Vec3();
  private from: Node | null = null;
  private to: Node | null = null;
  private step: TutorialHudStep = 'done';
  private elapsed = 0;
  private destroyed = false;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: TutorialHudAssets) {
    this.node = makeNode('TutorialHud', parent);
    this.pointer = makeNode('TutorialPointer', this.node);
    this.hand = art.image('OriginalCatHand', assets.hand, this.pointer).getComponent(Sprite)!;
    this.hide();
  }

  resize(width: number, height: number, _topInset = 0, _bottomInset = 0): void {
    if (this.destroyed || width <= 0 || height <= 0) return;
    const scale = width / this.assets.referenceWidth;
    this.node.setScale(scale, scale, 1);
    this.node.getComponent(UITransform)!.setContentSize(width / scale, height / scale);
    // Target world positions already include HUD safe-area insets.
    if (this.node.active) this.render();
  }

  update(state: TutorialHudState, targets: TutorialHudTargets, dt = 0): void {
    if (this.destroyed) return;
    if (!state.active || state.step === 'done' || targets.blocked) { this.hide(); return; }
    let from: Node | null = null, to: Node | null = null;
    const dragging = state.step === 'gunMerge' || state.step === 'gunEquip';
    if (state.step === 'upgrade') {
      if (targets.canUpgrade && !targets.weaponOpen) from = targets.upgrade;
    } else if (state.step === 'gunOpen' || !targets.weaponOpen) {
      if (!targets.weaponOpen) from = targets.entry;
    } else if (state.step === 'gunBuy') from = targets.buy;
    else if (dragging) { from = targets.from; to = targets.to; }
    if (!visible(from) || (dragging && targets.weaponOpen && !visible(to))) {
      this.hide(); return;
    }
    if (this.from !== from || this.to !== to || this.step !== state.step || !this.node.active) this.elapsed = 0;
    this.from = from; this.to = to; this.step = state.step; this.node.active = true;
    this.node.setSiblingIndex((this.node.parent?.children.length ?? 1) - 1);
    const duration = to ? this.assets.drag.scaleDuration * 2 + this.assets.drag.moveDuration + this.assets.drag.pauseAtTarget
      : this.assets.pulse.duration * 2;
    this.elapsed = (this.elapsed + (Number.isFinite(dt) ? Math.max(0, dt) : 0)) % duration;
    this.hand.color = new Color(255, 255, 255,
      state.step === 'upgrade' ? this.assets.opacity.upgrade : this.assets.opacity.other);
    this.render();
  }

  hide(): void {
    this.node.active = false; this.from = this.to = null; this.elapsed = 0;
    if (this.pointer.isValid) this.pointer.setScale(1, 1, 1);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.hide();
    if (this.node.isValid) this.node.destroy();
  }

  private targetCenter(node: Node, out: Vec3): Vec3 {
    const transform = node.getComponent(UITransform);
    if (!transform) return out.set(node.worldPosition);
    // Node positions refer to their anchors; the hand points inside the target rectangle.
    out.set((.5 - transform.anchorX) * transform.width, (.5 - transform.anchorY) * transform.height, 0);
    return transform.convertToWorldSpaceAR(out, out);
  }

  private render(): void {
    if (!visible(this.from) || (this.to && !visible(this.to))) { this.hide(); return; }
    const start = this.targetCenter(this.from, this.fromCenter);
    let x = start.x, y = start.y, z = start.z, scale = 1;
    if (this.to) {
      const c = this.assets.drag, t = this.elapsed, end = this.targetCenter(this.to, this.toCenter);
      let progress = 0;
      if (t < c.scaleDuration) scale = 1 + (c.scaleSmall - 1) * smooth(t / c.scaleDuration);
      else if (t < c.scaleDuration + c.moveDuration) {
        progress = smooth((t - c.scaleDuration) / c.moveDuration); scale = c.scaleSmall;
      } else {
        progress = 1;
        scale = c.scaleSmall + (1 - c.scaleSmall) * smooth(Math.min(1, (t - c.scaleDuration - c.moveDuration) / c.scaleDuration));
      }
      x += (end.x - x) * progress; y += (end.y - y) * progress; z += (end.z - z) * progress;
    } else {
      const c = this.assets.pulse, phase = this.elapsed / c.duration;
      const t = phase <= 1 ? phase : 2 - phase;
      scale = 1 + (c.endScale - 1) * (1 - (1 - t) * (1 - t));
    }
    this.pointer.setWorldPosition(x, y, z); this.pointer.setScale(scale, scale, 1);
  }
}
