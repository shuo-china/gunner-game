import { Camera, Canvas, Color, Director, director, EffectAsset, Material, Node, RenderTexture, screen, Sprite, SpriteFrame, Texture2D, UITransform, view } from 'cc';
import { makeNode } from './ArtLibrary';
import type { OriginalUiMaterials } from './OriginalWeaponUi';

export type SkinPresentationPhase = 'presentationAcquire' | 'presentationResize' | 'presentationRelease' | 'presentationBeforeDraw';
export interface SkinHudPresentation {
  camera: Camera; effects: EffectAsset[];
  /** CPU work only; observing a draw does not measure the GPU submission. */
  trace?: (phase: SkinPresentationPhase, workMs: number) => void;
}
// User layers 16-18; 19 belongs to the world pipeline, 20+ are engine layers.
export const SKIN_LINEAR_LAYER = 1 << 16;
export const SKIN_PRESENT_LAYER = 1 << 17;
export const SKIN_FOREGROUND_LAYER = 1 << 18;

interface PresentationLease {
  owner: SkinHudColorPipeline; generation: number;
  target: RenderTexture | null; visibility: number; orthoHeight: number;
  displayWindow: NonNullable<Camera['camera']>['window'];
}
interface PresentationPool {
  members: Set<SkinHudColorPipeline>; generation: number; lease?: PresentationLease;
  textures: RenderTexture[]; frames: SpriteFrame[];
}
const presentationPools = new WeakMap<Camera, PresentationPool>();
const presentationNow = (): number => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/** The scene owns the pool. The last view also releases it for standalone use. */
export function disposeSkinHudPresentation(camera: Camera): void {
  const pool = presentationPools.get(camera);
  if (!pool) return;
  for (const member of Array.from(pool.members)) member.destroy();
}

export function skinHudPresentationSnapshot(camera: Camera) {
  const pool = presentationPools.get(camera);
  return { owner: pool?.lease?.owner.content.parent?.name ?? null, generation: pool?.generation ?? 0,
    leases: pool?.lease ? 1 : 0, views: pool?.members.size ?? 0, textures: pool?.textures.length ?? 0,
    width: pool?.textures[0]?.width ?? 0, height: pool?.textures[0]?.height ?? 0 };
}

/** Cache source UI as premultiplied linear RGBA. The background stays live;
 * its sRGB capture is combined with the cached UI and encoded every frame. */
export class SkinHudColorPipeline {
  readonly content: Node;
  readonly materials: OriginalUiMaterials;
  private readonly pool: PresentationPool;
  private leaseGeneration = 0;
  private get textures(): RenderTexture[] { return this.pool.textures; }
  private get frames(): SpriteFrame[] { return this.pool.frames; }
  private readonly ownedMaterials: Material[] = [];
  private readonly cameraNodes: Node[] = [];
  private readonly cameras: Camera[] = [];
  private readonly quads: Node[] = [];
  private readonly foreground = new Map<Node, number>();
  private readonly foregroundRoots = new Set<Node>();
  private readonly inputTests = new Map<UITransform, UITransform['hitTest']>();
  private compositeMaterial?: Material;
  private invalidationSource?: () => boolean;
  private dirty = true;
  private invalidationRevision = 0;
  private drawingRevision = -1;
  private drawingGeneration = 0;
  private readonly geometry: number[] = [];
  private readonly screenAligned: boolean;
  private screenOrthoHeight = 1;
  private active = false;
  private destroyed = false;
  private width = 1;
  private height = 1;

