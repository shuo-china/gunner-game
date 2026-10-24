import { initialUiLayout, uiPreparationPhase } from './OriginalWeaponUi';
import type { UiPreparation } from './OriginalWeaponUi';
import { BlockInputEvents, Color, EditBox, EventTouch, Font, Label, LabelOutline, Mask, Node, UITransform, Vec3 } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalWeaponUi } from './OriginalWeaponUi';
import type { OriginalUiNode, WeaponHudAssets, WeaponUiConfig } from './OriginalWeaponUi';
import { OriginalWeaponFeedback, visibleInHierarchy } from './OriginalWeaponFeedback';
import { loadResourceBatch } from './ResourceBatch';
import { SKIN_PRESENT_LAYER, SkinHudColorPipeline } from './SkinHudColorPipeline';
import type { SkinHudPresentation } from './SkinHudColorPipeline';
import type { RedeemCodeResult } from '../session/BattleSession';
import { attachFontPolicyLabel } from './FontPolicyLabel';
import type { OriginalBitmapFont } from './OriginalBitmapText';

interface ButtonColors {
  target: string; transition: number; normal: number[]; disabled: number[]; highlighted: number[];
  pressed: number[]; selected: number[]; colorMultiplier: number; fadeDuration: number; interactable: boolean;
}
type SettingsNode = OriginalUiNode & { buttonColors?: ButtonColors };
interface ButtonTint { spec: SettingsNode; current: number[]; from: number[]; to: number[]; elapsed: number; duration: number; rendered?: number[]; }
export interface SettingsState { bgmEnabled: boolean; soundEnabled: boolean; }
export interface SettingsUiConfig extends WeaponUiConfig {
  nodes: Record<string, SettingsNode>;
  settingsUi: Record<string, string>;
  input: {
    maxLength: number; singleLine: boolean; clearOnOpen: boolean; submitOnReturn: boolean;
    fontPath: string;
    bitmapFont: OriginalBitmapFont;
    fontSize: number; placeholderFontSize: number; textColor: number[]; placeholderColor: number[];
    textProfile: string; placeholderProfile: string; placeholder: string; invalidMessage: string;
    successMessage: string; alreadyUsedMessage: string; saveFailedMessage: string; walletLimitMessage: string;
  };
}
export interface SettingsHudAssets extends WeaponHudAssets { config: SettingsUiConfig; }
export interface SettingsHudCallbacks {
  getState(): SettingsState;
  toggleBgm(): void; toggleSound(): void;
  redeemCode(code: string): RedeemCodeResult | Promise<RedeemCodeResult>;
  onBeforeOpen?(): void; onVisibilityChanged?(visible: boolean): void;
  alert?(text: string): void; playSfx?(id: number): void;
}

export async function loadSettingsHudAssets(art: ArtLibrary): Promise<SettingsHudAssets> {
  const config = await art.json<SettingsUiConfig>('art/settings-system/config');
  if (config.version !== 1 || !config.roots.setting || !config.roots.redeem || !config.settingsUi ||
    config.input?.maxLength !== 16 || !config.input.singleLine || config.input.submitOnReturn) throw new Error('Invalid original settings UI');
  const paths = new Set(Object.values(config.images).map(image => image.path));
  for (const font of Object.values(config.bitmapFonts ?? {})) font.pages.forEach(path => paths.add(path));
  config.input.bitmapFont.pages.forEach(path => paths.add(path));
  await loadResourceBatch([
    ...Array.from(paths, path => () => art.loadFrame(path)),
  ]);
  const originalFont = new Font();
  return { config, chineseFont: null, originalFont, numberFont: originalFont };
}

/** Original Setting_UI and its nested Redeem_UI; settings never pause the battle. */
export class SettingsHud {
  readonly node: Node;
  readonly prepared: Promise<void>;
  private initialized = false;
  private readonly ui!: OriginalWeaponUi;
  private readonly colors?: SkinHudColorPipeline;
  private readonly roots = new Map<string, Node>();
  private readonly feedback = new OriginalWeaponFeedback(undefined, undefined, true);
  private readonly touches = new Map<Node, number>();
  private readonly graphics = new Map<Node, Node[]>();
  private readonly tints = new Map<Node, ButtonTint>();
  private readonly hovered = new Set<Node>();
  private readonly buttonScales = new Map<Node, number[]>();
  private input!: EditBox;
  private inputLabel!: Label;
  private placeholderLabel!: Label;
  private selected: Node | null = null;
  private entryBlocked = false;
  private lastVisible = false;
  private refreshKey = '';
  private inputVisualKey = '';
  private readonly textViews: ReturnType<typeof attachFontPolicyLabel>[] = [];
  private styledWebInput: HTMLInputElement | HTMLTextAreaElement | null = null;
  private webInputStyleKey = '';
  private destroyed = false;
  private redeemPending = false;

