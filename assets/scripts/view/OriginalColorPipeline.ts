import { Camera, Color, EffectAsset, Material, Node, RenderTexture, screen, Sprite, SpriteFrame, Texture2D, UITransform } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { ORIGINAL_CAMERA_CLEAR, ORIGINAL_WORLD_LAYER, originalRenderExtent, srgbToLinear } from './OriginalColorMath';

/** Blend the whole world in linear LDR, then encode once for the display.
 * Encoding every particle separately before blending is not equivalent.
 * Evidence: original-color-pipeline.json / PlayerSettings + Mobile_RPAsset.
 */
export class OriginalColorPipeline {
  readonly world: Node;
  readonly texture = new RenderTexture();
  private readonly camera: Camera;
  private readonly cameraNode: Node;
  private readonly output: Sprite;
  private readonly outputNode: Node;
  private readonly frame = new SpriteFrame();
  private readonly materials: Material[] = [];
  private readonly originalVisibility: number;
  private destroyed = false;

  static async load(art: ArtLibrary): Promise<EffectAsset[]> {
    return Promise.all(['original-sprite', 'original-graphics', 'original-skin-composite'].map(name =>
      art.resourceLoader.load(`art/rendering/${name}`, 'effect')));
  }

  constructor(parent: Node, private readonly mainCamera: Camera, art: ArtLibrary, effects: EffectAsset[]) {
    this.originalVisibility = mainCamera.visibility;
    try {
      const material = (effect:EffectAsset,defines?:Record<string,boolean>):Material => {
        const value = new Material(); this.materials.push(value);
        value.initialize({effectAsset:effect,defines}); return value;
      };
      const sprite = material(effects[0]);
      const graphics = material(effects[1]);
      const present = material(effects[0],{ENCODE_OUTPUT: true, SAMPLE_FROM_RT: true});
      const healthFill = material(effects[0],{ORIGINAL_HEALTH_FILL: true});
      this.world = makeNode('OriginalLinearWorld', parent);
      this.world.layer = ORIGINAL_WORLD_LAYER;
      this.texture.initialize({name: 'OriginalLinearLDR', width: 1, height: 1});
      // Creator 3.8.8 WebGL1 keeps the initial 1x1 power-of-two flag after
      // resize. Explicit clamp keeps this NPOT render target sampleable.
      this.texture.setWrapMode(Texture2D.WrapMode.CLAMP_TO_EDGE, Texture2D.WrapMode.CLAMP_TO_EDGE);
      this.cameraNode = new Node('OriginalWorldCamera'); parent.addChild(this.cameraNode);
      this.camera = this.cameraNode.addComponent(Camera);
      this.camera.projection = Camera.ProjectionType.ORTHO;
      this.camera.priority = mainCamera.priority - 1;
      this.camera.visibility = ORIGINAL_WORLD_LAYER;
      this.camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
      this.camera.clearColor = new Color(...ORIGINAL_CAMERA_CLEAR.slice(0,3).map(c => Math.round(srgbToLinear(c) * 255)) as [number, number, number], 0);
      this.camera.near = mainCamera.near; this.camera.far = mainCamera.far;
      this.camera.targetTexture = this.texture;
      mainCamera.visibility &= ~ORIGINAL_WORLD_LAYER;
      this.outputNode = makeNode('OriginalWorldPresentation', parent);
      this.output = this.outputNode.addComponent(Sprite);
      this.output.sizeMode = Sprite.SizeMode.CUSTOM;
      this.frame.texture = this.texture;
      this.output.spriteFrame = this.frame;
      this.output.customMaterial = present;
      art.linearSpriteMaterial = sprite; art.linearGraphicsMaterial = graphics;
      art.originalHealthFillMaterial = healthFill;
    } catch(error) {
      this.destroy();
      throw error;
    }
  }

  resize(width: number, height: number): void {
    const pixels = screen.windowSize;
    const w = originalRenderExtent(pixels.width), h = originalRenderExtent(pixels.height);
    if (this.texture.width !== w || this.texture.height !== h) {
      this.texture.resize(w, h);
      // Reset the SpriteFrame rectangle/UVs as well as the framebuffer size.
      this.frame.reset({texture: this.texture}, true);
    }
    this.output.node.getComponent(UITransform)!.setContentSize(width, height);
    this.camera.orthoHeight = height / 2;
    this.syncCamera();
  }

  syncCamera(): void {
    this.camera.node.setWorldPosition(this.mainCamera.node.worldPosition);
    this.camera.node.setWorldRotation(this.mainCamera.node.worldRotation);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.mainCamera.isValid) this.mainCamera.visibility = this.originalVisibility;
    // Scene teardown destroys child components before the bootstrap component.
    // Keep node references independently: a destroyed Component.node is null.
    if (this.camera?.isValid) this.camera.targetTexture = null;
    if (this.cameraNode?.isValid) this.cameraNode.destroy();
    if (this.outputNode?.isValid) this.outputNode.destroy();
    if (this.world?.isValid) this.world.destroy();
    this.frame.destroy(); this.texture.destroy();
    for (const material of this.materials) material.destroy();
  }
}