  constructor(private readonly owner: Node, private readonly presentation: SkinHudPresentation) {
    const main = presentation.camera;
    const canvas = main.node.parent?.getComponent(Canvas);
    this.screenAligned = !!canvas?.alignCanvasWithScreen && canvas.cameraComponent === main;
    this.content = makeNode('OriginalLinearSkin', owner); this.content.layer = SKIN_LINEAR_LAYER; this.content.active = false;
    this.pool = presentationPools.get(main) ?? { members: new Set(), generation: 0, textures: [], frames: [] };
    presentationPools.set(main, this.pool); this.pool.members.add(this);
    try {
      const material = (effect: EffectAsset, defines?: Record<string, boolean>): Material => {
        const value = new Material(); this.ownedMaterials.push(value); value.initialize({ effectAsset: effect, defines }); return value;
      };
      this.materials = { sprite: material(presentation.effects[0]), graphics: material(presentation.effects[1]), layer: SKIN_LINEAR_LAYER };
      const composite = this.compositeMaterial = material(presentation.effects[2], { SAMPLE_FROM_RT: true });
      const quad = (name: string, parent: Node, layer: number, effect: Material): void => {
        const node = makeNode(name, parent); this.quads.push(node); node.layer = layer;
        const sprite = node.addComponent(Sprite); sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        sprite.customMaterial = effect;
      };
      // Keep the output in the feature's original place in the UI hierarchy.
      quad('OriginalSkinPresentation', owner, SKIN_PRESENT_LAYER, composite);
      for (let i = 0; i < 2; i++) {
        const node = new Node(i ? 'OriginalSkinPresentationCamera' : 'OriginalSkinLinearCamera');
        this.cameraNodes.push(node); main.node.parent!.addChild(node);
        const camera = node.addComponent(Camera); this.cameras.push(camera);
        camera.projection = Camera.ProjectionType.ORTHO; camera.priority = main.priority + i + 1;
        camera.rect = main.rect;
        camera.visibility = i ? SKIN_PRESENT_LAYER | SKIN_FOREGROUND_LAYER : SKIN_LINEAR_LAYER;
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR; camera.clearColor = new Color(0, 0, 0, i ? 255 : 0);
        camera.near = main.near; camera.far = main.far;
        camera.targetTexture = null; node.active = false;
      }
      this.quads[0].active = false;
      director.on(Director.EVENT_BEFORE_DRAW, this.beforeDraw, this);
      director.on(Director.EVENT_AFTER_DRAW, this.finishDraw, this);
    } catch (error) { this.destroy(); throw error; }
  }

  invalidate(): void { this.dirty = true; this.invalidationRevision++; }

  /** Sample after normal component/ScrollView updates, immediately before draw. */
  setInvalidationSource(source: () => boolean): void { this.invalidationSource = source; this.invalidate(); }

  setActive(value: boolean): void {
    if (this.destroyed || value === this.active) return;
    const started = presentationNow(), main = this.presentation.camera;
    try {
      if (!value) { this.releaseLease(); return; }
      // A late open cannot leave the previous view drawing into the same pair.
      // Release restores the real camera before we capture the next baseline.
      this.pool.lease?.owner.setActive(false);
      const lease: PresentationLease = { owner: this, generation: ++this.pool.generation,
        target: main.targetTexture, visibility: main.visibility, orthoHeight: main.orthoHeight,
        displayWindow: main.camera?.window ?? null };
      this.pool.lease = lease; this.leaseGeneration = lease.generation;
      this.screenOrthoHeight = lease.orthoHeight;
      try {
        this.resizeTargets();
        this.active = true;
        this.bindTargets();
        main.visibility = lease.visibility & ~(SKIN_LINEAR_LAYER | SKIN_PRESENT_LAYER | SKIN_FOREGROUND_LAYER);
        main.targetTexture = this.textures[0]; main.orthoHeight = this.screenOrthoHeight;
        this.content.active = true;
        this.cameraNodes.forEach(node => { node.active = true; }); this.quads[0].active = true;
        // The clear camera must run once even if this owner was clean when it closed.
        this.drawingRevision = -1; this.drawingGeneration = 0; this.invalidate(); this.sync();
      } catch (error) { this.releaseLease(); throw error; }
    } finally { this.trace(value ? 'presentationAcquire' : 'presentationRelease', started); }
  }

