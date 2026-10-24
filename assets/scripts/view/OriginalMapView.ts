import { Color, EffectAsset, gfx, Graphics, Material, Node, Sprite, Texture2D, UITransform, Vec4 } from 'cc';
import { projectWorld } from '../core';
import type { StageDefinition, Vec2 } from '../core';
import { ArtLibrary, ImageSpec, makeNode } from './ArtLibrary';
import type { RaidVisualConfig } from './RaidBossView';
import { loadResourceBatch } from './ResourceBatch';
import { createMapBorderGeometry, MAP_BORDER_SEAMS } from './MapBorderGeometry';
import { OriginalParticleMesh, ParticleMeshGeometry } from './OriginalParticleMesh';

type Point = [number, number];
interface PlaneBasis { position: Point; axisX: Point; axisY: Point }
interface BorderSpec extends PlaneBasis {
  name: string; asset: string; sortingOrder: number; color: [number,number,number,number];
}
interface FillSpec {
  name: string; sortingOrder: number; color: [number,number,number,number]; points: Point[];
  sourceRenderer?: string;
}
interface MapSkin { sprites: Record<string, ImageSpec>; fillColors: Record<string, [number,number,number,number]> }
export interface OriginalMapDefinition {
  version: number;
  sprites: Record<string,ImageSpec>;
  ground: PlaneBasis & {
    repeat: Point; uvOffset: Point; sortingOrder: number; color: [number,number,number,number];
    lighting: {effect:string;irradiance:[number,number,number]};
  };
  borders: BorderSpec[];
  fills: FillSpec[];
  camera: { halfHeight: number; projectedOffset: Point };
  skins?: MapSkin[];
}
interface VisibleItem { node: Node; minX: number; maxX: number; minY: number; maxY: number; enabled?: boolean; cameraCull: boolean }

/** Map-only adapter for all ten original scene skins and the Floor material.
 * Geometry is already projected from the original Unity transforms by the importer.
 * Combat owns camera movement; this class neither changes player state nor advances time.
 */
export class OriginalMapView {
  private static readonly effects = new WeakMap<OriginalMapDefinition,EffectAsset>();
  private readonly material: Material;
  readonly node: Node;
  readonly shadowLayer: Node;
  private readonly visibleItems: VisibleItem[] = [];
  private readonly spriteItems: Array<{node: Node; asset: string; basis: PlaneBasis; visible: VisibleItem;
    mesh?: OriginalParticleMesh; geometry?: ParticleMeshGeometry}> = [];
  private readonly fillItems: Array<{graphics: Graphics; spec: FillSpec}> = [];
  private skinIndex = -1;
  private arena = false;
  private raid = false;
  private boss = false;
  private hunt = false;
  private mine = false;
  private battlefieldActive = true;
  private origin: Vec2 = { x: 0, z: 0 };

  static async load(art: ArtLibrary, stageIndex = 0): Promise<OriginalMapDefinition> {
    const [map, stages] = await Promise.all([
      art.json<OriginalMapDefinition>('art/maps/forest/map'), art.json('art/stages/config'),
    ]);
    if (map.version !== 1) throw new Error(`Unsupported map definition ${map.version}`);
    if (stages.version !== 1 || stages.skins.length !== 10 || stages.treeSprites.length !== 40) throw new Error('Invalid original stage assets');
    map.skins = stages.skins;
    art.catalog.stageTrees = stages;
    const [, effect] = await Promise.all([
      this.loadStage(art, map, stageIndex),
      art.resourceLoader.load(map.ground.lighting.effect, 'effect'),
    ]);
    this.effects.set(map,effect);
    return map;
  }

  static stageFrames(art: ArtLibrary, map: OriginalMapDefinition, stageIndex: number): ImageSpec[] {
    const stages = art.catalog.stageTrees, index = Math.max(0, stageIndex) % 10;
    const frames: ImageSpec[] = [...Object.values(map.sprites), ...stages.treeSprites.slice(index * 4, index * 4 + 4),
      stages.normal.healthBar.background, stages.normal.healthBar.fill,
      stages.boss.healthBar.background, stages.boss.healthBar.fill];
    if (stages.boss.sparkles) frames.push(stages.boss.sparkles.image);
    frames.push(...Object.values(map.skins![index].sprites));
    return frames;
  }