  constructor(parent: Node, art: ArtLibrary, private readonly assets: SettingsHudAssets,
    private readonly callbacks: SettingsHudCallbacks, presentation?: SkinHudPresentation, prepare?: UiPreparation) {
    this.node = makeNode('OriginalSettingsHud', parent);
    try {
      if (presentation) this.colors = new SkinHudColorPipeline(this.node, presentation);
      this.ui = new OriginalWeaponUi(art, assets, this.colors?.materials);
    } catch (error) {
      // A failed constructor never reaches Bootstrap's HUD field. Release sibling cameras,
      // director listeners and generated glyph frames here before the caller removes its root.
      this.colors?.destroy(); this.ui?.destroy(); this.node.destroy();
      this.textViews.forEach(view => view.destroy());
      throw error;
    }
    const initialize = function* (this: SettingsHud): Generator<void> {
      for (const name of ['setting', 'redeem']) {
        const root = yield* this.ui.createSteps(assets.config.roots[name], this.colors?.content ?? this.node);
        root.active = false; root.addComponent(BlockInputEvents); this.roots.set(name, root);
      }
      const ids = assets.config.settingsUi;
      for (const id of [ids.settingPanel, ids.redeemPanel]) this.ui.node(id).addComponent(BlockInputEvents);
      this.ui.show(ids.inputText, false); this.ui.show(ids.inputPlaceholder, false);
      const area = this.ui.node(ids.inputTextArea);
      this.inputLabel = this.makeInputLabel('RedeemText', area, false);
      this.placeholderLabel = this.makeInputLabel('RedeemPlaceholder', area, true);
      for (const label of [this.inputLabel, this.placeholderLabel]) {
        this.textViews.push(attachFontPolicyLabel(label, art, assets.config.input.bitmapFont,
          { spriteMaterial: this.colors?.materials.sprite, graphicsMaterial: this.colors?.materials.graphics,
            materialLayer: this.colors?.materials.layer }));
      }
      const inputNode = this.ui.node(ids.inputField);
      // EditBox's DOM positioning needs a live screen camera even while the linear cache camera sleeps.
      // Only this non-rendering host changes layer; its artwork and labels stay in the linear capture.
      if (this.colors) inputNode.layer = SKIN_PRESENT_LAYER;
      this.input = inputNode.addComponent(EditBox);
      this.input.textLabel = this.inputLabel; this.input.placeholderLabel = this.placeholderLabel;
      this.input.inputMode = EditBox.InputMode.SINGLE_LINE; this.input.inputFlag = EditBox.InputFlag.DEFAULT;
      this.input.returnType = EditBox.KeyboardReturnType.DONE; this.input.maxLength = assets.config.input.maxLength;
      this.input.placeholder = assets.config.input.placeholder; this.input.string = '';
      inputNode.on(EditBox.EventType.TEXT_CHANGED, () => this.syncInput());
      inputNode.on(EditBox.EventType.EDITING_DID_BEGAN, () => { this.syncInput(); this.colors?.invalidate(); });
      inputNode.on(EditBox.EventType.EDITING_DID_ENDED, () => { this.syncInput(); this.colors?.invalidate(); });
      // EDITING_RETURN deliberately has no redemption handler: only Redeem_Btn submits.
      for (const spec of Object.values(assets.config.nodes)) { this.bindButton(spec); yield; }
      yield* uiPreparationPhase(prepare, 'layout', this.resizeSteps(...initialUiLayout(prepare)));
      yield* uiPreparationPhase(prepare, 'initialRefresh', this.refreshSteps());
      this.syncInput();
      if (this.colors) yield* uiPreparationPhase(prepare, 'inputBinding', this.colors.bindInputSteps());
      this.colors?.setInvalidationSource(() => this.hasVisualChanges());
      this.initialized = true;
    };
    this.prepared = this.ui.prepare(this.node, parent, initialize.call(this), prepare, () => this.releasePreparation());
  }

