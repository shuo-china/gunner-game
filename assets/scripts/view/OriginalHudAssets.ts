import { Font, resources } from 'cc';
import { ArtLibrary, ImageSpec } from './ArtLibrary';

export type HudImageName = 'stage_background' | 'stage_fill' | 'stage_hole' | 'stage_dot' |
  'cat_icon' | 'bar' | 'bar_outline' | 'settings' | 'money_icon' | 'diamond_icon' | 'currency_background' | 'hatch';
export type HudColor = [number, number, number, number];
type Pair = [number, number];
export interface OriginalHudConfig {
  version: number;
  referenceWidth: number;
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
  upgrades: OriginalUpgradeConfig; upgradeFont: Font }

/** Cocos/ArtLibrary own resources; each HUD only destroys its view nodes. */
export async function loadOriginalHudAssets(art: ArtLibrary): Promise<OriginalHudAssets> {
  const [config, upgrades] = await Promise.all([
    art.json<OriginalHudConfig>('art/hud/config'), art.json<OriginalUpgradeConfig>('art/upgrades/config'),
  ]);
  if (config.version !== 1 || config.referenceWidth <= 0 || config.layout.dotPositions.length !== 5) {
    throw new Error('Unsupported original HUD configuration');
  }
  if (upgrades.version !== 1 || upgrades.referenceWidth !== config.referenceWidth || upgrades.layout.centers.length !== 3) {
    throw new Error('Unsupported original upgrade configuration');
  }
  const loadFont = (path: string): Promise<Font> => new Promise((resolve, reject) => resources.load(path, Font,
    (error, font) => error ? reject(error) : resolve(font)));
  const [font, upgradeFont] = await Promise.all([loadFont(config.font.path), loadFont(upgrades.font.path),
    Promise.all([...Object.values(config.images), ...Object.values(upgrades.images)].map(spec => art.loadFrame(spec.path)))]);
  return { config, font, upgrades, upgradeFont };
}