  static async loadStage(art: ArtLibrary, map: OriginalMapDefinition, stageIndex: number): Promise<void> {
    await loadResourceBatch(this.stageFrames(art, map, stageIndex).map(spec => () => art.loadFrame(spec.path)));
  }

  constructor(private readonly art: ArtLibrary, readonly definition: OriginalMapDefinition, parent: Node, stageIndex = 0) {
    this.node = makeNode('OriginalStageMap',parent);
    this.material = new Material();
    // Register ownership before initialization, which can fail while loading.
    this.node.once(Node.EventType.NODE_DESTROYED,()=>this.material.destroy());
    this.material.initialize({effectAsset:OriginalMapView.effects.get(definition)!,defines:{USE_TEXTURE:true}});
    this.material.setProperty('irradiance',new Vec4(...definition.ground.lighting.irradiance,1));
    this.material.setProperty('uvTransform',new Vec4(...definition.ground.repeat,...definition.ground.uvOffset));
    const layers = new Map<number,Node>();
    const layer = (order: number): Node => {
      let node = layers.get(order);
      if (!node) { node=makeNode(`OriginalMap_Sorting${order}`,this.node); layers.set(order,node); }
      return node;
    };
    this.createGround(layer(definition.ground.sortingOrder));
    for (const fill of definition.fills) {
      const node = makeNode(fill.name,layer(fill.sortingOrder));
      const graphics = node.addComponent(Graphics);
      if (art.linearGraphicsMaterial) {
        // Creator 3.8.8 implements this setter but omits it from Graphics.d.ts.
        (graphics as Graphics & {srcBlendFactor:gfx.BlendFactor}).srcBlendFactor = gfx.BlendFactor.ONE;
        graphics.customMaterial = art.linearGraphicsMaterial;
      }
      graphics.fillColor = new Color(...fill.color);
      graphics.moveTo(...fill.points[0]);
      for (let i=1;i<fill.points.length;i++) graphics.lineTo(...fill.points[i]);
      graphics.close(); graphics.fill();
      this.track(node,fill.points);
      this.fillItems.push({graphics, spec: fill});
    }
    // Upper/lower strips never overlap (checked for all ten skins). Group by
    // texture while retaining each strip's authored order, so resident borders
    // batch together instead of alternating textures for every map grid.
    const borderAssets = Array.from(new Set(definition.borders.map(border => border.asset)));
    for (const asset of borderAssets) for (const border of definition.borders.filter(value => value.asset === asset)) {
      const spec = definition.sprites[border.asset];
      const node = art.image(border.name,{...spec,color:border.color},layer(border.sortingOrder));
      this.applyBasis(node,border);
      const visible = this.track(node,this.imageCorners(spec,border),false);
      this.spriteItems.push({node,asset:border.asset,basis:border,visible});
    }
    // Original Cat/Pivot/Shadow renderer level0:83894 uses Default sorting order -31.
    this.shadowLayer = layer(-31);
    this.shadowLayer.name = 'ActorShadows_SortingMinus31';
    Array.from(layers.keys()).sort((a,b)=>a-b).forEach((order,index)=>layers.get(order)!.setSiblingIndex(index));
    this.setStage(stageIndex);
  }

