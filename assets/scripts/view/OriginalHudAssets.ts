import { Font } from 'cc';
import { ArtLibrary, ImageSpec } from './ArtLibrary';
import type { OriginalBitmapFont } from './OriginalBitmapText';
import type { OriginalStageTransitionAssets, OriginalStageTransitionConfig } from './OriginalStageTransition';

export type HudImageName = 'stage_background' | 'stage_fill' | 'stage_hole' | 'stage_dot' |
  'cat_icon' | 'bar' | 'bar_outline' | 'settings' | 'money_icon' | 'diamond_icon' | 'currency_background' | 'hatch' |
  'joystick_background' | 'joystick_handle';
export type HudColor = [number, number, number, number];
type Pair = [number, number];
export interface OriginalHudConfig {
  version: number;
  referenceWidth: number;
  bitmapFont: OriginalBitmapFont;
  joystick: { backgroundSize: number; handleSize: number; handleRange: number; deadZone: number; axisOptions: number; snapX: boolean; snapY: boolean };
  images: Record<HudImageName, ImageSpec & { border: [number, number, number, number]; source: string }>;
  font: { path: string; sourceSha256: string; outlineColor: HudColor; outlineWidth: number;
    shadowColor: HudColor; shadowOffset: Pair };
  palette: { stageBackground: HudColor; stageRing: HudColor; stageFuture: HudColor;
    stageCurrent: HudColor; stagePast: HudColor; stageFill: HudColor; stageInner: HudColor;
    barBackground: HudColor; valueFill: HudColor; timeFill: HudColor; currencyBackground: HudColor; hatch: HudColor };
  layout: {
    barHeight: number; timeBarTop: number; valueBarTop: number;
    stagePosition: Pair; stageSize: Pair; stageFillSize: Pair; dotPositions: number[];
    ringSize: number; dotSize: number; catOffset: Pair; catSize: Pair;
    stageTextPosition: Pair; stageTextSize: Pair; stageFontSize: number;
    valueTextPosition: Pair; valueFontSize: number;
    settingsPosition: Pair; settingsSize: Pair;
    moneyPosition: Pair; moneySize: Pair; diamondPosition: Pair; diamondSize: Pair;
    moneyIconPosition: Pair; moneyIconSize: Pair; diamondIconPosition: Pair; diamondIconSize: Pair;
    moneyTextPosition: Pair; moneyTextSize: Pair; diamondTextPosition: Pair; diamondTextSize: Pair;
    currencyFontSize: number;
  };
  format: { units: string[]; maxDisplayedDigits: number };
}
export type UpgradeImageName = 'panel' | 'outline' | 'price' | 'cash' | 'power' | 'speed' | 'money' | 'flash';
export interface OriginalUpgradeConfig {
  version: number;
  referenceWidth: number;
  images: Record<UpgradeImageName, ImageSpec & { border: [number, number, number, number]; source: string }>;
  font: { path: string; sourceScale: number; outlineColor: HudColor; outlineWidth: number };
  titles: [string, string, string];
  layout: {
    bottom: number; centers: [number, number, number]; size: Pair;
    titlePosition: Pair; titleSize: Pair; titleFontSize: number;
    iconPosition: Pair; iconSize: Pair;
    levelPosition: Pair; levelSize: Pair; levelFontSize: number;
    valuePosition: Pair; valueSize: Pair; valueFontSize: number;
    pricePosition: Pair; priceSize: Pair; priceIconPosition: Pair; priceIconSize: Pair;
    priceTextPosition: Pair; priceTextSize: Pair; priceFontSize: number;
    flashSize: Pair; flashPosition: Pair;
  };
  palette: { panel: HudColor; fill: HudColor; affordable: HudColor; price: HudColor;
    insufficient: HudColor; flash: HudColor };
  interaction: { holdDelay: number; holdInterval: number; pressedScale: number; releaseSeconds: number };
  animation: { duration: number; peakTime: number; grow: [number, number, number, number]; shrink: [number, number, number, number] };
}
export interface OriginalHudAssets { config: OriginalHudConfig; font: Font;
  upgrades: OriginalUpgradeConfig; upgradeFont: Font; stageTransition: OriginalStageTransitionAssets }

/** Cocos/ArtLibrary own resources; each HUD only destroys its view nodes. */
export async function loadOriginalHudAssets(art: ArtLibrary): Promise<OriginalHudAssets> {
  const [config, upgrades, stage] = await Promise.all([
    art.json<OriginalHudConfig>('art/hud/config'), art.json<OriginalUpgradeConfig>('art/upgrades/config'),
    art.json<OriginalStageTransitionConfig>('art/stage-transition/config'),
  ]);
  if (config.version !== 1 || config.referenceWidth <= 0 || config.layout.dotPositions.length !== 5) {
    throw new Error('Unsupported original HUD configuration');
  }
  if (upgrades.version !== 1 || upgrades.referenceWidth !== config.referenceWidth || upgrades.layout.centers.length !== 3) {
    throw new Error('Unsupported original upgrade configuration');
  }
  if (stage.version !== 1 || !stage.bitmapFonts || stage.referenceWidth !== config.referenceWidth || stage.confetti.length !== 3) {
    throw new Error('Unsupported original stage transition configuration');
  }
  const paths = [...Object.values(config.images), ...Object.values(upgrades.images), ...Object.values(stage.images)].map(spec => spec.path);
  paths.push(...config.bitmapFont.pages);
  for (const bitmap of Object.values(stage.bitmapFonts)) paths.push(...bitmap.pages);
  await Promise.all(Array.from(new Set(paths), path => art.loadFrame(path)));
  // Font objects preserve the legacy asset interface; all drawn Latin glyphs
  // come from the preloaded atlases and Chinese uses the platform system font.
  const font = new Font();
  return { config, font, upgrades, upgradeFont: font, stageTransition: { config: stage, font } };
}
