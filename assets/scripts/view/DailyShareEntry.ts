import { Font, Node } from 'cc';
import { ArtLibrary } from './ArtLibrary';
import { FeatureEntry } from './FeatureEntry';
import type { OriginalUiNode, Pair, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';

// Reuse the menu plate and load the generated share-and-diamond emblem as one sprite.
export const DAILY_SHARE_ENTRY_IMAGES = ['art/boss-system/images/s803', 'art/share-system/images/entry-share'] as const;

function node(id: string, position: Pair, size: Pair, children: string[] = []): OriginalUiNode {
  return { id, transform: id, name: id, active: true, components: [], children,
    rect: { min: [.5, .5], max: [.5, .5], position, size, pivot: [.5, .5], scale: [1, 1], angle: 0 } };
}

export function dailyShareEntryConfig(): WeaponUiConfig {
  const entry = node('ShareEntry', [0, 0], [130, 120], ['ShareIcon', 'ShareLabel']);
  entry.rect.pivot = [1, .5]; entry.rect.min = entry.rect.max = [0, 0];
  entry.image = { sprite: 'background', color: [255, 207, 85, 255], sliced: true, raycast: true };
  entry.bounceButton = { scale: .9, duration: .1, source: 'share' }; entry.clickSound = 1;
  const icon = node('ShareIcon', [0, 18], [80, 80]);
  icon.image = { sprite: 'share', color: [255, 255, 255, 255], preserveAspect: true, raycast: false };
  const label = node('ShareLabel', [0, -39], [120, 38]);
  label.text = { value: '分享',
    size: 42, color: [255, 255, 255, 255], horizontal: 2, vertical: 512,
    autosize: true, wrap: false, outline: true, font: '', term: '', useSystemFont: true, raycast: false };
  return { version: 1, referenceWidth: 1080, roots: { entry: entry.id },
    nodes: { ShareEntry: entry, ShareIcon: icon, ShareLabel: label },
    images: {
      background: { path: DAILY_SHARE_ENTRY_IMAGES[0], sizePx: [33, 78], sizeUnits: [.33, .78], anchor: [.5, .5] },
      share: { path: DAILY_SHARE_ENTRY_IMAGES[1], sizePx: [1254, 1254], sizeUnits: [12.54, 12.54], anchor: [.5, .5] },
    }, roles: {}, gunIcons: [], degreeColors: [], translations: {} };
}

export async function loadDailyShareEntryAssets(art: ArtLibrary): Promise<WeaponHudAssets> {
  await Promise.all(DAILY_SHARE_ENTRY_IMAGES.map(path => art.loadFrame(path)));
  const font = new Font();
  return { config: dailyShareEntryConfig(), chineseFont: null, originalFont: font, numberFont: font };
}

export class DailyShareEntry extends FeatureEntry {
  constructor(parent: Node, art: ArtLibrary, assets: WeaponHudAssets, share: () => void, playSound?: (id: number) => void) {
    super(parent, art, assets, 'share', share, playSound);
    this.setState(false, false, true);
  }
  setRewardState(visible: boolean, blocked: boolean): void {
    this.setState(visible, false, blocked);
  }
}
