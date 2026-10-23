import { Color, Label, Mask, Node, Sprite, UITransform, Vec2 } from 'cc';
import type { EventTouch } from 'cc';
import type { BattleHudState } from '../session/BattleSession';
import type { UpgradeType } from '../session/UpgradeEconomy';
import { ArtLibrary, makeNode } from './ArtLibrary';
import type { HudColor, OriginalHudAssets, UpgradeImageName } from './OriginalHudAssets';
import { UpgradeInput } from './UpgradeInput';
import { attachFontPolicyLabel } from './FontPolicyLabel';

type Pair = [number, number];
interface Card {
  type: UpgradeType; node: Node; level: Label; value: Label; price: Label;
  available: Node; fill: Node; flash: Sprite; flashInput: Node; flashTime: number; scale: number; progress: number;
}

/** Original Ingame/Upgrade_List, in the same 1080-wide coordinates as Main_UI. */
export class UpgradeHud {
  readonly node: Node;
  private readonly input: UpgradeInput;
  private readonly cards: Card[];
  private destroyed = false;
  private readonly textViews: ReturnType<typeof attachFontPolicyLabel>[] = [];

  constructor(parent: Node, private readonly art: ArtLibrary, private readonly assets: OriginalHudAssets,
    onUpgrade: (type: UpgradeType) => boolean) {
    this.node = makeNode('Upgrade_List', parent);
    const { interaction } = assets.upgrades;
    this.input = new UpgradeInput(type => {
      const success = onUpgrade(type);
      const card = this.cards.find(item => item.type === type);
      if (success && card) {
        card.flashTime = this.assets.upgrades.animation.duration;
        card.flash.node.getComponent(UITransform)!.setContentSize(...this.assets.upgrades.layout.size);
        card.flashInput.getComponent(UITransform)!.setContentSize(...this.assets.upgrades.layout.size);
        card.flash.node.active = true;
      }
      return success;
    }, interaction.holdDelay, interaction.holdInterval);
    this.cards = (['power', 'speed', 'money'] as UpgradeType[]).map((type, index) => this.createCard(type, index));
  }

  resize(width: number, height: number, bottomInset: number): void {
    const scale = width / this.assets.upgrades.referenceWidth;
    this.node.setScale(scale, scale, 1);
    this.node.setPosition(0, -height / 2 + bottomInset + this.assets.upgrades.layout.bottom * scale, 0);
  }

  update(state: BattleHudState, dt: number): void {
    if (this.destroyed) return;
    this.input.setEnabled(!state.paused && !state.resultsReady);
    const { palette: p, layout: l, interaction } = this.assets.upgrades;
    const { units, maxDisplayedDigits } = this.assets.config.format;
    for (const card of this.cards) {
      const upgrade = state.upgrades.find(item => item.type === card.type);
      card.node.active = !!upgrade;
      if (!upgrade) continue;
      setText(card.level, `Lv.${upgrade.level}`);
      setText(card.value, card.type === 'speed' ? upgrade.value.discardDecimal().toString()
        : upgrade.value.format(units, maxDisplayedDigits));
      setText(card.price, upgrade.price ? upgrade.price.format(units, maxDisplayedDigits) : 'Max');
      card.price.color = upgrade.price && !upgrade.affordable ? color(p.insufficient) : Color.WHITE;
      card.available.active = !!upgrade.price && upgrade.affordable;
      const progress = upgrade.price && !upgrade.affordable ? Math.max(0, Math.min(1, upgrade.progress)) : 0;
      if (progress !== card.progress) {
        card.progress = progress; card.fill.active = progress > 0;
        if (progress > 0) card.fill.getComponent(UITransform)!.setContentSize(l.size[0], l.size[1] * progress);
      }
    }
    this.input.update(dt);
    this.syncText();
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    for (const card of this.cards) {
      const target = this.input.pressedType === card.type ? interaction.pressedScale : 1;
      // Release duration and scale match BounceBtn; no scheduled callbacks survive disposal.
      const step = (1 - interaction.pressedScale) * elapsed / interaction.releaseSeconds;
      const scale = target < card.scale ? Math.max(target, card.scale - step) : Math.min(target, card.scale + step);
      if (scale !== card.scale) { card.scale = scale; card.node.setScale(scale, scale, 1); }
      if (card.flashTime > 0) {
        card.flashTime = Math.max(0, card.flashTime - elapsed);
        card.flash.node.active = card.flashTime > 0;
        const animation = this.assets.upgrades.animation;
        const time = animation.duration - card.flashTime;
        const coefficients = time < animation.peakTime ? animation.grow : animation.shrink;
        const t = time < animation.peakTime ? time : time - animation.peakTime;
        const delta = Math.max(0, ((coefficients[0] * t + coefficients[1]) * t + coefficients[2]) * t + coefficients[3]);
        card.flash.node.getComponent(UITransform)!.setContentSize(l.size[0] + delta, l.size[1] + delta);
        // Keep the gesture owner enabled when the visual ends. Cocos discards
        // releases captured by disabled nodes; a zero-sized active proxy still
        // receives its END/CANCEL without claiming new touches off the panel.
        card.flashInput.getComponent(UITransform)!.setContentSize(
          card.flashTime > 0 ? l.size[0] + delta : 0, card.flashTime > 0 ? l.size[1] + delta : 0);
      }
    }
  }