  resize(width: number, height: number): void {
    if (this.destroyed) return;
    this.width = width; this.height = height;
    this.invalidate();
    // Preparing a hidden view must neither allocate full-screen targets nor
    // capture the camera while another view has temporarily redirected it.
    if (!this.ownsLease() || !this.active) return;
    this.resizeTargets(); this.syncGeometry();
  }

  private ownsLease(): boolean {
    const lease = this.pool.lease;
    return lease?.owner === this && lease.generation === this.leaseGeneration;
  }

  private trace(phase: SkinPresentationPhase, started: number): void {
    try { this.presentation.trace?.(phase, Math.max(0, presentationNow() - started)); } catch { /* Diagnostics cannot alter rendering. */ }
  }

  private releaseLease(): void {
    this.active = false;
    this.content.active = false;
    this.cameraNodes.forEach(node => { if (node.isValid) node.active = false; });
    if (this.quads[0]?.isValid) this.quads[0].active = false;
    for (const camera of this.cameras) if (camera.isValid) camera.targetTexture = null;
    this.restoreForeground();
    if (this.ownsLease()) {
      const main = this.presentation.camera, lease = this.pool.lease!;
      if (main.isValid) { main.targetTexture = lease.target; main.visibility = lease.visibility; main.orthoHeight = lease.orthoHeight; }
      this.pool.lease = undefined;
    }
    this.leaseGeneration = 0; this.invalidate();
  }

  private bindTargets(): void {
    if (this.textures.length !== 2) return;
    this.quads[0].getComponent(Sprite)!.spriteFrame = this.frames[1];
    this.compositeMaterial!.setProperty('backgroundTexture', this.textures[0]);
    if (this.ownsLease() && this.active) {
      this.cameras[0].targetTexture = this.textures[1];
      this.cameras[1].targetTexture = this.pool.lease!.target;
      this.presentation.camera.targetTexture = this.textures[0];
      this.presentation.camera.orthoHeight = this.screenOrthoHeight;
    }
  }

  private resizeTargets(): void {
    if (!this.ownsLease()) return;
    // WeChat's reported window size can differ from the actual game surface.
    // Matching the original render window keeps both RT projections and the
    // final swapchain projection at exactly the same aspect ratio.
    const pixels = this.pool.lease!.displayWindow ?? screen.windowSize;
    const maxTexture = director.root?.device.capabilities.maxTextureSize || Math.max(pixels.width, pixels.height);
    const scale = Math.min(1, maxTexture / Math.max(pixels.width, pixels.height));
    const w = Math.max(1, Math.floor(pixels.width * scale)), h = Math.max(1, Math.floor(pixels.height * scale));
    if (this.textures.length === 2 && this.textures.every(texture => texture.width === w && texture.height === h)) return;
    const started = presentationNow();
    const replacements: { texture: RenderTexture; frame: SpriteFrame }[] = [];
    try {
      for (const name of ['OriginalSkinBackground', 'OriginalSkinLinear']) {
        // Creator 3.8's resize independently clamps each dimension to 2048.
        // Reinitializing an asset keeps its descriptor cache key even though
        // its GFX texture is destroyed. A new asset gives both samplers fresh keys.
        const replacement = new RenderTexture(), frame = new SpriteFrame();
        replacements.push({ texture: replacement, frame });
        replacement.initialize({ name, width: w, height: h });
        replacement.setWrapMode(Texture2D.WrapMode.CLAMP_TO_EDGE, Texture2D.WrapMode.CLAMP_TO_EDGE);
        frame.reset({ texture: replacement }, true);
      }
    } catch (error) {
      replacements.forEach(({ texture, frame }) => { frame.destroy(); texture.destroy(); });
      this.trace('presentationResize', started);
      throw error;
    }
    const oldTextures = this.textures, oldFrames = this.frames;
    this.pool.textures = replacements.map(item => item.texture); this.pool.frames = replacements.map(item => item.frame);
    for (const member of this.pool.members) { member.bindTargets(); member.invalidate(); }
    // Release old targets only after cameras and both samplers use replacements.
    oldFrames.forEach(frame => frame.destroy()); oldTextures.forEach(texture => texture.destroy());
    this.trace('presentationResize', started);
  }

