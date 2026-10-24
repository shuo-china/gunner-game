const imports = {
  weapons: () => import('./WeaponHud'), speedrun: () => import('./SpeedRunHud'),
  rebirth: () => import('./RebirthHud'), raid: () => import('./RaidHud'),
  boss: () => import('./BossHud'), hunt: () => import('./HuntHud'), mine: () => import('./MineHud'),
  skins: () => import('./SkinHud'), pets: () => import('./PetHud'), fish: () => import('./FishHud'),
  adventure: () => import('./AdventureHud'),
};
type FeatureCodeName = keyof typeof imports;

/** On WeChat, register the requested code and its shared dependencies before
 * SystemJS imports it. Web/editor builds use their ordinary dynamic imports. */
export async function loadFeatureCode<N extends FeatureCodeName>(name: N): Promise<Awaited<ReturnType<typeof imports[N]>>> {
  const scope = globalThis as typeof globalThis & { __FOREST_GUNNER_LOAD_FEATURE_CODE__?: (name: string) => Promise<void> };
  await scope.__FOREST_GUNNER_LOAD_FEATURE_CODE__?.(name);
  return imports[name]() as Promise<Awaited<ReturnType<typeof imports[N]>>>;
}
