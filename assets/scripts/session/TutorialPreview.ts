import type { EconomyStorage } from './BattleSession';
import { resolveContentConfig } from './ContentConfig';
import type { ResolvedContentConfig } from './ContentConfig';
import type { RuntimeEnvironment } from './RuntimeEnvironment';

export interface TutorialPreviewStorage extends EconomyStorage { removeItem(key: string): void; }
export const TUTORIAL_PREVIEW_FLAG = 'forest-gunner:tutorial-preview';
export const TUTORIAL_PREVIEW_SUFFIX = ':tutorial-preview';

/** Restart-bound test replay. The current session keeps its original storage mapping through teardown. */
export class TutorialPreviewController {
  readonly active: boolean;
  readonly storage: EconomyStorage;
  readonly contentConfig: ResolvedContentConfig | undefined;

  constructor(private readonly environment: RuntimeEnvironment, private readonly persistent: TutorialPreviewStorage,
    economyKey: string) {
    const previewKey = economyKey + TUTORIAL_PREVIEW_SUFFIX;
    let flag: string | null = null;
    if (environment === 'test') {
      try {
        flag = persistent.getItem(TUTORIAL_PREVIEW_FLAG);
        if (flag === 'reset') {
          // An old component may save during restart. Clear only once its replacement is being constructed.
          persistent.removeItem(previewKey);
          persistent.setItem(TUTORIAL_PREVIEW_FLAG, 'active');
        }
      } catch {
        // Storage denial must not prevent play; the session handles unavailable normal storage too.
        flag = null;
      }
    }
    this.active = flag === 'reset' || flag === 'active';
    this.storage = this.active ? {
      getItem: key => persistent.getItem(key === economyKey ? previewKey : key),
      setItem: (key, value) => persistent.setItem(key === economyKey ? previewKey : key, value),
    } : persistent;
    this.contentConfig = this.active ? resolveContentConfig('test', {
      tutorialEnabled: true, bypassProgression: false,
      testResources: { diamonds: 0, starGems: 0, fundGoldUpgrades: false, fundRebirthUpgrades: false, adventureTickets: 0, adventureCores: 0 },
    }) : undefined;
  }

  /** Caller restarts the game only when this request succeeds. */
  requestReplay(): boolean {
    if (this.environment !== 'test') return false;
    try { this.persistent.setItem(TUTORIAL_PREVIEW_FLAG, 'reset'); return true; }
    catch { return false; }
  }

  /** Keep writing the preview until restart, including any onDestroy save. */
  requestExit(): boolean {
    if (this.environment !== 'test') return false;
    try { this.persistent.removeItem(TUTORIAL_PREVIEW_FLAG); return true; }
    catch { return false; }
  }
}
