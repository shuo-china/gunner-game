import { Color, EventTouch, Graphics, Label, Mask, Node, Sprite, UITransform, Vec2 } from 'cc';
import type { BattleHudState } from '../session/BattleSession';
import type { UpgradeType } from '../session/UpgradeEconomy';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { completionRatio, formatDiamonds, formatGold, stageLabel, stageWaveIndex, timeRatio, usesStageHud } from './HudMath';
import type { HudColor, HudImageName, OriginalHudAssets } from './OriginalHudAssets';
import { UpgradeHud } from './UpgradeHud';
import { OriginalStageTransition } from './OriginalStageTransition';
import type { OriginalSfx } from './OriginalSfx';
import { FloatingJoystick } from './FloatingJoystick';
import { attachFontPolicyLabel } from './FontPolicyLabel';
import type { FontPolicyLabelOptions } from './FontPolicyLabel';
import type { MovementInputHandler } from './FloatingJoystick';

type Pair = [number, number];
/** Original Main_UI overlays stay below its HUD bars; session owns progression. */
export class GameHud {
  readonly node: Node;
  private stage?: StageHud;
  private upgrades?: UpgradeHud;
  private readonly transition: OriginalStageTransition;
  private readonly joystick?: FloatingJoystick;
  private width = 720;
  private height = 1280;
  private topInset = 0;
  private bottomInset = 0;
  private destroyed = false;
  private modalOpen = false;
  private loadingElapsed: number | null = null;

  constructor(parent: Node, private readonly art: ArtLibrary, private readonly assets: OriginalHudAssets,
    _onRestart: () => void, private readonly onUpgrade: (type: UpgradeType) => boolean = () => false,
    sfx?: Pick<OriginalSfx, 'play'>, private readonly onSettings: () => void = () => {}, onMovement?: MovementInputHandler) {
    this.node = makeNode('BattleHud', parent);
    this.transition = new OriginalStageTransition(this.node, art, assets.stageTransition, sfx);
    // Build asset-heavy overlays before registering joystick's global listeners.
    // A failed overlay constructor is cleaned up by Bootstrap's owned HUD root.
    if (onMovement) {
      this.joystick = new FloatingJoystick(this.node, art, assets.config, onMovement);
      this.joystick.node.setSiblingIndex(0);
    }
    this.resize(this.width, this.height);
  }

  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    if (this.destroyed) return;
    this.width = width; this.height = height; this.topInset = topInset; this.bottomInset = bottomInset;
    this.joystick?.resize(width, height, topInset, bottomInset);
    this.stage?.resize(width, height, topInset);
    this.upgrades?.resize(width, height, bottomInset);
    this.transition.resize(width, height, topInset, bottomInset);
  }

  update(state: BattleHudState, dt = 0): void {
    if (this.destroyed) return;
    const covered = state.mode === 'Main' && (state.phase === 'loading' || state.phase === 'reveal' || !!state.stageTransition || !!state.stageSkip);
    this.joystick?.setEnabled(!this.modalOpen && !state.paused && this.loadingElapsed === null && !covered &&
      ['Main', 'SpeedRun', 'Raid', 'Boss', 'Monster', 'Mine'].includes(state.mode));
    if (usesStageHud(state.mode)) {
      if (!this.stage) {
        this.stage = new StageHud(this.node, this.art, this.assets, this.onSettings);
        this.stage.node.setSiblingIndex(this.joystick ? 2 : 1);
        this.stage.resize(this.width, this.height, this.topInset);
      }
      this.stage.setSettingsBlocked(this.modalOpen || state.paused || this.loadingElapsed !== null);
      this.stage.update(state, dt);
    } else if (this.stage) {
      this.stage.destroy(); this.stage = undefined;
    }
    if (state.mode === 'Main' || state.mode === 'SpeedRun' || state.mode === 'Mine') {
      if (!this.upgrades) {
        this.upgrades = new UpgradeHud(this.node, this.art, this.assets, this.onUpgrade);
        this.upgrades.node.setSiblingIndex(this.joystick ? 3 : 2);
        this.upgrades.resize(this.width, this.height, this.bottomInset);
      }
      this.upgrades.update(this.modalOpen ? { ...state, paused: true } : state, dt);
    } else {
      this.upgrades?.destroy(); this.upgrades = undefined;
    }
    this.transition.update(state, dt);
    if (this.loadingElapsed !== null) {
      this.transition.showExternalLoading(this.loadingElapsed);
      this.transition.node.setSiblingIndex(this.node.children.length - 1);
    }
  }

  /** Mode transitions share the original global Loading canvas, above menus. */
  setLoadingOverlay(elapsed: number | null): void {
    if (this.destroyed) return;
    const wasVisible = this.loadingElapsed !== null;
    this.loadingElapsed = elapsed;
    if (elapsed !== null) this.joystick?.setEnabled(false);
    if ((elapsed !== null) !== wasVisible && this.node.parent) {
      this.node.setSiblingIndex(elapsed === null ? 0 : this.node.parent.children.length - 1);
      if (elapsed === null) this.transition.node.setSiblingIndex(this.joystick ? 1 : 0);
    }
  }

  cancelInteractions(): void { this.joystick?.cancelInteractions(); this.upgrades?.cancelInteractions(); this.stage?.cancelInteractions(); }

  getTutorialUpgradeTarget(): Node | null {
    return this.destroyed || this.modalOpen || this.loadingElapsed !== null ? null : this.upgrades?.getTutorialPowerTarget() ?? null;
  }

  /** The original diamond attraction switches back here when a currency panel closes. */
  getDiamondTarget(): Node | null {
    return this.destroyed || this.loadingElapsed !== null ? null : this.stage?.diamondTarget ?? null;
  }

  setModalOpen(open: boolean): void {
    this.modalOpen = open;
    if (open) this.joystick?.setEnabled(false);
    this.stage?.setSettingsBlocked(open || this.loadingElapsed !== null);
    if (open) this.cancelInteractions();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.joystick?.destroy();
    this.stage?.destroy(); this.stage = undefined;
    this.upgrades?.destroy(); this.upgrades = undefined;
    this.transition.destroy();
    if (this.node.isValid) { this.node.active = false; this.node.destroy(); }
  }
}