  get isOpen(): boolean { return !this.destroyed && this.roots.get('setting')!.active; }
  get isRedeemOpen(): boolean { return this.isOpen && this.roots.get('redeem')!.active; }
  setEntryBlocked(blocked: boolean): void { this.entryBlocked = blocked; }

  open(): void {
    if (this.destroyed || this.isOpen || this.entryBlocked) return;
    this.callbacks.onBeforeOpen?.(); this.cancelInteractions();
    this.roots.get('setting')!.active = true; this.roots.get('redeem')!.active = false;
    this.colors?.setActive(true); this.update(0); this.notify();
  }
  close(): void {
    if (this.destroyed) return;
    this.cancelInteractions(); this.roots.get('redeem')!.active = false; this.roots.get('setting')!.active = false;
    this.colors?.setActive(false); this.notify();
  }
  openRedeem(): void {
    if (!this.isOpen || this.isRedeemOpen) return;
    this.cancelInteractions(); this.input.string = ''; this.roots.get('redeem')!.active = true;
    this.syncInput(); this.layoutInput(); this.colors?.invalidate();
  }
  closeRedeem(): void {
    if (!this.isRedeemOpen) return;
    this.cancelInteractions(); this.roots.get('redeem')!.active = false; this.colors?.invalidate();
  }
  submitRedeem(): void {
    if (!this.isRedeemOpen || this.redeemPending) return;
    this.input.blur(); this.syncInput();
    const code = this.input.string;
    this.setRedeemPending(true);
    try {
      const result = this.callbacks.redeemCode(code);
      if ('then' in result) {
        void result.then(value => this.finishRedeem(code, value), () => this.failRedeem());
      } else this.finishRedeem(code, result);
    } catch { this.failRedeem(); }
  }
  private setRedeemPending(value: boolean): void {
    this.redeemPending = value;
    if (this.destroyed) return;
    for (const [node, tint] of this.tints) {
      if (tint.spec.button?.some(action => action.method === 'Redeem')) this.setTint(node);
    }
    this.colors?.invalidate();
  }
  private failRedeem(): void {
    this.setRedeemPending(false);
    if (this.destroyed) return;
    this.callbacks.alert?.('兑换核验失败，请检查网络后重试。');
  }
  private finishRedeem(code: string, result: RedeemCodeResult): void {
    this.setRedeemPending(false);
    if (this.destroyed) return;
    const messages = this.assets.config.input;
    if (result.ok) {
      // Source Redeem_UI: shared reward alert, clear input, Purchase SFX; keep both panels open.
      this.callbacks.alert?.(messages.successMessage.replace(/\{0\}/g, String(result.diamonds)));
      // The user may have entered another code while server verification was pending.
      if (this.input.string === code) { this.input.string = ''; this.syncInput(); this.colors?.invalidate(); }
      this.callbacks.playSfx?.(7);
    } else {
      const failureMessages: Record<string, string> = { invalidCode: messages.invalidMessage, alreadyUsed: messages.alreadyUsedMessage,
        saveFailed: messages.saveFailedMessage, walletLimit: messages.walletLimitMessage };
      const message = result.message || failureMessages[result.reason] || '兑换核验失败，请检查网络后重试。';
      this.callbacks.alert?.(message);
    }
  }
  cancelInteractions(): void {
    if (this.destroyed) return;
    this.touches.clear(); this.feedback.clear(); this.hovered.clear(); this.selected = null;
    this.input?.blur();
    for (const node of this.tints.keys()) this.setTint(node, true);
    this.colors?.invalidate();
  }
  resizePrepared(prepare: UiPreparation, width: number, height: number, topInset = 0, bottomInset = 0): Promise<void> {
    return this.ui.prepare(this.node, this.node.parent!, this.resizeSteps(width, height, topInset, bottomInset), prepare, () => this.releasePreparation());
  }

  resize(width: number, height: number, topInset = 0, bottomInset = 0): void {
    for (const _ of this.resizeSteps(width, height, topInset, bottomInset)) { /* synchronous resize */ }
  }

