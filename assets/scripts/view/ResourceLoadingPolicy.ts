export type BackgroundPreparationMode = 'download-only' | 'decode' | 'full';

export const RESOURCE_LOADING_POLICY = {
  preparationMode: 'full' as BackgroundPreparationMode,
  startup: { coldBudgetMs: 10000, warmBudgetMs: 3000, prefetchPanels: 2,
    uiFrameBudgetMs: 12, uiMaxStepsPerFrame: 1024,
    // Cocos 3.8.8 uses the caller's limits to drain its shared download queue.
    // Runtime's one-request budget would also throttle foreground boot loads.
    engine: { priority: -1, maxConcurrency: 6, maxRequestsPerFrame: 6, maxRetryCount: 0 } },
  foreground: { maxConcurrency: 4, retryDelaysMs: [250, 1000] },
  background: {
    startDelayMs: 1000,
    preparationStartDelayMs: 0,
    maxConcurrency: 2,
    maxAttempts: 2,
    retryDelayMs: 10000,
    recoveryDelayMs: 60000,
    requestTimeoutMs: 60000,
    preparationConcurrency: 1,
    engine: { priority: -1, maxConcurrency: 2, maxRequestsPerFrame: 1, maxRetryCount: 0 },
    priorities: { unlocked: 40, common: 30, locked: 10, maps: -10, audio: -20, promoted: 100, visuals: -10, nextStage: 20,
      commonBonus: 20, weaponsBonus: 20, usedBonus: 2, maxUseCount: 10 },
  },
  // Reserve rendering headroom after gameplay instead of treating every update
  // over 8 ms as overloaded (including otherwise healthy 30 Hz devices).
  // One millisecond only prevents duplicate admission at a coarse timestamp;
  // every ordinary rendering frame can spend the shared UI budget. Decoding
  // retains its own cadence and never takes every other UI frame away.
  backgroundScheduling: { startupDelayMs: 1500, intervalMs: 1, decodeIntervalMs: 32, slowFrameMs: 67,
    minFrameMs: 1000 / 60, maxFrameMs: 1000 / 30, frameReserveMs: 3, busyFrameDelayMs: 50,
    recoveryDelayMs: 500, stableFrames: 6, maxDeferralMs: 1000 },
  uiPreparation: { frameBudgetMs: 1, maxStepsPerFrame: 12, foregroundFrameBudgetMs: 6, foregroundMaxStepsPerFrame: 256 },
  wechat: { maxConcurrency: 6, maxRequestsPerFrame: 6, maxRetryCount: 2 },
  nextStageDelayMs: 5000,
} as const;
