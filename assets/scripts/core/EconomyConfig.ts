/**
 * 资源产出的唯一数值入口。修改后重新构建游戏生效，已有余额不会被重算。
 * 普通收益与广告收益分别配置；additionalDiamonds 表示额外追加，不包含基础奖励。
 * 新玩法的产出必须先添加到这里，再由玩法模块计算、校验并交给会话入账。
 * 广告开关与解锁门槛仍在 session/ContentConfig.ts；武器伤害仍在 WeaponData.ts。
 */
const settings = {
  // 仅用于新存档；首次武器补给是“补足”，不是再赠送这么多钻石。
  newGame: { gold: '0', diamonds: 0, starGems: 0, ruby: '0', petCoins: 0, starterWeaponId: 0 },
  onboarding: { firstDrawDiamondFloor: 200 },

  gold: {
    firstStageBase: 20,                 // 第 1 关普通树的基础金币
    stageGrowth: 3,                     // 逐关增长；保留原版逐步有效位截断
    degreeMultipliers: [1, 1.8, 3, 100], // 三档普通树和主线 Boss
    upgradeBasePercent: 100,
    upgradeGrowthG17: '1.0800000000000001', // 原 double 的精确表示，独立于攻击升级
    rebirthUpgradeGrowth: 1.05,
    skinBonusPerIndex: 5,               // 皮肤 ID × 此值，全部持有皮肤累计
    petFirstBonusPercent: 2,
    petGradeGrowth: 3.1,                 // 宠物每升一档的金币加成增长
  },

  // 首关为原版 2 倍；每提高一关，普通/广告额外奖励各增加首关金额的 10%，不复利。
  speedRun: { baseDiamonds: 60, additionalDiamonds: 180, stageGrowthPercent: 10 },
  boss: { baseDiamonds: 300, additionalDiamonds: 600, stageGrowthPercent: 10 },
  // 原版七天钻石 [70, 200, 400, 600, 800, 1000, 1500] 的两倍最终值；领满七天后次日循环。
  // 保持七项按天排序；dailyLimit 仅支持 0（暂停领取）或 1，不重置已有签到进度。
  dailyCheck: { diamondsByDay: [140, 400, 800, 1200, 1600, 2000, 3000], dailyLimit: 1 },
  // 每日分享到账后隐藏入口；北京时间零点刷新，dailyLimit 仅支持 0（暂停）或 1。
  dailyShare: { diamonds: 80, dailyLimit: 1 },
  mine: {
    freeEntriesPerDay: 2, normalScore: 2, rareScore: 20, scorePerDiamond: 10,
    rareOreCount: 100, adAdditionalMultiplier: 3,
    speedBuffSeconds: 300, speedBuffMaxSeconds: 900, speedBuffMultiplier: 3,
  },
  // 原版离线会自动购买升级，并只重放历史已到达的小关；没有广告翻倍领取。
  // 基础金币、品质倍率及金币升级仍共用 gold，调整后在线与离线使用同一份表。
  offline: {
    minimumAbsentSeconds: 30, maxOfflineSeconds: 28800,
    clearTimeScale: 1.3, stageClearDelaySeconds: 5,
    permanentBuffMultiplier: 4, // 仅兼容原版永久增益状态；本项目不新增付费入口
  },
  rebirth: {
    minimumStage: 3,
    defaultRewardPercent: 100,
    progressPower: 2,                   // 基础紫币 = 进度^此值 × sqrt(进度) × 奖励百分比 / 100
    adTotalMultiplier: 3,               // 强化转生的最终倍率，不是额外追加倍率
    adDailyLimit: 1,
  },
  raid: {
    freeEntriesPerDay: 2, adEntriesPerDay: 1,
    starGemTiers: [                     // 按通过层数逐档累加
      { levels: 10, perLevel: 25 }, { levels: 10, perLevel: 20 }, { levels: 10, perLevel: 10 },
    ],
    starGemsPerExtraLevel: 5,
    // 已有存档按下标记录周任务：可调目标/奖励，不要重排或删除；新增任务接入时须迁移存档。
    missions: [
      { type: 'tries' as const, target: 1, reward: 300 }, { type: 'tries' as const, target: 4, reward: 500 },
      { type: 'tries' as const, target: 7, reward: 800 }, { type: 'best' as const, target: 1, reward: 200 },
      { type: 'best' as const, target: 5, reward: 300 }, { type: 'best' as const, target: 10, reward: 400 },
      { type: 'best' as const, target: 20, reward: 500 }, { type: 'best' as const, target: 30, reward: 600 },
    ],
  },
  weapons: {
    drawPrice: 100,
    drawGradePercents: [100, 0, 0, 0],    // D/C/B/A；总和必须为 100，同品质内等概率
    dailyAd: { grade: 1, dailyLimit: 1 }, // 0=D、1=C……；每次领取一把
    offer: { weaponId: 8, durationSeconds: 1800, maximumOwnedGradeExclusive: 2 },
  },
  hunt: { petCoinsPerLevel: 30, adAdditionalMultiplier: 1 }, // 每小关立即发放；结算广告额外追加本局累计的此倍数
  pets: { drawPrice: 100, drawGrade: 0, dailyAd: { grade: 1, dailyLimit: 1 } }, // 首次狩猎通关后每日广告领取 C 阶宠物
  adventure: {
    durationHours: [1, 2, 4, 8, 16],
    maxLevel: 15, expQuadratic: 3, expLinear: 20, expBase: 50,
    initialTickets: 20, initialCores: [0, 0, 0, 0], ticketMax: 20, ticketChargeHours: 4,
    corePerHour: 20, expPerHour: 10, petGradeCoreBonus: 0.1,
    adDailyLimit: 2, adReduceMinutes: 30, plusPackReduceHours: 16,
  },
  relics: {
    drawPrice: 20, tableMaxLevel: 299, specialMaxLevel: 50,
    upgradeBase: 2, upgradePerLevel: 2, upgradeMax: 50,
    tierMultipliers: [1, 1.5, 2], moveSpeedPerLevel: 2, offlineMinutesPerLevel: 10,
    rebirthPercentPerLevel: 5, skipPercentPerLevel: 2,
    typesByCore: [[0, 1, 2, 11, 12], [3, 4, 5, 10, 12], [6, 7, 8, 9, 12]],
    // ORIGINAL_RELIC_BALANCES_BEGIN: raw InfVal coefficient:exponent; retain coefficient precision.
    damageBalance: [
      '500:-2', '100:-1', '150:-1', '200:-1', '260:-1', '320:-1', '380:-1', '440:-1', '510:-1', '580:-1',
      '650:-1', '730:-1', '810:-1', '900:-1', '990:-1', '108:0', '118:0', '128:0', '139:0', '150:0',
      '162:0', '175:0', '188:0', '202:0', '217:0', '232:0', '248:0', '265:0', '283:0', '302:0',
      '322:0', '343:0', '365:0', '388:0', '412:0', '437:0', '463:0', '491:0', '520:0', '551:0',
      '583:0', '617:0', '652:0', '689:0', '728:0', '769:0', '812:0', '857:0', '900:0', '950:0',
      '100:1', '105:1', '110:1', '116:1', '122:1', '128:1', '134:1', '141:1', '148:1', '155:1',
      '163:1', '171:1', '180:1', '189:1', '198:1', '208:1', '218:1', '229:1', '240:1', '252:1',
      '265:1', '278:1', '292:1', '307:1', '322:1', '338:1', '355:1', '373:1', '392:1', '412:1',
      '433:1', '455:1', '478:1', '502:1', '527:1', '553:1', '581:1', '610:1', '641:1', '673:1',
      '707:1', '742:1', '779:1', '818:1', '859:1', '902:1', '947:1', '990:1', '104:2', '109:2',
      '114:2', '119:2', '125:2', '131:2', '137:2', '143:2', '150:2', '157:2', '164:2', '172:2',
      '180:2', '189:2', '198:2', '207:2', '217:2', '227:2', '238:2', '249:2', '261:2', '274:2',
      '287:2', '301:2', '316:2', '331:2', '347:2', '364:2', '382:2', '401:2', '421:2', '442:2',
      '464:2', '487:2', '511:2', '536:2', '562:2', '590:2', '619:2', '650:2', '682:2', '716:2',
      '751:2', '788:2', '827:2', '868:2', '911:2', '956:2', '999:2', '104:3', '109:3', '114:3',
      '119:3', '125:3', '131:3', '137:3', '143:3', '150:3', '157:3', '164:3', '172:3', '180:3',
      '189:3', '198:3', '207:3', '217:3', '227:3', '238:3', '249:3', '261:3', '274:3', '287:3',
      '301:3', '316:3', '331:3', '347:3', '364:3', '382:3', '401:3', '421:3', '442:3', '464:3',
      '487:3', '511:3', '536:3', '562:3', '590:3', '619:3', '650:3', '682:3', '716:3', '751:3',
      '788:3', '827:3', '868:3', '911:3', '956:3', '999:3', '104:4', '109:4', '114:4', '119:4',
      '125:4', '131:4', '137:4', '143:4', '150:4', '157:4', '164:4', '172:4', '180:4', '189:4',
      '198:4', '207:4', '217:4', '227:4', '238:4', '249:4', '261:4', '274:4', '287:4', '301:4',
      '316:4', '331:4', '347:4', '364:4', '382:4', '401:4', '421:4', '442:4', '464:4', '487:4',
      '511:4', '536:4', '562:4', '590:4', '619:4', '650:4', '682:4', '716:4', '751:4', '788:4',
      '827:4', '868:4', '911:4', '956:4', '100:5', '105:5', '110:5', '115:5', '120:5', '126:5',
      '132:5', '138:5', '144:5', '151:5', '158:5', '165:5', '173:5', '181:5', '190:5', '199:5',
      '208:5', '218:5', '228:5', '239:5', '250:5', '262:5', '275:5', '288:5', '302:5', '317:5',
      '332:5', '348:5', '365:5', '383:5', '402:5', '422:5', '443:5', '465:5', '488:5', '512:5',
      '537:5', '563:5', '591:5', '620:5', '651:5', '683:5', '717:5', '752:5', '789:5', '828:5',
      '869:5', '912:5', '957:5', '100:6', '105:6', '110:6', '115:6', '120:6', '126:6', '132:6',
    ],
    moneyBalance: [
      '500:-2', '100:-1', '150:-1', '200:-1', '260:-1', '320:-1', '380:-1', '440:-1', '510:-1', '580:-1',
      '650:-1', '730:-1', '810:-1', '900:-1', '990:-1', '108:0', '118:0', '128:0', '139:0', '150:0',
      '162:0', '175:0', '188:0', '202:0', '217:0', '232:0', '248:0', '265:0', '283:0', '302:0',
      '322:0', '343:0', '365:0', '388:0', '412:0', '437:0', '463:0', '491:0', '520:0', '551:0',
      '583:0', '617:0', '652:0', '689:0', '728:0', '769:0', '812:0', '857:0', '900:0', '950:0',
      '100:1', '105:1', '110:1', '116:1', '122:1', '128:1', '134:1', '141:1', '148:1', '155:1',
      '163:1', '171:1', '180:1', '189:1', '198:1', '208:1', '218:1', '229:1', '240:1', '252:1',
      '265:1', '278:1', '292:1', '307:1', '322:1', '338:1', '355:1', '373:1', '392:1', '412:1',
      '433:1', '455:1', '478:1', '502:1', '527:1', '553:1', '581:1', '610:1', '641:1', '673:1',
      '707:1', '742:1', '779:1', '818:1', '859:1', '902:1', '947:1', '990:1', '104:2', '109:2',
      '114:2', '119:2', '125:2', '131:2', '137:2', '143:2', '150:2', '157:2', '164:2', '172:2',
      '180:2', '189:2', '198:2', '207:2', '217:2', '227:2', '238:2', '249:2', '261:2', '274:2',
      '287:2', '301:2', '316:2', '331:2', '347:2', '364:2', '382:2', '401:2', '421:2', '442:2',
      '464:2', '487:2', '511:2', '536:2', '562:2', '590:2', '619:2', '650:2', '682:2', '716:2',
      '751:2', '788:2', '827:2', '868:2', '911:2', '956:2', '999:2', '104:3', '109:3', '114:3',
      '119:3', '125:3', '131:3', '137:3', '143:3', '150:3', '157:3', '164:3', '172:3', '180:3',
      '189:3', '198:3', '207:3', '217:3', '227:3', '238:3', '249:3', '261:3', '274:3', '287:3',
      '301:3', '316:3', '331:3', '347:3', '364:3', '382:3', '401:3', '421:3', '442:3', '464:3',
      '487:3', '511:3', '536:3', '562:3', '590:3', '619:3', '650:3', '682:3', '716:3', '751:3',
      '788:3', '827:3', '868:3', '911:3', '956:3', '999:3', '104:4', '109:4', '114:4', '119:4',
      '125:4', '131:4', '137:4', '143:4', '150:4', '157:4', '164:4', '172:4', '180:4', '189:4',
      '198:4', '207:4', '217:4', '227:4', '238:4', '249:4', '261:4', '274:4', '287:4', '301:4',
      '316:4', '331:4', '347:4', '364:4', '382:4', '401:4', '421:4', '442:4', '464:4', '487:4',
      '511:4', '536:4', '562:4', '590:4', '619:4', '650:4', '682:4', '716:4', '751:4', '788:4',
      '827:4', '868:4', '911:4', '956:4', '100:5', '105:5', '110:5', '115:5', '120:5', '126:5',
      '132:5', '138:5', '144:5', '151:5', '158:5', '165:5', '173:5', '181:5', '190:5', '199:5',
      '208:5', '218:5', '228:5', '239:5', '250:5', '262:5', '275:5', '288:5', '302:5', '317:5',
      '332:5', '348:5', '365:5', '383:5', '402:5', '422:5', '443:5', '465:5', '488:5', '512:5',
      '537:5', '563:5', '591:5', '620:5', '651:5', '683:5', '717:5', '752:5', '789:5', '828:5',
      '869:5', '912:5', '957:5', '100:6', '105:6', '110:6', '115:6', '120:6', '126:6', '132:6',
    ],
    criticalDamageBalance: [
      '500:-2', '100:-1', '150:-1', '200:-1', '260:-1', '320:-1', '380:-1', '440:-1', '510:-1', '580:-1',
      '650:-1', '730:-1', '810:-1', '900:-1', '990:-1', '108:0', '118:0', '128:0', '139:0', '150:0',
      '162:0', '175:0', '188:0', '202:0', '217:0', '232:0', '248:0', '265:0', '283:0', '302:0',
      '322:0', '343:0', '365:0', '388:0', '412:0', '437:0', '463:0', '491:0', '520:0', '551:0',
      '583:0', '617:0', '652:0', '689:0', '728:0', '769:0', '812:0', '857:0', '900:0', '950:0',
      '100:1', '105:1', '110:1', '116:1', '122:1', '128:1', '134:1', '141:1', '148:1', '155:1',
      '163:1', '171:1', '180:1', '189:1', '198:1', '208:1', '218:1', '229:1', '240:1', '252:1',
      '265:1', '278:1', '292:1', '307:1', '322:1', '338:1', '355:1', '373:1', '392:1', '412:1',
      '433:1', '455:1', '478:1', '502:1', '527:1', '553:1', '581:1', '610:1', '641:1', '673:1',
      '707:1', '742:1', '779:1', '818:1', '859:1', '902:1', '947:1', '990:1', '104:2', '109:2',
      '114:2', '119:2', '125:2', '131:2', '137:2', '143:2', '150:2', '157:2', '164:2', '172:2',
      '180:2', '189:2', '198:2', '207:2', '217:2', '227:2', '238:2', '249:2', '261:2', '274:2',
      '287:2', '301:2', '316:2', '331:2', '347:2', '364:2', '382:2', '401:2', '421:2', '442:2',
      '464:2', '487:2', '511:2', '536:2', '562:2', '590:2', '619:2', '650:2', '682:2', '716:2',
      '751:2', '788:2', '827:2', '868:2', '911:2', '956:2', '999:2', '104:3', '109:3', '114:3',
      '119:3', '125:3', '131:3', '137:3', '143:3', '150:3', '157:3', '164:3', '172:3', '180:3',
      '189:3', '198:3', '207:3', '217:3', '227:3', '238:3', '249:3', '261:3', '274:3', '287:3',
      '301:3', '316:3', '331:3', '347:3', '364:3', '382:3', '401:3', '421:3', '442:3', '464:3',
      '487:3', '511:3', '536:3', '562:3', '590:3', '619:3', '650:3', '682:3', '716:3', '751:3',
      '788:3', '827:3', '868:3', '911:3', '956:3', '999:3', '104:4', '109:4', '114:4', '119:4',
      '125:4', '131:4', '137:4', '143:4', '150:4', '157:4', '164:4', '172:4', '180:4', '189:4',
      '198:4', '207:4', '217:4', '227:4', '238:4', '249:4', '261:4', '274:4', '287:4', '301:4',
      '316:4', '331:4', '347:4', '364:4', '382:4', '401:4', '421:4', '442:4', '464:4', '487:4',
      '511:4', '536:4', '562:4', '590:4', '619:4', '650:4', '682:4', '716:4', '751:4', '788:4',
      '827:4', '868:4', '911:4', '956:4', '100:5', '105:5', '110:5', '115:5', '120:5', '126:5',
      '132:5', '138:5', '144:5', '151:5', '158:5', '165:5', '173:5', '181:5', '190:5', '199:5',
      '208:5', '218:5', '228:5', '239:5', '250:5', '262:5', '275:5', '288:5', '302:5', '317:5',
      '332:5', '348:5', '365:5', '383:5', '402:5', '422:5', '443:5', '465:5', '488:5', '512:5',
      '537:5', '563:5', '591:5', '620:5', '651:5', '683:5', '717:5', '752:5', '789:5', '828:5',
      '869:5', '912:5', '957:5', '100:6', '105:6', '110:6', '115:6', '120:6', '126:6', '132:6',
    ],
    // ORIGINAL_RELIC_BALANCES_END
  },
  fish: {
    drawPrice: 200,                     // 钻石抽鱼；普通和广告抽鱼不消耗钻石
    freeDrawsPerDay: 5, noAdDrawsPerDay: 3, // 每日前三次直接领取，后两次观看广告
    freeBaseGrade: 0, premiumBaseGrade: 1,
    drawGradePercents: [60, 30, 10, 0], // 原场景 Fish_manager.GachaChances；结果 = 基础品质 + 下标
  },
  // per_player：每个账号一次；global_once：全服仅一个账号一次。修改后导出后端配置。
  redeemCodes: [{ code: '950424', diamonds: 2000, mode: 'per_player' as 'per_player' | 'global_once' }],
  testResources: {
    diamonds: 2000000, starGems: 1000000, fundGoldUpgrades: true, fundRebirthUpgrades: true,
    rebirthRewardFloorStage: 3,
    // 测试启动和手动补给只补足余额；旅行券与四种核心共用各自的补足值。
    adventureTickets: 1000000, adventureCores: 1000000,
    // 防止大额测试核心一次生成数万条抽取结果；界面预览和实际扣款共用。
    relicMaxDrawCount: 100,
  },
  // 后续新增产出仍在此增加对应分组，不在模块中写奖励常量。
};