/** Source geometry stays in the original 1080-wide Canvas coordinates. */
class StageHud {
  private readonly textViews: ReturnType<typeof attachFontPolicyLabel>[] = [];
  readonly node: Node;
  private readonly progress: ClippedFill;
  private readonly timer: ClippedFill;
  private readonly stageFill: ClippedFill;
  private readonly stageText: Label;
  private readonly valueText: Label;
  private readonly moneyText: Label;
  private readonly diamondText: Label;
  readonly diamondTarget: Node;
  private readonly dots: Sprite[] = [];
  private readonly cat: Node;
  private readonly hatch: Node;
  private lastWave = -1;
  private lastStageLabel = '';
  private lastPercent = -1;
  private lastMoney = '';
  private lastDiamonds = NaN;
  private lastHatchOffset = NaN;
  private readonly settings: Node;
  private settingsBlocked = false;
  private settingsTouch: number | null = null;
  private settingsScale = 1;
  private settingsFrom = 1;
  private settingsTarget = 1;
  private settingsElapsed = .1;
  private settingsTint = 255;
  private settingsTintFrom = 255;
  private settingsTintTarget = 255;

  constructor(parent: Node, private readonly art: ArtLibrary, private readonly assets: OriginalHudAssets, onSettings: () => void) {
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
    this.settings = this.image('Setting_Btn', 'settings', this.node, l.settingsSize, [-w / 2 + l.settingsPosition[0], l.settingsPosition[1]]);
    const inside = (event: EventTouch): boolean => this.settings.getComponent(UITransform)!.hitTest(event.getLocation());
    this.settings.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
      event.propagationStopped = true;
      if (this.settingsBlocked || this.settingsTouch !== null || !inside(event)) return;
      this.settingsTouch = event.getID() ?? -1; this.animateSettings(.9);
    });
    const finish = (event: EventTouch, click: boolean): void => {
      event.propagationStopped = true;
      if (this.settingsTouch !== (event.getID() ?? -1)) return;
      this.settingsTouch = null; this.animateSettings(1);
      if (click && !this.settingsBlocked && inside(event)) onSettings();
    };
    this.settings.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
    this.settings.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event, false));
    const money = this.image('Money', 'currency_background', this.node, l.moneySize,
      [w / 2 + l.moneyPosition[0], l.moneyPosition[1]], p.currencyBackground, true);
    this.image('Image', 'money_icon', money, l.moneyIconSize, l.moneyIconPosition);
    this.moneyText = this.currencyLabel(money, l.moneyTextPosition, l.moneyTextSize, l.moneyIconPosition, l.moneyIconSize, l.moneySize);
    const diamond = this.image('Dia', 'currency_background', this.node, l.diamondSize,
      [w / 2 + l.diamondPosition[0], l.diamondPosition[1]], p.currencyBackground, true);
    this.diamondTarget = this.image('Image', 'diamond_icon', diamond, l.diamondIconSize, l.diamondIconPosition);
    this.diamondText = this.currencyLabel(diamond, l.diamondTextPosition, l.diamondTextSize, l.diamondIconPosition, l.diamondIconSize, l.diamondSize);
  }

  resize(width: number, height: number, topInset: number): void {
    const scale = width / this.assets.config.referenceWidth;
    this.node.setScale(scale, scale, 1);
    this.node.setPosition(0, height / 2 - topInset, 0);
  }

  setSettingsBlocked(blocked: boolean): void {
    this.settingsBlocked = blocked;
    if (blocked) this.cancelInteractions();
  }

  cancelInteractions(): void {
    this.settingsTouch = null; this.settingsScale = this.settingsFrom = this.settingsTarget = 1;
    this.settingsElapsed = .1; this.settings.setScale(1, 1, 1);
    this.settingsTint = this.settingsTintFrom = this.settingsTintTarget = 255;
    this.settings.getComponent(Sprite)!.color = new Color(255, 255, 255, 255);
  }

  private animateSettings(target: number): void {
    this.settingsFrom = this.settingsScale; this.settingsTarget = target; this.settingsElapsed = 0;
    this.settingsTintFrom = this.settingsTint;
    // Original Setting_Btn uses a .1s ColorTint alongside its BounceBtn.
    this.settingsTintTarget = target < 1 ? 200 : 245;
  }

  update(state: BattleHudState, dt = 0): void {
    this.settingsElapsed = Math.min(.1, this.settingsElapsed + (Number.isFinite(dt) ? Math.max(0, dt) : 0));
    this.settingsScale = this.settingsFrom + (this.settingsTarget - this.settingsFrom) * this.settingsElapsed / .1;
    this.settings.setScale(this.settingsScale, this.settingsScale, 1);
    this.settingsTint = this.settingsTintFrom + (this.settingsTintTarget - this.settingsTintFrom) * this.settingsElapsed / .1;
    const settingTone = Math.round(this.settingsTint);
    this.settings.getComponent(Sprite)!.color = new Color(settingTone, settingTone, settingTone, 255);
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
    this.textViews.forEach(view => view.sync());
  }

  destroy(): void {
    if (!this.node.isValid) return;
    this.textViews.forEach(view => view.destroy());
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

  private currencyLabel(parent: Node, position: Pair, bounds: Pair, iconPosition: Pair, iconSize: Pair, backgroundSize: Pair): Label {
    // The original text rect overlaps its icon. Keep a small gap on that side
    // and an inset from the rounded border, including the baked glyph effects.
    const left = Math.max(position[0] - bounds[0] / 2, iconPosition[0] + iconSize[0] / 2 + 4);
    const right = Math.min(position[0] + bounds[0] / 2, backgroundSize[0] / 2 - 8);
    return this.label('Price_txt', parent, this.assets.config.layout.currencyFontSize,
      [(left + right) / 2, position[1]], [right - left, bounds[1]], { fitGlyphBounds: true, characterSpacing: 9 });
  }

  private label(name: string, parent: Node, size: number, position: Pair, bounds: Pair, options: FontPolicyLabelOptions = {}): Label {
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
    this.textViews.push(attachFontPolicyLabel(label, this.art, this.assets.config.bitmapFont, options));
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
function box(node: Node, w: number, h: number, radius: number, fill: Color, stroke?: Color, line = 0): void {
  node.getComponent(UITransform)!.setContentSize(w, h);
  const graphics = node.addComponent(Graphics);
  graphics.fillColor = fill; graphics.roundRect(-w / 2, -h / 2, w, h, radius); graphics.fill();
  if (stroke && line) { graphics.strokeColor = stroke; graphics.lineWidth = line; graphics.stroke(); }
}
