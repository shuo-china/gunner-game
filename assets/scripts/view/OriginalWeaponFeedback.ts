import { Node, Vec3 } from 'cc';
import type { OriginalUiNode, WeaponUiConfig } from './OriginalWeaponUi';

interface ButtonMotion {
  base: Vec3; scale: number; duration: number; elapsed: number; pressed: boolean;
  chains?: number; downElapsed?: number; upElapsed?: number;
}
const smooth = (value: number): number => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
export function visibleInHierarchy(node: Node): boolean {
  for (let current: Node | null = node; current; current = current.parent) if (!current.active) return false;
  return true;
}

/** Original BounceBtn uses linear press/release, unlike the cards' SmoothStep.
 * TutorialArrow_UI first presses, moves, releases, then pauses and repeats. */
export class OriginalWeaponFeedback {
  private readonly buttons = new Map<Node, ButtonMotion>();
  private tutorial: { from: Node; to: Node; phase: number; elapsed: number; start: Vec3 } | null = null;
  constructor(private readonly config: WeaponUiConfig['mergeTutorial'], private readonly arrow?: Node,
    private readonly sourceConcurrentPresses = false) {}

  get hasActiveMotion(): boolean { return this.buttons.size > 0 || this.tutorial !== null; }

  press(node: Node, spec: OriginalUiNode): void {
    if (!spec.bounceButton) return;
    const previous = this.buttons.get(node), base = previous?.base || new Vec3(node.scale.x, node.scale.y, node.scale.z);
    if (this.sourceConcurrentPresses && previous?.pressed) return;
    const motion: ButtonMotion = { base, ...spec.bounceButton, elapsed: 0, pressed: true };
    if (this.sourceConcurrentPresses) {
      // BounceBtn.OnPointerDown resets both shared timers and starts another
      // coroutine; it never stops an older release coroutine. Rebirth retains
      // that observable rapid-repress behavior without changing other HUDs.
      motion.chains = (previous?.chains ?? 0) + 1; motion.downElapsed = 0; motion.upElapsed = 0;
    }
    this.buttons.set(node, motion);
  }
  release(node: Node): void {
    const motion = this.buttons.get(node); if (!motion) return;
    motion.pressed = false; motion.elapsed = 0;
  }
  cancelButton(node: Node): void {
    const motion = this.buttons.get(node); if (!motion) return;
    node.setScale(motion.base.x, motion.base.y, motion.base.z); this.buttons.delete(node);
  }
  cancelHiddenButtons(): void {
    for (const node of this.buttons.keys()) if (!visibleInHierarchy(node)) this.cancelButton(node);
  }
  setTutorialTargets(from: Node | null, to: Node | null): void {
    this.clearTutorial();
    if (!from || !to || !this.arrow || !this.config) return;
    this.tutorial = { from, to, phase: 0, elapsed: 0, start: this.targetPosition(from) };
    this.arrow.active = true; this.arrow.setScale(1, 1, 1); this.arrow.setWorldPosition(this.tutorial.start);
  }
  clearTutorial(): void {
    this.tutorial = null;
    if (this.arrow) { this.arrow.active = false; this.arrow.setScale(1, 1, 1); }
  }
  clear(): void { for (const node of this.buttons.keys()) this.cancelButton(node); this.clearTutorial(); }

  update(dt: number): void {
    this.cancelHiddenButtons();
    for (const [node, motion] of this.buttons) {
      if (this.sourceConcurrentPresses) { this.updateSourceButton(node, motion, dt); continue; }
      motion.elapsed += dt; const t = Math.min(1, motion.elapsed / motion.duration);
      const factor = motion.pressed ? 1 + (motion.scale - 1) * t : motion.scale + (1 - motion.scale) * t;
      node.setScale(motion.base.x * factor, motion.base.y * factor, motion.base.z * factor);
      if (!motion.pressed && t === 1) this.buttons.delete(node);
    }
    const tutorial = this.tutorial, c = this.config, arrow = this.arrow;
    if (!tutorial || !c || !arrow) return;
    if (!visibleInHierarchy(tutorial.from) || !visibleInHierarchy(tutorial.to) || !visibleInHierarchy(arrow)) { this.clearTutorial(); return; }
    const durations = [c.scaleDuration, c.moveDuration, c.scaleDuration, c.pauseAtTarget];
    let remaining = Math.max(0, dt);
    do {
      const duration = durations[tutorial.phase], step = Math.min(remaining, Math.max(0, duration - tutorial.elapsed));
      tutorial.elapsed += step; remaining -= step;
      const p = smooth(duration > 0 ? tutorial.elapsed / duration : 1);
      if (tutorial.phase === 0) { const scale = 1 + (c.scaleSmall - 1) * p; arrow.setScale(scale, scale, scale); }
      else if (tutorial.phase === 1) {
        const end = this.targetPosition(tutorial.to), start = tutorial.start;
        arrow.setWorldPosition(start.x + (end.x - start.x) * p, start.y + (end.y - start.y) * p, start.z + (end.z - start.z) * p);
      } else if (tutorial.phase === 2) { const scale = c.scaleSmall + (1 - c.scaleSmall) * p; arrow.setScale(scale, scale, scale); }
      if (tutorial.elapsed < duration) break;
      tutorial.elapsed = 0; tutorial.phase = (tutorial.phase + 1) % 4;
      if (tutorial.phase === 0) { tutorial.start = this.targetPosition(tutorial.from); arrow.setWorldPosition(tutorial.start); arrow.setScale(1, 1, 1); }
      if (tutorial.phase === 1) tutorial.start = this.targetPosition(tutorial.from);
    } while (remaining > 0);
  }
  private updateSourceButton(node: Node, motion: ButtonMotion, dt: number): void {
    const count = motion.chains ?? 0;
    for (let i = 0; i < count; i++) {
      const elapsed = motion.pressed ? (motion.downElapsed = (motion.downElapsed ?? 0) + dt) :
        (motion.upElapsed = (motion.upElapsed ?? 0) + dt);
      const t = Math.min(1, elapsed / motion.duration);
      const factor = motion.pressed ? 1 + (motion.scale - 1) * t : motion.scale + (1 - motion.scale) * t;
      node.setScale(motion.base.x * factor, motion.base.y * factor, motion.base.z * factor);
      // Original MoveNext respawns its one-frame coroutine even at t == 1;
      // only a strictly greater release time terminates each surviving chain.
      if (!motion.pressed && elapsed > motion.duration) motion.chains = (motion.chains ?? 0) - 1;
    }
    if (!motion.chains) this.buttons.delete(node);
  }
  private targetPosition(node: Node): Vec3 {
    const at = node.worldPosition.clone(), scale = this.arrow?.parent?.worldScale;
    at.x += (this.config?.offset[0] || 0) * (scale?.x ?? 1);
    at.y += (this.config?.offset[1] || 0) * (scale?.y ?? 1); return at;
  }
}