  private *resizeSteps(width: number, height: number, topInset = 0, bottomInset = 0): Generator<void> {
    if (this.destroyed || !(width > 0) || !(height > topInset + bottomInset)) return;
    this.cancelInteractions();
    const scale = width / this.assets.config.referenceWidth, w = width / scale, h = (height - topInset - bottomInset) / scale;
    this.node.setScale(scale, scale, 1); this.node.setPosition(0, (bottomInset - topInset) / 2);
    this.node.getComponent(UITransform)!.setContentSize(w, h);
    for (const id of Object.values(this.assets.config.roots)) yield* this.ui.layoutSteps(id, w, h, topInset / scale, bottomInset / scale);
    this.layoutInput(); this.colors?.resize(width, height);
  }
  update(dt: number): void {
    if (this.destroyed) return;
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.feedback.update(elapsed); this.updateTints(elapsed);
    if (!this.isOpen) return;
    this.refresh(); this.syncInput(); this.layoutInput();
  }
  destroy(): void {
    if (this.destroyed) return;
    if (!this.initialized) {
      this.releasePreparation(); this.ui.destroy(); this.node.destroy(); return;
    }
    this.close(); this.destroyed = true; this.node.active = false;
    this.textViews.forEach(view => view.destroy());
    this.colors?.destroy(); this.node.destroy(); this.ui.destroy();
    this.graphics.clear(); this.tints.clear(); this.buttonScales.clear();
    this.styledWebInput = null;
  }
  /** Initialization owns resources before its modal roots and controllers exist. */
  private releasePreparation(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.node.active = false;
    this.colors?.destroy(); this.textViews.forEach(view => view.destroy());
  }