  /** Geometry and shadow ownership stay alive; Tree_manager swaps these skin references only. */
  setStage(stageIndex: number): void {
    const index = stageIndex % 10;
    if (this.skinIndex === index) return;
    const skin = this.definition.skins?.[index];
    if (!skin) { this.skinIndex = index; return; }
    for (const item of this.spriteItems) {
      const spec = skin.sprites[item.asset], frame = this.art.frames.get(spec.path)!;
      if (item.asset === 'ground') this.prepareGround(spec);
      const sprite = item.node.getComponent(Sprite)!;
      sprite.spriteFrame = frame;
      const transform = item.node.getComponent(UITransform)!;
      transform.setContentSize(...spec.sizeUnits); transform.setAnchorPoint(...spec.anchor);
      if (item.asset === 'borderUp' && (MAP_BORDER_SEAMS[index] || item.mesh)) {
        // Retain the same mesh allocation after first use; a later skin gets
        // an undeformed grid. applyLayout restores the authored node basis
        // after updateProjected's local-coordinate reset.
        const geometry = createMapBorderGeometry(spec, MAP_BORDER_SEAMS[index]);
        if (!item.mesh) {
          item.geometry = geometry;
          item.mesh = new OriginalParticleMesh(sprite, geometry);
        } else Object.assign(item.geometry!, geometry);
        item.mesh.updateProjected();
      }
      const corners = this.imageCorners(spec,item.basis);
      Object.assign(item.visible,{minX:Math.min(...corners.map(p=>p[0])),maxX:Math.max(...corners.map(p=>p[0])),
        minY:Math.min(...corners.map(p=>p[1])),maxY:Math.max(...corners.map(p=>p[1]))});
    }
    for (const {graphics,spec} of this.fillItems) {
      graphics.clear();
      graphics.fillColor = new Color(...(skin.fillColors[spec.sourceRenderer??'']??spec.color));
      graphics.moveTo(...spec.points[0]);
      for (let i=1;i<spec.points.length;i++) graphics.lineTo(...spec.points[i]);
      graphics.close(); graphics.fill();
    }
    this.skinIndex = index;
    this.applyLayout();
  }

  /** Translate geometry only. Cat shadows already receive absolute projected
   * positions and must not inherit a second scene-root translation. */
  setBattlefield(stage: Pick<StageDefinition, 'skinIndex' | 'mapOrigin' | 'mapLayout'>): void {
    const wasRaid = this.raid || this.boss || this.hunt || this.mine;
    this.battlefieldActive = true;
    this.raid = stage.mapLayout === 'raid';
    this.boss = stage.mapLayout === 'boss';
    this.hunt = stage.mapLayout === 'hunt';
    this.mine = stage.mapLayout === 'mine';
    this.arena = stage.mapLayout === 'arena' || this.raid || this.boss || this.hunt || this.mine;
    this.origin = { ...(stage.mapOrigin ?? { x: 0, z: 0 }) };
    this.setStage(stage.skinIndex);
    if (wasRaid || this.raid || this.boss || this.hunt || this.mine) {
      const spec = (this.raid || this.boss || this.hunt || this.mine) ? this.raidGround : this.definition.skins?.[this.skinIndex]?.sprites.ground ?? this.definition.sprites.ground;
      const node = this.spriteItems.find(item => item.asset === 'ground')!.node;
      this.prepareGround(spec);
      node.getComponent(Sprite)!.spriteFrame = this.art.frames.get(spec.path)!;
      node.getComponent(UITransform)!.setContentSize(...spec.sizeUnits);
      node.getComponent(UITransform)!.setAnchorPoint(...spec.anchor);
      this.material.setProperty('irradiance', (this.raid || this.boss || this.hunt || this.mine) ? new Vec4(1, 1, 1, 1) : new Vec4(...this.definition.ground.lighting.irradiance, 1));
    }
    this.applyLayout();
  }

  private get raidGround(): RaidVisualConfig['ground'] {
    const ground = (this.art.catalog[this.mine ? 'mine' : this.hunt ? 'hunt' : this.boss ? 'boss' : 'raid'] as RaidVisualConfig | undefined)?.ground;
    if (!ground) throw new Error('Missing original special-mode ground');
    return ground;
  }

  setBattlefieldActive(active: boolean): void {
    this.battlefieldActive = active;
    for (const item of this.visibleItems) item.node.active = active && item.enabled !== false;
  }