type DeepReadonly<T> = { readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K] };
export type EconomyConfig = DeepReadonly<typeof settings>;

/** Fail early on authoring mistakes instead of silently changing a wallet or breaking a draw. */
export function validateEconomyConfig(config: EconomyConfig): void {
  const integer = (name: string, value: number, min = 0, max = Number.MAX_SAFE_INTEGER): void => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid economy configuration: ${name}`);
  };
  const positive = (name: string, value: number): void => {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid economy configuration: ${name}`);
  };
  for (const [name, value] of Object.entries(config.newGame)) {
    if (typeof value === 'number') integer(`newGame.${name}`, value);
    else if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) || !Number.isSafeInteger(Number(value.split(/e/i)[1] ?? 0))) {
      throw new Error(`Invalid economy configuration: newGame.${name}`);
    }
  }
  integer('starterWeaponId', config.newGame.starterWeaponId, 0, 64);
  integer('firstDrawDiamondFloor', config.onboarding.firstDrawDiamondFloor);
  if (config.dailyCheck.diamondsByDay.length !== 7) throw new Error('Invalid economy configuration: dailyCheck.diamondsByDay');
  config.dailyCheck.diamondsByDay.forEach(value => integer('dailyCheck.diamondsByDay', value));
  integer('dailyCheck.dailyLimit', config.dailyCheck.dailyLimit, 0, 1);
  integer('dailyShare.diamonds', config.dailyShare.diamonds);
  integer('dailyShare.dailyLimit', config.dailyShare.dailyLimit, 0, 1);
  for (const [name, reward] of Object.entries({ speedRun: config.speedRun, boss: config.boss })) {
    integer(`${name}.baseDiamonds`, reward.baseDiamonds);
    integer(`${name}.additionalDiamonds`, reward.additionalDiamonds);
    integer(`${name}.totalDiamonds`, reward.baseDiamonds + reward.additionalDiamonds);
    integer(`${name}.stageGrowthPercent`, reward.stageGrowthPercent);
  }
  for (const [name, value] of Object.entries(config.rebirth)) integer(`rebirth.${name}`, value, name === 'adDailyLimit' || name === 'defaultRewardPercent' ? 0 : 1);
  integer('rebirth.progressPower', config.rebirth.progressPower, 1, 10);
  positive('gold.firstStageBase', config.gold.firstStageBase);
  positive('gold.stageGrowth', config.gold.stageGrowth);
  positive('gold.upgradeGrowthG17', Number(config.gold.upgradeGrowthG17));
  positive('gold.rebirthUpgradeGrowth', config.gold.rebirthUpgradeGrowth);
  positive('gold.petGradeGrowth', config.gold.petGradeGrowth);
  integer('gold.upgradeBasePercent', config.gold.upgradeBasePercent, 1);
  integer('gold.skinBonusPerIndex', config.gold.skinBonusPerIndex);
  integer('gold.petFirstBonusPercent', config.gold.petFirstBonusPercent);
  if (config.gold.degreeMultipliers.length !== 4) throw new Error('Invalid economy configuration: gold.degreeMultipliers');
  config.gold.degreeMultipliers.forEach(value => positive('gold.degreeMultipliers', value));
  integer('raid.freeEntriesPerDay', config.raid.freeEntriesPerDay);
  for (const [name, value] of Object.entries(config.mine)) integer(`mine.${name}`, value,
    ['scorePerDiamond', 'speedBuffSeconds', 'speedBuffMaxSeconds', 'speedBuffMultiplier'].includes(name) ? 1 : 0);
  integer('mine.rareOreCount', config.mine.rareOreCount, 0, 1000);
  integer('mine.maximumScore', 1000 * Math.max(config.mine.normalScore, config.mine.rareScore));
  integer('mine.maximumAdReward', Math.floor(1000 * Math.max(config.mine.normalScore, config.mine.rareScore) / config.mine.scorePerDiamond) * config.mine.adAdditionalMultiplier);
  integer('offline.minimumAbsentSeconds', config.offline.minimumAbsentSeconds, 1);
  integer('offline.maxOfflineSeconds', config.offline.maxOfflineSeconds, config.offline.minimumAbsentSeconds);
  positive('offline.clearTimeScale', config.offline.clearTimeScale);
  integer('offline.stageClearDelaySeconds', config.offline.stageClearDelaySeconds);
  integer('offline.permanentBuffMultiplier', config.offline.permanentBuffMultiplier, 1);
  integer('raid.adEntriesPerDay', config.raid.adEntriesPerDay);
  config.raid.starGemTiers.forEach(tier => { integer('raid.tier.levels', tier.levels, 1); integer('raid.tier.perLevel', tier.perLevel); });
  integer('raid.starGemsPerExtraLevel', config.raid.starGemsPerExtraLevel);
  config.raid.missions.forEach(mission => {
    if (mission.type !== 'tries' && mission.type !== 'best') throw new Error('Invalid economy configuration: raid.mission.type');
    integer('raid.mission.target', mission.target, 1); integer('raid.mission.reward', mission.reward);
  });
  integer('weapons.drawPrice', config.weapons.drawPrice);
  if (config.weapons.drawGradePercents.length !== 4 || config.weapons.drawGradePercents.reduce((sum, n) => sum + n, 0) !== 100) {
    throw new Error('Invalid economy configuration: weapons.drawGradePercents');
  }
  config.weapons.drawGradePercents.forEach(value => integer('weapons.drawGradePercents', value, 0, 100));
  integer('weapons.dailyAd.grade', config.weapons.dailyAd.grade, 0, 12);
  integer('weapons.dailyAd.dailyLimit', config.weapons.dailyAd.dailyLimit);
  integer('weapons.offer.weaponId', config.weapons.offer.weaponId, 0, 64);
  integer('weapons.offer.durationSeconds', config.weapons.offer.durationSeconds, 1);
  integer('weapons.offer.maximumOwnedGradeExclusive', config.weapons.offer.maximumOwnedGradeExclusive, 0, 13);
  integer('pets.drawPrice', config.pets.drawPrice); integer('pets.drawGrade', config.pets.drawGrade, 0, 9);
  integer('hunt.petCoinsPerLevel', config.hunt.petCoinsPerLevel);
  integer('hunt.adAdditionalMultiplier', config.hunt.adAdditionalMultiplier);
  integer('pets.dailyAd.grade', config.pets.dailyAd.grade, 0, 9);
  integer('pets.dailyAd.dailyLimit', config.pets.dailyAd.dailyLimit);
  const adventure = config.adventure, relics = config.relics;
  integer('adventure.maxLevel', adventure.maxLevel, 0, 15);
  for (const key of ['expQuadratic', 'expLinear', 'expBase', 'ticketMax', 'ticketChargeHours', 'corePerHour', 'expPerHour', 'adReduceMinutes'] as const) integer(`adventure.${key}`, adventure[key], 1);
  integer('adventure.initialTickets', adventure.initialTickets, 0, adventure.ticketMax);
  integer('adventure.adDailyLimit', adventure.adDailyLimit); integer('adventure.plusPackReduceHours', adventure.plusPackReduceHours);
  positive('adventure.petGradeCoreBonus', adventure.petGradeCoreBonus);
  if (adventure.durationHours.length !== 5 || adventure.initialCores.length !== 4) throw new Error('Invalid economy configuration: adventure arrays');
  adventure.durationHours.forEach(value => integer('adventure.durationHours', value, 1));
  adventure.initialCores.forEach(value => integer('adventure.initialCores', value));
  for (const key of ['drawPrice', 'upgradeBase', 'upgradePerLevel', 'upgradeMax', 'moveSpeedPerLevel', 'offlineMinutesPerLevel', 'rebirthPercentPerLevel', 'skipPercentPerLevel'] as const) integer(`relics.${key}`, relics[key], 1);
  integer('relics.tableMaxLevel', relics.tableMaxLevel, 0, 299); integer('relics.specialMaxLevel', relics.specialMaxLevel, 0, 50);
  if (relics.tierMultipliers.length !== 3 || relics.typesByCore.length !== 3) throw new Error('Invalid economy configuration: relic arrays');
  relics.tierMultipliers.forEach(value => positive('relics.tierMultiplier', value));
  relics.typesByCore.forEach(types => { if (types.length !== 5 || new Set(types).size !== 5) throw new Error('Invalid economy configuration: relics.typesByCore'); types.forEach(type => integer('relics.type', type, 0, 12)); });
  for (const balance of [relics.damageBalance, relics.moneyBalance, relics.criticalDamageBalance]) {
    if (balance.length !== 300) throw new Error('Invalid economy configuration: relic balance length');
    balance.forEach(value => { if (!/^\d+:-?\d+$/.test(value) || !Number.isSafeInteger(Number(value.split(':')[1])) || Number(value.split(':')[0]) <= 0) throw new Error('Invalid economy configuration: relic balance value'); });
  }
  integer('fish.drawPrice', config.fish.drawPrice);
  integer('fish.freeDrawsPerDay', config.fish.freeDrawsPerDay);
  integer('fish.noAdDrawsPerDay', config.fish.noAdDrawsPerDay, 0, config.fish.freeDrawsPerDay);
  integer('fish.freeBaseGrade', config.fish.freeBaseGrade, 0, 9);
  integer('fish.premiumBaseGrade', config.fish.premiumBaseGrade, 0, 9);
  if (config.fish.drawGradePercents.length !== 4 || config.fish.drawGradePercents.reduce((sum, n) => sum + n, 0) !== 100) {
    throw new Error('Invalid economy configuration: fish.drawGradePercents');
  }
  config.fish.drawGradePercents.forEach(value => integer('fish.drawGradePercents', value, 0, 100));
  const codes = new Set<string>();
  config.redeemCodes.forEach(reward => {
    if (!['per_player', 'global_once'].includes(reward.mode)) throw new Error('Invalid economy configuration: redeemCodes.mode');
    if (!reward.code.trim() || reward.code !== reward.code.trim() || codes.has(reward.code)) throw new Error('Invalid economy configuration: redeemCodes');
    codes.add(reward.code); integer('redeemCodes.diamonds', reward.diamonds);
  });
  integer('testResources.diamonds', config.testResources.diamonds);
  integer('testResources.starGems', config.testResources.starGems);
  integer('testResources.adventureTickets', config.testResources.adventureTickets);
  integer('testResources.adventureCores', config.testResources.adventureCores);
  integer('testResources.relicMaxDrawCount', config.testResources.relicMaxDrawCount, 1);
  integer('testResources.rebirthRewardFloorStage', config.testResources.rebirthRewardFloorStage, 1);
}

function freeze<T extends object>(value: T): DeepReadonly<T> {
  Object.values(value).forEach(item => { if (item && typeof item === 'object') freeze(item); });
  return Object.freeze(value) as DeepReadonly<T>;
}
validateEconomyConfig(settings);
export const ECONOMY_CONFIG: EconomyConfig = freeze(settings);
