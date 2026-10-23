import { WEAPON_TUTORIAL_RULES } from './ContentConfig';
import type { WeaponMutationAction } from './WeaponInventory';

export type TutorialStep = 'upgrade' | 'gunOpen' | 'gunBuy' | 'gunMerge' | 'gunEquip' | 'done';
export interface TutorialSnapshot { active: boolean; step: TutorialStep; drawCount: number; }
export interface TutorialProgress {
  weaponsUnlocked: boolean;
}
export interface TutorialSave { step: TutorialStep; drawCount: number; }
const STEPS: readonly TutorialStep[] = ['upgrade', 'gunOpen', 'gunBuy', 'gunMerge', 'gunEquip', 'done'];

/** Successful weapon transactions advance teaching; the session saves both in one write. */
export class TutorialManager {
  private stepValue: TutorialStep;
  private drawCountValue = 0;

  constructor(private readonly enabled: boolean) {
    this.stepValue = enabled ? 'upgrade' : 'done';
  }

  snapshot(): TutorialSnapshot {
    return { active: this.enabled && this.stepValue !== 'done', step: this.stepValue, drawCount: this.drawCountValue };
  }

  /** Reconcile completed actions without replaying earlier steps or opening a panel implicitly. */
  sync(progress: TutorialProgress): boolean {
    if (!this.enabled) return false;
    const previous = this.stepValue;
    if (this.stepValue === 'upgrade' && progress.weaponsUnlocked === true) this.stepValue = 'gunOpen';
    return this.stepValue !== previous;
  }

  /** Called only for successful inventory actions, before the session persists its mutation. */
  onWeaponAction(action: WeaponMutationAction): boolean {
    if (!this.enabled) return false;
    if (this.stepValue === 'gunBuy' && action.type === 'draw' && this.drawCountValue < WEAPON_TUTORIAL_RULES.drawCount) {
      this.drawCountValue++;
      if (this.drawCountValue === WEAPON_TUTORIAL_RULES.drawCount) this.stepValue = 'gunMerge';
      return true;
    }
    if (action.weaponId !== WEAPON_TUTORIAL_RULES.mergeWeaponId) return false;
    if (this.stepValue === 'gunMerge' && action.type === 'merge') { this.stepValue = 'gunEquip'; return true; }
    if (this.stepValue === 'gunEquip' && action.type === 'equip') { this.stepValue = 'done'; return true; }
    return false;
  }

  onWeaponPanelOpened(): boolean {
    if (!this.enabled || this.stepValue !== 'gunOpen') return false;
    this.stepValue = 'gunBuy';
    return true;
  }

  complete(): void { this.stepValue = 'done'; }

  serialize(): TutorialSave { return { step: this.stepValue, drawCount: this.drawCountValue }; }

  restore(value: unknown): void {
    if (value === undefined) return;
    const saved = value as { step?: unknown; drawCount?: unknown } | null;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
        typeof saved.step !== 'string' || !STEPS.includes(saved.step as TutorialStep)) {
      throw new Error('Invalid tutorial save');
    }
    const drawCount = saved.drawCount === undefined ? 0 : saved.drawCount;
    if (typeof drawCount !== 'number' || !Number.isSafeInteger(drawCount) || drawCount < 0 || drawCount > WEAPON_TUTORIAL_RULES.drawCount) {
      throw new Error('Invalid tutorial save');
    }
    this.stepValue = this.enabled ? saved.step as TutorialStep : 'done';
    this.drawCountValue = this.enabled ? drawCount : 0;
  }
}