  private syncText(): void { this.textViews.forEach(view => view.sync()); }

  cancelInteractions(): void {
    this.input.cancel();
    for (const card of this.cards) {
      card.scale = 1; card.node.setScale(1, 1, 1);
    }
  }

  getTutorialPowerTarget(): Node | null {
    const power = this.cards.find(card => card.type === 'power')?.node;
    return !this.destroyed && this.node.active && power?.active ? power : null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.input.setEnabled(false); this.cancelInteractions();
    this.textViews.forEach(view => view.destroy());
    if (this.node.isValid) { this.node.active = false; this.node.removeFromParent(); this.node.destroy(); }
  }

  private createCard(type: UpgradeType, index: number): Card {
    const { layout: l, palette: p, titles, font } = this.assets.upgrades;
    const node = this.image(`Upgrade_${type}`, 'panel', this.node, l.size, [l.centers[index], 0], p.panel, true);
    const flash = this.image('Upgrade_Anim', 'flash', node, l.flashSize, l.flashPosition, p.flash, true).getComponent(Sprite)!;
    flash.node.active = false;
    this.image('Panel', 'panel', node, l.size, [0, 0], p.panel, true);
    const fill = makeNode('Fill', node);
    fill.getComponent(UITransform)!.setAnchorPoint(.5, 0);
    fill.getComponent(UITransform)!.setContentSize(...l.size);
    fill.setPosition(0, -l.size[1] / 2, 0);
    fill.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
    this.image('FillImage', 'panel', fill, l.size, [0, l.size[1] / 2], p.fill, true);
    const available = this.image('UpgradeAble_obj', 'panel', node, l.size, [0, 0], p.affordable, true);
    this.image('Outline', 'outline', node, l.size, [0, 0], undefined, true);
    const value = this.label('Value_txt', node, l.valueFontSize, l.valuePosition, l.valueSize);
    const level = this.label('Lv_txt', node, l.levelFontSize, l.levelPosition, l.levelSize);
    // Original TMP Lv_txt uses HorizontalAlignment.Right (4). Its wide
    // RectTransform is intentionally offset by +34; the text hugs its right edge.
    level.horizontalAlign = Label.HorizontalAlign.RIGHT;
    const priceNode = this.image('Price', 'price', node, l.priceSize, l.pricePosition, p.price, true);
    this.image('Icon', 'cash', priceNode, l.priceIconSize, l.priceIconPosition);
    const price = this.label('Price_txt', priceNode, l.priceFontSize, l.priceTextPosition, l.priceTextSize);
    const title = this.label('Title_txt', node, l.titleFontSize * font.sourceScale, l.titlePosition, l.titleSize, true);
    title.string = titles[index];
    this.image('Icon', type, node, l.iconSize, l.iconPosition);
    const flashInput = makeNode('UpgradeFlashInput', node);
    flashInput.setPosition(...l.flashPosition, 0);
    flashInput.getComponent(UITransform)!.setContentSize(0, 0);
    // Source TMP title/level and the expanding flash raycast beyond the panel.
    // Cocos only hit-tests nodes with listeners, so bind the extended graphics
    // to one gesture owner and accept releases on any graphic of that button.
    const hitRegions = [node, title.node, level.node, flashInput];
    const contains = (event: EventTouch): boolean => hitRegions.some(region => {
      for (let ancestor: Node | null = region; ancestor; ancestor = ancestor.parent) if (!ancestor.active) return false;
      return region.getComponent(UITransform)!.hitTest(event.getLocation());
    });
    const finish = (event: EventTouch, click: boolean): void => {
      event.propagationStopped = true;
      const pointer = event.getID();
      if (pointer === null) return;
      if (click && contains(event)) this.input.release(pointer); else this.input.cancel(pointer);
    };
    for (const region of hitRegions) {
      region.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
        event.propagationStopped = true;
        const pointer = event.getID(); if (pointer !== null) this.input.press(type, pointer);
      });
      // Upgrade_Ingame implements Down/Up, but no PointerExit handler: its
      // repeat coroutine survives moving outside until release or cancellation.
      region.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => { event.propagationStopped = true; });
      region.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
      region.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event,
        event.getEventCode?.() === Node.EventType.TOUCH_END));
    }
    return { type, node, level, value, price, available, fill, flash, flashInput, flashTime: 0, scale: 1, progress: -1 };
  }

  private image(name: string, key: UpgradeImageName, parent: Node, size: Pair, position: Pair,
    tint?: HudColor, sliced = false): Node {
    const node = this.art.image(name, this.assets.upgrades.images[key], parent);
    node.getComponent(UITransform)!.setContentSize(...size); node.setPosition(...position, 0);
    const sprite = node.getComponent(Sprite)!;
    if (sliced) sprite.type = Sprite.Type.SLICED;
    if (tint) sprite.color = color(tint);
    return node;
  }

  private label(name: string, parent: Node, size: number, position: Pair, bounds: Pair, chinese = false): Label {
    const node = makeNode(name, parent); node.setPosition(...position, 0);
    const label = node.addComponent(Label);
    const style = chinese ? this.assets.upgrades.font : this.assets.config.font;
    label.font = null; label.useSystemFont = true; label.fontFamily = 'sans-serif';
    label.fontSize = size; label.color = Color.WHITE;
    // TMP Value_txt has auto-size disabled and a 45px font in a 44.2822px
    // rectangle. Cocos SHRINK measures lineHeight, not glyph height: the old
    // 56.25px line reduced the real font to 35px. These are single-line labels;
    // fit only the line advance to the source box so the original font remains
    // 45px, while exceptionally long formatted amounts can still fit in width.
    label.lineHeight = Math.min(size * 1.25, bounds[1]);
    label.horizontalAlign = Label.HorizontalAlign.CENTER; label.verticalAlign = Label.VerticalAlign.CENTER;
    label.overflow = Label.Overflow.SHRINK; label.enableWrapText = false;
    label.enableOutline = true; label.outlineColor = color(style.outlineColor); label.outlineWidth = style.outlineWidth;
    if (!chinese) {
      label.enableShadow = true; label.shadowColor = color(this.assets.config.font.shadowColor);
      label.shadowOffset = new Vec2(...this.assets.config.font.shadowOffset); label.shadowBlur = 0;
    }
    node.getComponent(UITransform)!.setContentSize(...bounds);
    if (!chinese) this.textViews.push(attachFontPolicyLabel(label, this.art, this.assets.config.bitmapFont));
    return label;
  }
}

function color(value: HudColor): Color { return new Color(...value); }
function setText(label: Label, value: string): void { if (label.string !== value) label.string = value; }