  /** Creator skips render-texture cameras in UITransform.hitTest. Use the final
   * screen camera for that synchronous query while retaining the engine's own
   * world transform, window and ancestor-Mask checks. Only the query's layer is
   * borrowed; rendering, pointer capture and ScrollView remain unchanged. */
  bindInput(): void {
    for (const _ of this.bindInputSteps()) { /* Synchronous standalone views. */ }
  }

  *bindInputSteps(): Generator<void> {
    const pending = [this.content];
    while (pending.length && !this.destroyed) {
      const node = pending.pop()!;
      if (!node.isValid) continue;
      const transform = node.getComponent(UITransform);
      if (transform && !this.inputTests.has(transform) && !this.quads.includes(node)) {
        const original = transform.hitTest; this.inputTests.set(transform, original);
        transform.hitTest = (point, windowId): boolean => {
          if (!this.active || this.destroyed || !this.ownsLease()) return false;
          const layer = node.layer;
          node.layer = SKIN_PRESENT_LAYER;
          try { return original.call(transform, point, windowId); }
          finally { node.layer = layer; }
        };
      }
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
      yield;
    }
  }

  private syncGeometry(): void {
    const main = this.presentation.camera;
    // Match Canvas's screen projection directly. Its RectTransform can update a
    // frame after canvas-resize, so scaling a cached ortho by layout-height
    // deltas would apply the same viewport change twice.
    if (this.screenAligned) this.screenOrthoHeight = screen.windowSize.height / view.getScaleY() / 2;
    if (this.ownsLease()) this.pool.lease!.orthoHeight = this.screenOrthoHeight;
    if (this.active && main.orthoHeight !== this.screenOrthoHeight) main.orthoHeight = this.screenOrthoHeight;
    const position = main.node.worldPosition, rotation = main.node.worldRotation, scale = this.owner.worldScale;
    const ownerPosition = this.owner.worldPosition, rect = main.rect;
    const values = [this.width, this.height, this.screenOrthoHeight, position.x, position.y, position.z,
      rotation.x, rotation.y, rotation.z, rotation.w, scale.x, scale.y, ownerPosition.x, ownerPosition.y, ownerPosition.z,
      rect.x, rect.y, rect.width, rect.height];
    if (values.length === this.geometry.length && values.every((value, i) => value === this.geometry[i])) return;
    this.geometry.length = 0; this.geometry.push(...values); this.invalidate();
    for (const camera of this.cameras) {
      camera.orthoHeight = this.screenOrthoHeight;
      camera.rect = main.rect;
      camera.node.setWorldPosition(position); camera.node.setWorldRotation(rotation);
    }
    for (const quad of this.quads) {
      quad.getComponent(UITransform)!.setContentSize(this.width, this.height);
      quad.setScale(1 / this.owner.worldScale.x, 1 / this.owner.worldScale.y, 1);
      quad.setWorldPosition(main.node.worldPosition.x, main.node.worldPosition.y, this.owner.worldPosition.z);
    }
  }

  private beforeDraw(): void { this.sync(true); }

