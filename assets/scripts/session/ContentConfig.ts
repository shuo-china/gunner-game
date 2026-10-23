import type { RuntimeEnvironment } from './RuntimeEnvironment';
import { ECONOMY_CONFIG } from '../core/EconomyConfig';

export type ContentAdPlacement = 'weapon-daily' | 'weapon-unlock' | 'rebirth' | 'speedrun' | 'raid-entry' | 'boss' | 'hunt' | 'pet-daily' | 'fish-daily' | 'mine-entry' | 'mine-reward' | 'adventure-reduce';
export interface ContentThresholds {
  adventureStage: number; adventureVisibleStage: number;
  mineStage: number; mineVisibleStage: number;
  huntStage: number; huntVisibleStage: number;
  fishStage: number; fishVisibleStage: number;
  petStage: number; petVisibleStage: number; challengePowerLevel: number; autoMergeStage: number;
  weaponLockStage: number; weaponStarStage: number; rebirthStage: number; rebirthSkinChallengeWins: number;
  rebirthActionStage: number; dailyAdWeaponStage: number; raidStage: number; raidVisibleStage: number; bossStage: number; bossVisibleStage: number;
}
export interface TestResourceConfig {
  diamonds: number; starGems: number; fundGoldUpgrades: boolean; fundRebirthUpgrades: boolean; rebirthRewardFloorStage: number;
  adventureTickets: number; adventureCores: number; relicMaxDrawCount: number;
}

/** 武器教学：两次 D 级抽取后合成现有 240 攻 C 级山羊弩。价格和补给由 EconomyConfig 维护。 */
export const WEAPON_TUTORIAL_RULES = Object.freeze({ drawCount: 2, drawGrade: 0, mergeWeaponId: 3 });

/** 旅行内容规则：等级为内部零起点；星期使用 Date.getDay()（0=星期日）。收益与时长数值在 EconomyConfig。 */
export const ADVENTURE_RULES = Object.freeze({
  unlockLevels: Object.freeze([0, 1, 3, 6, 10]),
  petSlotUnlockLevels: Object.freeze([0, 2, 7]),
  openDays: Object.freeze([Object.freeze([0, 1, 4]), Object.freeze([0, 2, 5]), Object.freeze([0, 3, 6])]),
  adHighestUnlockedOnly: true,
});
for (const [levels, length] of [[ADVENTURE_RULES.unlockLevels, 5], [ADVENTURE_RULES.petSlotUnlockLevels, 3]] as const) {
  if (levels.length !== length || levels[0] !== 0 || levels.some((level, index) => !Number.isSafeInteger(level) ||
    level < 0 || level > ECONOMY_CONFIG.adventure.maxLevel || (index > 0 && level <= levels[index - 1]))) throw new Error('Invalid adventure unlock rules');
}
if (ADVENTURE_RULES.openDays.length !== 3 || ADVENTURE_RULES.openDays.some(days => !days.length || new Set(days).size !== days.length ||
  days.some(day => !Number.isSafeInteger(day) || day < 0 || day > 6))) throw new Error('Invalid adventure opening days');

