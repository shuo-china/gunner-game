import { EventTouch, Font, Node, UITransform } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback } from './OriginalWeaponFeedback';

export type FeatureName = 'weapons' | 'rebirth' | 'speedrun' | 'raid' | 'boss' | 'skins' | 'pets' | 'fish' | 'hunt' | 'mine' | 'adventure';
const POSITIONS: Record<FeatureName, [number, number]> = {
  weapons: [-1, 355], skins: [-1, 480], fish: [-1, 605], pets: [-1, 730], rebirth: [-1, 855], speedrun: [1, 355], mine: [1, 480], boss: [1, 605], hunt: [1, 730], adventure: [1, 855], raid: [1, 980],
};

/** Unity Left_Menu keeps visible buttons packed above the bottom safe edge. */
export function leftMenuOffsets(visible: Partial<Record<FeatureName, boolean>>): Partial<Record<FeatureName, number>> {
  const positions: Partial<Record<FeatureName, number>> = {};
  let next = 355;
  for (const name of ['weapons', 'skins', 'fish', 'pets', 'rebirth'] as const) {
    if (visible[name]) { positions[name] = next; next += 125; }
  }
  return positions;
}

/** Unity Right_Menu's BottomRight VerticalLayoutGroup ignores inactive buttons. */
export function rightMenuOffsets(visible: Partial<Record<FeatureName, boolean>>): Partial<Record<FeatureName, number>> {
  const positions: Partial<Record<FeatureName, number>> = {};
  let next = 355;
  for (const name of ['speedrun', 'mine', 'boss', 'hunt', 'adventure', 'raid'] as const) {
    if (visible[name]) { positions[name] = next; next += 125; }
  }
  return positions;
}

export async function loadFeatureEntry(art: ArtLibrary, name: FeatureName): Promise<WeaponHudAssets> {
  const config = await art.json<WeaponUiConfig>(`art/feature-entries/${name}`);
  const paths = Object.values(config.images).map(spec => spec.path);
  for (const font of Object.values(config.bitmapFonts ?? {})) paths.push(...font.pages);
  const placeholder = new Font();
  await Promise.all(Array.from(new Set(paths), path => art.loadFrame(path)));
  return { config, chineseFont: null, originalFont: placeholder, numberFont: placeholder };
}

/** The same authored menu subtree, independent of the unopened full panel. */
export class FeatureEntry {
  readonly node: Node;
  readonly entry: Node;
  private readonly ui: OriginalWeaponUi;
  private blocked = false;
  private pointer: number | null = null;
  private entryOffset?: number;
  private height = 1920;
  private width = 1080;
  private readonly feedback: OriginalWeaponFeedback;
  constructor(parent: Node, art: ArtLibrary, private readonly assets: WeaponHudAssets, readonly name: FeatureName,
    open: () => void, playSound?: (id: number) => void) {
    this.node = makeNode(`FeatureEntry_${name}`, parent);
    this.ui = new OriginalWeaponUi(art, assets);
    this.entry = this.ui.create(assets.config.roots.entry, this.node);
    this.feedback = new OriginalWeaponFeedback(undefined, undefined, name === 'rebirth');
    const spec = assets.config.nodes[assets.config.roots.entry];
    this.entry.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
      event.propagationStopped = true;
      if (this.blocked || this.pointer !== null) return;
      this.pointer = event.getID() ?? -1; this.feedback.press(this.entry, spec);
    });
    this.entry.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => {
      if (this.pointer === (event.getID() ?? -1)) this.cancelInteractions();
    });
    this.entry.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
      event.propagationStopped = true;
      if (this.pointer !== (event.getID() ?? -1)) return;
      this.pointer = null; this.feedback.release(this.entry);
      if (this.blocked || !this.entry.getComponent(UITransform)!.getBoundingBoxToWorld().contains(event.getUILocation())) return;
      open(); if (spec.clickSound !== undefined) playSound?.(spec.clickSound);
    });
  }
  setState(visible: boolean, locked: boolean, blocked: boolean): void {
    this.node.active = visible; this.blocked = blocked;
    if (!visible || blocked) this.cancelInteractions();
    for (const spec of Object.values(this.assets.config.nodes)) if (spec.name === 'Locked_obj') this.ui.show(spec.id, locked);
  }
  setAlert(visible: boolean): void {
    for (const spec of Object.values(this.assets.config.nodes)) if (spec.name === 'Alert_obj') this.ui.show(spec.id, visible);
  }
  resize(width: number, height: number, top = 0, bottom = 0): void {
    this.cancelInteractions();
    const scale = width / this.assets.config.referenceWidth, w = width / scale, h = (height - top - bottom) / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottom - top) / 2);
    this.node.getComponent(UITransform)!.setContentSize(w, h);
    this.ui.layout(this.assets.config.roots.entry, 130, 120);
    this.width = w; this.height = h;
    const [side, y] = POSITIONS[this.name]; this.entry.setPosition(side * w / 2, -h / 2 + (this.entryOffset ?? y));
  }
  setEntryOffset(y: number): void {
    this.entryOffset = y;
    this.entry.setPosition(POSITIONS[this.name][0] * this.width / 2, -this.height / 2 + y);
  }
  update(dt: number): void { this.feedback.update(dt); }
  cancelInteractions(): void { this.pointer = null; this.feedback.clear(); }
  destroy(): void { this.cancelInteractions(); this.ui.destroy(); this.node.destroy(); }
}