  /** Monster_Main_Floor uses the same unlit, repeating circle-clip shader as
   * the outer arena. Share its material while the Hunt map owns this overlay. */
  configureOverlayGround(node: Node, image: ImageSpec): void {
    this.prepareGround(image);
    node.getComponent(Sprite)!.customMaterial = this.material;
  }

  private applyLayout(): void {
    const origin = projectWorld(this.origin);
    const skin = this.definition.skins?.[this.skinIndex];
    for (const item of this.spriteItems) {
      const spec = (this.raid || this.boss || this.hunt || this.mine) && item.asset === 'ground' ? this.raidGround : skin?.sprites[item.asset] ?? this.definition.sprites[item.asset];
      const basis = this.arena && item.asset === 'ground' ? arenaGroundBasis(this.origin, (this.raid || this.boss || this.hunt || this.mine) ? this.raidGround.transform : undefined) :
        { ...item.basis, position: [item.basis.position[0] + origin.x, item.basis.position[1] + origin.y] as Point };
      this.applyBasis(item.node, basis);
      const corners = this.imageCorners(spec, basis);
      Object.assign(item.visible, { minX: Math.min(...corners.map(p => p[0])), maxX: Math.max(...corners.map(p => p[0])),
        minY: Math.min(...corners.map(p => p[1])), maxY: Math.max(...corners.map(p => p[1])),
        enabled: !this.arena || item.asset === 'ground' });
      item.node.active = this.battlefieldActive && item.visible.enabled !== false;
    }
    for (const { graphics, spec } of this.fillItems) {
      const node = graphics.node, item = this.visibleItems.find(value => value.node === node)!;
      node.setPosition(origin.x, origin.y, 0);
      Object.assign(item, { minX: Math.min(...spec.points.map(p => p[0])) + origin.x,
        maxX: Math.max(...spec.points.map(p => p[0])) + origin.x,
        minY: Math.min(...spec.points.map(p => p[1])) + origin.y,
        maxY: Math.max(...spec.points.map(p => p[1])) + origin.y, enabled: !this.arena });
      node.active = this.battlefieldActive && !this.arena;
    }
    // Original SpeedRun Ground material sharedassets0.assets:29. Continue to use
    // this project's existing ground texture and lighting, as requested.
    this.material.setProperty('uvTransform', (this.raid || this.boss || this.hunt || this.mine) ? new Vec4(...this.raidGround.tiling, 0, 0) : this.arena ? new Vec4(7, 3.740000009536743, 0, 0)
      : new Vec4(...this.definition.ground.repeat, ...this.definition.ground.uvOffset));
    // Source material29 uses shader225 Custom/DiamondClipSprite: despite its
    // name, it discards squared UV distance > .25. The authored scale15 gives
    // a world circle radius76.8, projected to an ellipse by the game camera.
    this.material.setProperty('groundClip', new Vec4(.5, .5, .25, this.arena ? 1 : 0));
  }

  /** Follow.Update copies Cat's position; retain the camera child's small static offset. */
  cameraCenter(player: {x:number;z:number}): {x:number;y:number} {
    const point = projectWorld(player);
    return {x:point.x+this.definition.camera.projectedOffset[0],y:point.y+this.definition.camera.projectedOffset[1]};
  }

  /** Keep the small, static border strip resident. Toggling these
   * nodes at camera edges destroys/recreates Sprite render data as the player
   * moves. Let GPU clipping handle the strip so camera culling cannot expose a
   * solid fill through a missing tile. Ground/fills retain camera culling, and
   * battlefield/layout visibility still applies to everything. */
  updateCamera(center: {x:number;y:number}, halfWidth: number, halfHeight=this.definition.camera.halfHeight): void {
    const margin = 0.5;
    for (const item of this.visibleItems) {
      item.node.active = this.battlefieldActive && item.enabled !== false && (!item.cameraCull
        || (item.maxX >= center.x-halfWidth-margin && item.minX <= center.x+halfWidth+margin
          && item.maxY >= center.y-halfHeight-margin && item.minY <= center.y+halfHeight+margin));
    }
  }

  destroy(): void { if (this.node.isValid) this.node.destroy(); }

