import { BlockInputEvents, Color, Graphics, Label, Mask, Node, Sprite, UITransform, Vec2 } from 'cc';
import type { BattleHudState } from '../session/BattleSession';
import type { UpgradeType } from '../session/UpgradeEconomy';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { completionRatio, formatDiamonds, formatGold, stageLabel, stageWaveIndex, timeRatio, usesStageHud } from './HudMath';
import type { HudColor, HudImageName, OriginalHudAssets } from './OriginalHudAssets';
import { UpgradeHud } from './UpgradeHud';

type Pair = [number, number];
const ink = new Color(85, 60, 40);
const cream = new Color(255, 245, 206);

/** Hosts mutually exclusive battle HUD roots. Results belong to the host so
 * Main_UI can be detached without leaking stage widgets into other modes. */
export class GameHud {
  readonly node: Node;
  private stage?: StageHud;
  private upgrades?: UpgradeHud;
  private readonly complete: Node;
  private readonly completeCard: Node;
  private readonly completeStats: Label;
  private readonly backdrop: Node;
  private lastComplete = false;
  private lastResult = '';
  private width = 720;
  private height = 1280;
  private topInset = 0;
  private bottomInset = 0;
  private destroyed = false;

  constructor(parent: Node, private readonly art: ArtLibrary, private readonly assets: OriginalHudAssets,
    onRestart: () => void, private readonly onUpgrade: (type: UpgradeType) => boolean = () => false) {
    this.node = makeNode('BattleHud', parent);
    this.complete = makeNode('CompleteOverlay', this.node);
    this.complete.active = false;
    this.backdrop = makeNode('Shade', this.complete);
    box(this.backdrop, 2400, 3000, 0, new Color(37, 39, 26, 145));
    this.backdrop.addComponent(BlockInputEvents);
    this.backdrop.on(Node.EventType.TOUCH_END, () => {});
    this.completeCard = makeNode('Results', this.complete);
    box(this.completeCard, 570, 382, 34, cream, ink, 7);
    resultText(this.completeCard, '森林清理完成', 39, 0, 104, ink);
    resultText(this.completeCard, '每一棵树，都已清除。', 22, 0, 48, new Color(131, 103, 67));
    this.completeStats = resultText(this.completeCard, '', 25, 0, -4, new Color(93, 128, 57));
    const again = makeNode('PlayAgain', this.completeCard);
    again.setPosition(0, -100, 0);
    box(again, 300, 79, 23, new Color(139, 171, 76), ink, 5);
    resultText(again, '再来一次', 28, 0, 0, cream);
    again.on(Node.EventType.TOUCH_END, onRestart);
    this.resize(this.width, this.height);
  }

  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    if (this.destroyed) return;
    this.width = width; this.height = height; this.topInset = topInset; this.bottomInset = bottomInset;
    this.stage?.resize(width, height, topInset);
    this.upgrades?.resize(width, height, bottomInset);
    const scale = Math.max(.1, Math.min(1, (width - 30) / 640));
    this.completeCard.setScale(scale, scale, 1);
    this.completeCard.setPosition(0, (bottomInset - topInset) / 2, 0);
    this.backdrop.setScale(Math.max(1, width / 2400), Math.max(1, height / 3000), 1);
  }

  update(state: BattleHudState, dt = 0): void {
    if (this.destroyed) return;
    if (usesStageHud(state.mode)) {
      if (!this.stage) {
        this.stage = new StageHud(this.node, this.art, this.assets);
        this.stage.node.setSiblingIndex(0);
        this.stage.resize(this.width, this.height, this.topInset);
      }
      this.stage.update(state);
      if (!this.upgrades) {
        this.upgrades = new UpgradeHud(this.node, this.art, this.assets, this.onUpgrade);
        this.upgrades.node.setSiblingIndex(1);
        this.upgrades.resize(this.width, this.height, this.bottomInset);
      }
      this.upgrades.update(state, dt);
    } else if (this.stage) {
      this.stage.destroy(); this.stage = undefined;
      this.upgrades?.destroy(); this.upgrades = undefined;
    }
    const showResult = usesStageHud(state.mode) && state.complete && state.resultsReady;
    if (showResult !== this.lastComplete) this.complete.active = showResult;
    if (showResult) {
      const seconds = Math.max(0, Math.floor(state.elapsed));
      const value = `${state.totalTrees} 棵树   ·   ${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
      if (value !== this.lastResult) { this.completeStats.string = value; this.lastResult = value; }
    }
    this.lastComplete = showResult;
  }

  cancelInteractions(): void { this.upgrades?.cancelInteractions(); }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stage?.destroy(); this.stage = undefined;
    this.upgrades?.destroy(); this.upgrades = undefined;
    if (this.node.isValid) { this.node.active = false; this.node.destroy(); }
  }
}

/** Source geometry stays in the original 1080-wide Canvas coordinates. */
class StageHud {
  readonly node: Node;
  private readonly progress: ClippedFill;
  private readonly timer: ClippedFill;
  private readonly stageFill: ClippedFill;
  private readonly stageText: Label;
  private readonly valueText: Label;
  private readonly moneyText: Label;
  private readonly diamondText: Label;
  private readonly dots: Sprite[] = [];
  private readonly cat: Node;
  private readonly hatch: Node;
  private lastWave = -1;
  private lastStageLabel = '';
  private lastPercent = -1;
  private lastMoney = '';
  private lastDiamonds = NaN;
  private lastHatchOffset = NaN;

  constructor(parent: Node, private readonly art: ArtLibrary, private readonly assets: OriginalHudAssets) {
    const { layout: l, palette: p, referenceWidth: w } = assets.config;
    this.node = makeNode('Main_UI', parent);
    // Unity serializes Time before Value; the bars overlap by 22 reference px.
    const time = this.image('Time_Slider', 'bar', this.node, [w, l.barHeight], [0, -l.timeBarTop - l.barHeight / 2], p.barBackground, true);
    this.timer = this.fill('TimeFill', time, 'bar', [w, l.barHeight], p.timeFill);
    this.image('Outline', 'bar_outline', time, [w, l.barHeight], [0, 0], undefined, true);
    const value = this.image('Value_Slider', 'bar', this.node, [w, l.barHeight], [0, -l.valueBarTop - l.barHeight / 2], p.barBackground, true);
    this.progress = this.fill('ValueFill', value, 'bar', [w, l.barHeight], p.valueFill);
    this.hatch = makeNode('HatchScroll', this.progress.clip);
    for (let i = 0; i < 13; i++) {
      this.image(`Hatch${i}`, 'hatch', this.hatch, [100, 100], [i * 100 + 50, 50 - l.barHeight / 2], p.hatch);
    }
    this.image('Outline', 'bar_outline', value, [w, l.barHeight], [0, 0], undefined, true);
    this.valueText = this.label('Value_txt', this.node, l.valueFontSize, l.valueTextPosition, [332.9, 50]);

    const row = this.image('Game_Slider', 'stage_background', this.node, l.stageSize, l.stagePosition, p.stageBackground, true);
    // Source Images with null sprites are solid quads, not replacement art.
    box(makeNode('Outline', row), l.stageSize[0], l.stageSize[1], 0, color(p.stageRing));
    for (let i = 0; i < l.dotPositions.length; i++) {
      this.image(`hole_${i}`, 'stage_hole', row, [l.ringSize, l.ringSize], [l.dotPositions[i], 0], p.stageRing);
    }
    box(makeNode('Fill_Basic', row), l.stageFillSize[0], l.stageFillSize[1], 0, color(p.stageInner));
    this.stageFill = this.fill('StageFill', row, 'stage_fill', l.stageFillSize, p.stageFill);
    for (let i = 0; i < l.dotPositions.length; i++) {
      this.dots.push(this.image(`hole_fill_${i}`, 'stage_dot', row, [l.dotSize, l.dotSize], [l.dotPositions[i], 0], p.stageFuture).getComponent(Sprite)!);
    }
    this.cat = this.image('Player_Icon', 'cat_icon', row, l.catSize, l.catOffset);
    this.stageText = this.label('Stage_txt', row, l.stageFontSize, l.stageTextPosition, l.stageTextSize);
    // Deliberately no handler: settings is the requested visual placeholder.
    this.image('Setting_Btn', 'settings', this.node, l.settingsSize, [-w / 2 + l.settingsPosition[0], l.settingsPosition[1]]);
    const money = this.image('Money', 'currency_background', this.node, l.moneySize,
      [w / 2 + l.moneyPosition[0], l.moneyPosition[1]], p.currencyBackground, true);
    this.image('Image', 'money_icon', money, l.moneyIconSize, l.moneyIconPosition);
    this.moneyText = this.label('Price_txt', money, l.currencyFontSize, l.moneyTextPosition, l.moneyTextSize);
    const diamond = this.image('Dia', 'currency_background', this.node, l.diamondSize,
      [w / 2 + l.diamondPosition[0], l.diamondPosition[1]], p.currencyBackground, true);
    this.image('Image', 'diamond_icon', diamond, l.diamondIconSize, l.diamondIconPosition);
    this.diamondText = this.label('Price_txt', diamond, l.currencyFontSize, l.diamondTextPosition, l.diamondTextSize);
  }

  resize(width: number, height: number, topInset: number): void {
    const scale = width / this.assets.config.referenceWidth;
    this.node.setScale(scale, scale, 1);
    this.node.setPosition(0, height / 2 - topInset, 0);
  }

  update(state: BattleHudState): void {
    const { layout: l, palette: p, format } = this.assets.config;
    const wave = stageWaveIndex(state.waveIndex);
    if (wave !== this.lastWave) {
      this.stageFill.setRatio(wave / 4);
      this.cat.setPosition(l.dotPositions[wave] + l.catOffset[0], l.catOffset[1], 0);
      this.dots.forEach((dot, i) => { dot.color = color(i < wave ? p.stagePast : i === wave ? p.stageCurrent : p.stageFuture); });
      this.lastWave = wave;
    }
    const name = stageLabel(state.stageIndex, state.waveIndex);
    if (name !== this.lastStageLabel) { this.stageText.string = name; this.lastStageLabel = name; }
    const ratio = completionRatio(state.kills, state.totalTrees);
    this.progress.setRatio(ratio);
    this.timer.setRatio(timeRatio(state.remainingSeconds, state.durationSeconds));
    const percent = Math.floor(ratio * 100);
    if (percent !== this.lastPercent) { this.valueText.string = `${percent}%`; this.lastPercent = percent; }
    const money = formatGold(state.money, format.units, format.maxDisplayedDigits);
    if (money !== this.lastMoney) {
      this.moneyText.string = money; this.lastMoney = money;
    }
    if (state.diamonds !== this.lastDiamonds) {
      this.diamondText.string = formatDiamonds(state.diamonds); this.lastDiamonds = state.diamonds;
    }
    const hatchOffset = Math.floor((Math.max(0, state.elapsed) % 1) * 100) - 100;
    if (ratio > 0 && hatchOffset !== this.lastHatchOffset) {
      this.hatch.setPosition(hatchOffset, 0, 0); this.lastHatchOffset = hatchOffset;
    }
  }

  destroy(): void {
    if (!this.node.isValid) return;
    this.node.active = false; this.node.removeFromParent(); this.node.destroy();
  }

  private image(name: string, key: HudImageName, parent: Node, size: Pair, position: Pair,
    tint?: HudColor, sliced = false): Node {
    const node = this.art.image(name, this.assets.config.images[key], parent);
    node.getComponent(UITransform)!.setContentSize(size[0], size[1]);
    node.setPosition(position[0], position[1], 0);
    const sprite = node.getComponent(Sprite)!;
    if (sliced) sprite.type = Sprite.Type.SLICED;
    if (tint) sprite.color = color(tint);
    return node;
  }

  private fill(name: string, parent: Node, key: HudImageName, size: Pair, tint: HudColor): ClippedFill {
    const clip = makeNode(name, parent);
    const transform = clip.getComponent(UITransform)!;
    transform.setAnchorPoint(0, .5); transform.setContentSize(size[0], size[1]);
    clip.setPosition(-size[0] / 2, 0, 0);
    clip.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;
    this.image('Fill', key, clip, size, [size[0] / 2, 0], tint, true);
    return new ClippedFill(clip, size[0], size[1]);
  }

  private label(name: string, parent: Node, size: number, position: Pair, bounds: Pair): Label {
    const node = makeNode(name, parent); node.setPosition(position[0], position[1], 0);
    const label = node.addComponent(Label);
    label.font = this.assets.font; label.useSystemFont = false;
    label.fontSize = size; label.lineHeight = size * 1.25; label.color = Color.WHITE;
    label.horizontalAlign = Label.HorizontalAlign.CENTER; label.verticalAlign = Label.VerticalAlign.CENTER;
    label.overflow = Label.Overflow.SHRINK; label.enableWrapText = false;
    label.enableOutline = true; label.outlineColor = color(this.assets.config.font.outlineColor);
    label.outlineWidth = this.assets.config.font.outlineWidth;
    label.enableShadow = true; label.shadowColor = color(this.assets.config.font.shadowColor);
    label.shadowOffset = new Vec2(...this.assets.config.font.shadowOffset); label.shadowBlur = 0;
    // Attaching Label autosizes its default text before overflow is configured.
    // Restore source bounds last; otherwise every label retains 102.4px width
    // and SHRINK silently reduces the 37px stage title to 18px.
    node.getComponent(UITransform)!.setContentSize(bounds[0], bounds[1]);
    return label;
  }
}

/** Clips a nine-sliced original image without squeezing its rounded ends. */
class ClippedFill {
  private lastWidth = -1;
  constructor(readonly clip: Node, private readonly width: number, private readonly height: number) {}
  setRatio(ratio: number): void {
    const width = Math.round(this.width * ratio * 100) / 100;
    if (width === this.lastWidth) return;
    this.clip.active = width > 0;
    if (width > 0) this.clip.getComponent(UITransform)!.setContentSize(width, this.height);
    this.lastWidth = width;
  }
}
function color(value: HudColor): Color { return new Color(...value); }
// The existing Chinese result card is independent from the restored ASCII HUD.
function resultText(parent: Node, value: string, size: number, x: number, y: number, tint: Color): Label {
  const node = makeNode(value || 'Stats', parent); node.setPosition(x, y, 0);
  const label = node.addComponent(Label); label.string = value; label.fontSize = size; label.lineHeight = size * 1.25;
  label.fontFamily = 'sans-serif'; label.isBold = true; label.color = tint; label.overflow = Label.Overflow.NONE;
  return label;
}
function box(node: Node, w: number, h: number, radius: number, fill: Color, stroke?: Color, line = 0): void {
  node.getComponent(UITransform)!.setContentSize(w, h);
  const graphics = node.addComponent(Graphics);
  graphics.fillColor = fill; graphics.roundRect(-w / 2, -h / 2, w, h, radius); graphics.fill();
  if (stroke && line) { graphics.strokeColor = stroke; graphics.lineWidth = line; graphics.stroke(); }
}