  private sync(frameDraw = false): void {
    if (!this.active || this.destroyed || !this.ownsLease()) return;
    const started = presentationNow();
    this.syncGeometry();
    if (this.invalidationSource?.()) this.invalidate();
    this.cameraNodes[0].active = this.dirty;
    if (this.dirty && frameDraw) { this.drawingRevision = this.invalidationRevision; this.drawingGeneration = this.leaseGeneration; }
    // Alerts, tutorial and loading may move above the feature during update.
    // Present those later siblings after the encoded skin, never in its backdrop.
    const roots = new Set<Node>(), seen = new Set<Node>();
    const visit = (node: Node): void => { seen.add(node); node.children.forEach(visit); };
    const promote = (node: Node, inherited?: number): void => {
      if (!this.foreground.has(node)) this.foreground.set(node,
        node.layer === SKIN_FOREGROUND_LAYER && inherited !== undefined ? inherited : node.layer);
      const original = this.foreground.get(node)!;
      if (node.layer !== SKIN_FOREGROUND_LAYER) node.layer = SKIN_FOREGROUND_LAYER;
      node.children.forEach(child => promote(child, original));
    };
    for (let branch: Node | null = this.owner; branch?.parent; branch = branch.parent) {
      const siblings = branch.parent.children, index = siblings.indexOf(branch);
      for (const sibling of siblings.slice(index + 1)) {
        if (this.cameraNodes.includes(sibling)) continue;
        roots.add(sibling); visit(sibling);
      }
      if (branch.parent === this.presentation.camera.node.parent) break;
    }
    // Restore only nodes which actually left the foreground. Unchanged nodes
    // must not change layer twice per frame and dirty their render data.
    const restoreAbsent = (node: Node, inherited?: number): void => {
      if (!node.isValid || seen.has(node)) return;
      const original = this.foreground.get(node) ?? (node.layer === SKIN_FOREGROUND_LAYER ? inherited : node.layer);
      if (original !== undefined && node.layer !== original) node.layer = original;
      this.foreground.delete(node); node.children.forEach(child => restoreAbsent(child, original));
    };
    for (const root of this.foregroundRoots) restoreAbsent(root);
    // A pooled alert glyph can be reparented out of its old root between
    // frames. Visit tracked nodes too; the old tree no longer reaches it.
    for (const [node, original] of this.foreground) {
      if (!node.isValid) this.foreground.delete(node);
      else if (!seen.has(node)) restoreAbsent(node, original);
    }
    this.foregroundRoots.clear();
    for (const root of roots) { this.foregroundRoots.add(root); promote(root); }
    if (this.dirty && frameDraw) this.trace('presentationBeforeDraw', started);
  }

  private finishDraw(): void {
    if (!this.active || this.destroyed || !this.ownsLease()) return;
    if (this.cameraNodes[0].active && this.drawingGeneration === this.leaseGeneration && this.drawingRevision === this.invalidationRevision) this.dirty = false;
    this.cameraNodes[0].active = false;
  }

  private restoreForeground(): void {
    const restore = (node: Node, inherited?: number): void => {
      if (!node.isValid) return;
      const layer = this.foreground.get(node) ?? (node.layer === SKIN_FOREGROUND_LAYER ? inherited : node.layer);
      if (layer !== undefined) node.layer = layer;
      node.children.forEach(child => restore(child, layer));
    };
    for (const root of this.foregroundRoots) restore(root);
    for (const [node, original] of this.foreground) restore(node, original);
    this.foregroundRoots.clear(); this.foreground.clear();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.setActive(false); this.destroyed = true;
    director.off(Director.EVENT_BEFORE_DRAW, this.beforeDraw, this);
    director.off(Director.EVENT_AFTER_DRAW, this.finishDraw, this);
    this.invalidationSource = undefined;
    for (const [transform, original] of this.inputTests) if (transform.isValid) transform.hitTest = original;
    this.inputTests.clear();
    for (const camera of this.cameras) if (camera.isValid) camera.targetTexture = null;
    for (const node of [...this.cameraNodes, this.quads[0], this.content]) if (node?.isValid) node.destroy();
    this.ownedMaterials.forEach(material => material.destroy());
    this.pool.members.delete(this);
    if (!this.pool.members.size) {
      this.frames.forEach(frame => frame.destroy()); this.textures.forEach(texture => texture.destroy());
      this.pool.frames = []; this.pool.textures = [];
      if (presentationPools.get(this.presentation.camera) === this.pool) presentationPools.delete(this.presentation.camera);
    }
  }
}