  private createGround(parent: Node): void {
    const ground = this.definition.ground;
    const original = this.definition.sprites.ground;
    this.prepareGround(original);
    const node = this.art.image('OriginalGround_Repeat18x18',{...original,color:ground.color},parent);
    node.getComponent(Sprite)!.customMaterial = this.material;
    this.applyBasis(node,ground);
    const visible = this.track(node,this.imageCorners(original,ground));
    this.spriteItems.push({node,asset:'ground',basis:ground,visible});
  }

  private prepareGround(original: ImageSpec): void {
    const frame = this.art.frames.get(original.path)!;
    // Original Texture154 is bilinear Repeat with one mip. An atlas padded
    // with edge copies cannot blend opposite edges at each grass repetition.
    if (frame.rect.x !== 0 || frame.rect.y !== 0 || frame.rect.width !== frame.texture.width
      || frame.rect.height !== frame.texture.height || frame.rotated) {
      throw new Error('The repeating ground must remain a standalone, unrotated texture');
    }
    frame.packable = false;
    (frame.texture as Texture2D).setWrapMode(Texture2D.WrapMode.REPEAT,Texture2D.WrapMode.REPEAT);
  }

  private applyBasis(node: Node, basis: PlaneBasis): void {
    const xLength = Math.hypot(...basis.axisX), yLength = Math.hypot(...basis.axisY);
    const dot = basis.axisX[0]*basis.axisY[0]+basis.axisX[1]*basis.axisY[1];
    if (Math.abs(dot)>xLength*yLength*0.0001) throw new Error('A textured map plane needs a shear-capable adapter');
    const determinant = basis.axisX[0]*basis.axisY[1]-basis.axisX[1]*basis.axisY[0];
    node.setPosition(...basis.position,0);
    node.angle = Math.atan2(basis.axisX[1],basis.axisX[0])*180/Math.PI;
    node.setScale(xLength,determinant<0?-yLength:yLength,1);
  }

  private imageCorners(spec: ImageSpec,basis: PlaneBasis): Point[] {
    return [[0,0],[1,0],[1,1],[0,1]].map(([x,y]) => {
      const px=(x-spec.anchor[0])*spec.sizeUnits[0], py=(y-spec.anchor[1])*spec.sizeUnits[1];
      return [basis.position[0]+basis.axisX[0]*px+basis.axisY[0]*py,
        basis.position[1]+basis.axisX[1]*px+basis.axisY[1]*py] as Point;
    });
  }

  private track(node: Node,points: Point[],cameraCull=true): VisibleItem {
    const item={node,cameraCull,minX:Math.min(...points.map(p=>p[0])),maxX:Math.max(...points.map(p=>p[0])),
      minY:Math.min(...points.map(p=>p[1])),maxY:Math.max(...points.map(p=>p[1]))};
    this.visibleItems.push(item); return item;
  }
}

/** Ground Transform level0:39321: scale15 with its authored 90°/45° rotation.
 * Sprite pixels512 / ppu50 yields the source 153.6-square ground plane. */
function arenaGroundBasis(origin: Vec2, transform?: RaidVisualConfig['ground']['transform']): PlaneBasis {
  const [x, y, z, w] = transform?.rotation ?? [.6532815098762512, -.27059805393218994, .27059805393218994, .6532815098762512];
  const [sx, sy] = transform?.scale ?? [15, 15];
  const a = projectWorld({ x: sx * (1 - 2 * (y * y + z * z)), z: 2 * sx * (x * z - y * w) }, 2 * sx * (x * y + z * w));
  const b = projectWorld({ x: 2 * sy * (x * y - z * w), z: 2 * sy * (y * z + x * w) }, sy * (1 - 2 * (x * x + z * z)));
  const offset = transform?.position ?? [0, 0, 0];
  const position = projectWorld({ x: origin.x + offset[0], z: origin.z + offset[2] }, offset[1]);
  return { position: [position.x, position.y], axisX: [a.x, a.y], axisY: [b.x, b.y] };
}