  private makeInputLabel(name: string, parent: Node, placeholder: boolean): Label {
    const spec = this.assets.config.input, node = makeNode(name, parent), label = node.addComponent(Label);
    // Native editing uses the platform input; the canvas display uses mixed
    // system text and the original Latin glyphs without loading a TTF.
    label.font = null; label.useSystemFont = true; label.fontFamily = 'sans-serif';
    label.isItalic = placeholder; // TMP placeholder sourceStyle=2; entered text is upright.
    label.string = placeholder ? spec.placeholder : ''; label.enableWrapText = false; label.overflow = Label.Overflow.CLAMP;
    label.horizontalAlign = Label.HorizontalAlign.CENTER; label.verticalAlign = Label.VerticalAlign.CENTER;
    const profile = this.assets.config.textProfiles?.[placeholder ? spec.placeholderProfile : spec.textProfile];
    label.fontSize = (placeholder ? spec.placeholderFontSize : spec.fontSize) * (profile?.scale ?? 1);
    label.lineHeight = label.fontSize * (profile ? (profile.ascent - profile.descent) / profile.pointSize : 1.14);
    const color = placeholder ? spec.placeholderColor : spec.textColor;
    label.color = new Color(color[0], color[1], color[2], color[3]);
    if (this.colors?.materials.sprite) label.customMaterial = this.colors.materials.sprite;
    if (!placeholder && profile) {
      const outline = node.addComponent(LabelOutline), c = profile.outlineColor;
      outline.color = new Color(c[0], c[1], c[2], c[3]);
      outline.width = (profile.faceDilate + profile.outlineWidth) * label.fontSize / profile.pointSize;
    }
    return label;
  }
  private layoutInput(): void {
    const area = this.ui.node(this.assets.config.settingsUi.inputTextArea).getComponent(UITransform)!;
    for (const label of [this.inputLabel, this.placeholderLabel]) {
      const tr = label.node.getComponent(UITransform)!;
      if (tr.width !== area.width || tr.height !== area.height) tr.setContentSize(area.width, area.height);
      if (tr.anchorX !== .5 || tr.anchorY !== .5) tr.setAnchorPoint(.5, .5);
      const at = label.node.position;
      if (at.x !== 0 || at.y !== 0) label.node.setPosition(0, 0, 0);
      label.verticalAlign = Label.VerticalAlign.CENTER;
    }
    this.textViews.forEach(view => view.sync());
  }
  private syncInput(): void {
    // Native single-line controls already enforce this; retain the same contract for programmatic input and pasted text.
    const normalized = this.input.string.replace(/[\r\n]/g, '').slice(0, this.assets.config.input.maxLength);
    if (this.input.string !== normalized) this.input.string = normalized;
    this.syncWebInputStyle();
    this.textViews.forEach(view => view.sync());
  }
  private syncWebInputStyle(): void {
    // Creator 3.8.8 replaces the canvas Label with this DOM control during editing.
    // Its Web implementation copies only the fill color and font, omitting LabelOutline.
    // Bridge only this instance's optional Web element; native and mini-game inputs have none.
    const element = (this.input._impl as unknown as {
      _edTxt?: HTMLInputElement | HTMLTextAreaElement | null;
    } | null)?._edTxt;
    if (!element?.style) return;
    const label = this.inputLabel, outline = label.node.getComponent(LabelOutline);
    const color = label.color.toCSS();
    const outlineColor = outline?.color.toCSS() ?? 'transparent';
    const outlineWidth = outline?.enabled !== false ? Math.max(0, outline?.width ?? 0) * 2 * label.node.scale.y : 0;
    const font = (label.font as (Font & { _fontFamily?: string }) | null)?._fontFamily || label.fontFamily;
    const properties: Record<string, string> = {
      color, '-webkit-text-fill-color': color, 'caret-color': color,
      '-webkit-text-stroke-color': outlineColor, '-webkit-text-stroke-width': `${outlineWidth}px`,
      // Canvas uses strokeText(width * 2), then fillText; retain that same outer contour.
      'paint-order': 'stroke fill', 'font-family': font, 'font-size': `${label.fontSize * label.node.scale.y}px`,
      'font-style': label.isItalic ? 'italic' : 'normal', 'font-weight': label.isBold ? 'bold' : 'normal',
    };
    const key = JSON.stringify(properties);
    if (element === this.styledWebInput && key === this.webInputStyleKey) return;
    this.styledWebInput = element; this.webInputStyleKey = key;
    for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value);
  }
  private refresh(): void {
    for (const _ of this.refreshSteps()) { /* synchronous state refresh */ }
  }
  private *refreshSteps(): Generator<void> {
    const state = this.callbacks.getState(), key = `${state.bgmEnabled}:${state.soundEnabled}`;
    if (key === this.refreshKey) return;
    this.refreshKey = key;
    const ids = this.assets.config.settingsUi;
    this.ui.show(ids.bgmOn, state.bgmEnabled); this.ui.show(ids.bgmOff, !state.bgmEnabled); yield;
    this.ui.show(ids.soundOn, state.soundEnabled); this.ui.show(ids.soundOff, !state.soundEnabled); yield;
    this.colors?.invalidate();
  }
  private front(node: Node): boolean {
    if (!this.isOpen) return false;
    const front = this.roots.get(this.isRedeemOpen ? 'redeem' : 'setting');
    for (let current: Node | null = node; current; current = current.parent) if (current === front) return true;
    return false;
  }
  private contains(node: Node, at: { x: number; y: number }): boolean {
    const inside = (target: Node): boolean => {
      const tr = target.getComponent(UITransform)!, p = tr.convertToNodeSpaceAR(new Vec3(at.x, at.y, 0));
      return p.x >= -tr.width * tr.anchorX && p.x <= tr.width * (1 - tr.anchorX) && p.y >= -tr.height * tr.anchorY && p.y <= tr.height * (1 - tr.anchorY);
    };
    for (let parent = node.parent; parent; parent = parent.parent) if (parent.getComponent(Mask) && !inside(parent)) return false;
    return (this.graphics.get(node) ?? []).some(graphic => visibleInHierarchy(graphic) && inside(graphic));
  }
  private bindButton(spec: SettingsNode): void {
    if (!spec.button) return;
    const node = this.ui.node(spec.id), graphics: Node[] = [];
    const collect = (entry: OriginalUiNode): void => {
      if (entry !== spec && entry.button) return;
      if ((entry.image && entry.image.raycast !== false) || (entry.text && entry.text.raycast !== false)) graphics.push(this.ui.node(entry.id));
      entry.children.forEach(id => collect(this.assets.config.nodes[id]));
    };
    collect(spec); this.graphics.set(node, graphics);
    if (spec.bounceButton) this.buttonScales.set(node, [NaN, NaN, NaN]);
    if (spec.buttonColors?.transition === 1) {
      const normal = spec.buttonColors.normal.slice(); this.tints.set(node, { spec, current: normal, from: normal, to: normal, elapsed: 0, duration: 0 });
    }
    const finish = (event: EventTouch, click: boolean): void => {
      event.propagationStopped = true;
      if (this.touches.get(node) !== (event.getID() ?? -1)) return;
      this.touches.delete(node); this.feedback.release(node); this.setTint(node);
      if (!click || !visibleInHierarchy(node) || !this.front(node) || !this.contains(node, event.getUILocation()) || !this.buttonEnabled(spec)) return;
      for (const action of spec.button!) this.invoke(action.method, action.target, action.arguments);
      if (spec.clickSound !== undefined) this.callbacks.playSfx?.(spec.clickSound);
      this.update(0);
    };
    for (const graphic of graphics) {
      graphic.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
        event.propagationStopped = true;
        if (!visibleInHierarchy(node) || !this.front(node) || this.touches.has(node) || !this.contains(node, event.getUILocation()) || !this.buttonEnabled(spec)) return;
        this.touches.set(node, event.getID() ?? -1); this.selected = node; this.feedback.press(node, spec); this.setTint(node);
      });
      graphic.on(Node.EventType.TOUCH_END, (event: EventTouch) => finish(event, true));
      // Cocos sends a synthetic cancel to the pressed text when release lands on
      // another graphic of the same button. Preserve a click only for that real release.
      graphic.on(Node.EventType.TOUCH_CANCEL, (event: EventTouch) => finish(event, event.getEventCode?.() === Node.EventType.TOUCH_END));
      graphic.on(Node.EventType.MOUSE_ENTER, () => { this.hovered.add(node); this.setTint(node); });
      graphic.on(Node.EventType.MOUSE_LEAVE, () => { this.hovered.delete(node); this.setTint(node); });
    }
  }
  private invoke(method: string, target: string, args: Record<string, unknown>): void {
    if (method === 'BGM_Setting_Change') this.callbacks.toggleBgm();
    else if (method === 'SFX_Setting_Change') this.callbacks.toggleSound();
    else if (method === 'Redeem') this.submitRedeem();
    else if (method === 'SetActive') {
      if (target === this.assets.config.roots.setting) this.close();
      else if (target === this.assets.config.roots.redeem) {
        if (args.m_BoolArgument) this.openRedeem(); else this.closeRedeem();
      }
    }
  }
  private setTint(node: Node, immediate = false): void {
    const state = this.tints.get(node), colors = state?.spec.buttonColors; if (!state || !colors) return;
    const to = !this.buttonEnabled(state.spec) ? colors.disabled : this.touches.has(node) ? colors.pressed : this.selected === node ? colors.selected : this.hovered.has(node) ? colors.highlighted : colors.normal;
    if (!immediate && state.to.every((value, i) => value === to[i])) return;
    if (immediate && !state.duration && state.current.every((value, i) => value === to[i])) return;
    state.from = state.current.slice(); state.to = to.slice(); state.elapsed = 0; state.duration = immediate ? 0 : colors.fadeDuration;
    if (!state.duration) { state.current = state.to.slice(); this.renderTint(state); }
  }
  private buttonEnabled(spec: SettingsNode): boolean {
    return spec.buttonColors?.interactable !== false && !(this.redeemPending && spec.button?.some(action => action.method === 'Redeem'));
  }
  private renderTint(state: ButtonTint): void {
    const colors = state.spec.buttonColors!, base = state.spec.image?.color ?? [255, 255, 255, 255];
    const tint = base.map((value, i) => Math.round(Math.min(255, value * state.current[i] * colors.colorMultiplier / 255)));
    if (state.rendered?.every((value, i) => value === tint[i])) return;
    state.rendered = tint; this.ui.tint(colors.target, tint);
    if (visibleInHierarchy(this.ui.node(colors.target))) this.colors?.invalidate();
  }
  private updateTints(dt: number): void {
    for (const [node, state] of this.tints) {
      if (!visibleInHierarchy(node)) { this.touches.delete(node); this.hovered.delete(node); if (this.selected === node) this.selected = null; this.setTint(node, true); }
      if (!state.duration) continue;
      state.elapsed += dt; const t = Math.min(1, state.elapsed / state.duration);
      state.current = state.from.map((value, i) => value + (state.to[i] - value) * t); this.renderTint(state);
      if (t === 1) state.duration = 0;
    }
  }
  private hasVisualChanges(): boolean {
    if (!this.isOpen) return false;
    let changed = false;
    for (const [node, previous] of this.buttonScales) {
      if (!visibleInHierarchy(node)) continue;
      const { x, y, z } = node.scale;
      if (previous[0] !== x || previous[1] !== y || previous[2] !== z) { previous[0] = x; previous[1] = y; previous[2] = z; changed = true; }
    }
    const inputKey = `${this.inputLabel.node.active}:${this.inputLabel.string}:${this.placeholderLabel.node.active}:${this.placeholderLabel.string}`;
    if (this.inputVisualKey !== inputKey) { this.inputVisualKey = inputKey; changed = true; }
    return changed;
  }
  private notify(): void {
    const value = this.isOpen;
    if (value !== this.lastVisible) { this.lastVisible = value; this.callbacks.onVisibilityChanged?.(value); }
  }
}