/** 游戏内容配置入口。关卡使用玩家看到的数字（第 3 关写 3，不写内部进度 20）。 */
export const CONTENT_CONFIG = {
  tutorial: { production: true, test: false },
  ads: {
    // 唯一广告总开关：默认关闭；各广告位仍须满足自己的开放及领取条件。
    enabled: false,
    placements: { 'weapon-daily': true, 'weapon-unlock': true, rebirth: true, speedrun: true, 'raid-entry': true, boss: true, hunt: true, 'pet-daily': true, 'fish-daily': true, 'mine-entry': true, 'mine-reward': true, 'adventure-reduce': true },
  },
  production: {
    // 原版旅行在第12关成为下一个解锁内容，第35关开放。
    adventureStage: 35, adventureVisibleStage: 12,
    mineStage: 4, mineVisibleStage: 3,
    huntStage: 12, huntVisibleStage: 10,
    fishStage: 6, fishVisibleStage: 4,
    // 武器、鱼、宠物的自动合成共用原版第20关门槛，开放后均免费。
    petStage: 12, petVisibleStage: 10, challengePowerLevel: 3, autoMergeStage: 20,
    // 转生、皮肤、每日签到入口须完成教学，并成功通关至少一次挑战。
    weaponLockStage: 40, weaponStarStage: 40, rebirthStage: 3, rebirthSkinChallengeWins: 1,
    rebirthActionStage: 3, dailyAdWeaponStage: 4, raidStage: 40, raidVisibleStage: 35, bossStage: 10, bossVisibleStage: 6,
  },
  // 兼容现有调用接口；收益数值只在 EconomyConfig.ts 维护。
  firstDrawDiamonds: ECONOMY_CONFIG.onboarding.firstDrawDiamondFloor,
  test: {
    bypassProgression: true,
    // 不自动发枪；钻石供玩家自行抽取，补资源工具可以再次补足。
    ...ECONOMY_CONFIG.testResources,
  },
} as const;

export interface ResolvedContentConfig {
  readonly environment: RuntimeEnvironment;
  readonly tutorialEnabled: boolean;
  readonly adsEnabled: boolean;
  readonly adPlacements: Readonly<Record<ContentAdPlacement, boolean>>;
  readonly thresholds: Readonly<ContentThresholds>;
  readonly bypassProgression: boolean;
  readonly firstDrawDiamonds: number;
  readonly testResources: Readonly<TestResourceConfig>;
}
/** Explicit overrides support rule/advertising regression tests without editing release defaults. */
export interface ContentConfigOverrides {
  tutorialEnabled?: boolean;
  adsEnabled?: boolean; adPlacements?: Partial<Record<ContentAdPlacement, boolean>>;
  thresholds?: Partial<ContentThresholds>; bypassProgression?: boolean; firstDrawDiamonds?: number;
  testResources?: Partial<TestResourceConfig>;
}
export function resolveContentConfig(environment: RuntimeEnvironment = 'production', overrides: ContentConfigOverrides = {}): ResolvedContentConfig {
  const thresholds = { ...CONTENT_CONFIG.production, ...overrides.thresholds };
  const testResources: TestResourceConfig = { diamonds: CONTENT_CONFIG.test.diamonds, starGems: CONTENT_CONFIG.test.starGems,
    fundGoldUpgrades: CONTENT_CONFIG.test.fundGoldUpgrades, fundRebirthUpgrades: CONTENT_CONFIG.test.fundRebirthUpgrades, rebirthRewardFloorStage: CONTENT_CONFIG.test.rebirthRewardFloorStage,
    adventureTickets: CONTENT_CONFIG.test.adventureTickets, adventureCores: CONTENT_CONFIG.test.adventureCores,
    relicMaxDrawCount: CONTENT_CONFIG.test.relicMaxDrawCount,
    ...overrides.testResources };
  const firstDrawDiamonds = overrides.firstDrawDiamonds ?? CONTENT_CONFIG.firstDrawDiamonds;
  for (const value of [...Object.values(thresholds), firstDrawDiamonds, testResources.diamonds, testResources.starGems, testResources.rebirthRewardFloorStage,
    testResources.adventureTickets, testResources.adventureCores]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid content configuration');
  }
  if (!Number.isSafeInteger(testResources.relicMaxDrawCount) || testResources.relicMaxDrawCount < 1) throw new Error('Invalid content configuration');
  return Object.freeze({ environment, tutorialEnabled: overrides.tutorialEnabled ?? CONTENT_CONFIG.tutorial[environment],
    adsEnabled: overrides.adsEnabled ?? CONTENT_CONFIG.ads.enabled,
    adPlacements: Object.freeze({ ...CONTENT_CONFIG.ads.placements, ...overrides.adPlacements }),
    thresholds: Object.freeze(thresholds), firstDrawDiamonds,
    bypassProgression: environment === 'test' && (overrides.bypassProgression ?? CONTENT_CONFIG.test.bypassProgression),
    testResources: Object.freeze(testResources) });
}
