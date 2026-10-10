import { Color, EffectAsset, gfx, Graphics, Material, Node, resources, Sprite, Texture2D, Vec4 } from 'cc';
import { projectWorld } from '../core';
import { ArtLibrary, ImageSpec, makeNode } from './ArtLibrary';

type Point = [number, number];
interface PlaneBasis { position: Point; axisX: Point; axisY: Point }
interface BorderSpec extends PlaneBasis {
  name: string; asset: string; sortingOrder: number; color: [number,number,number,number];
}
interface FillSpec {
  name: string; sortingOrder: number; color: [number,number,number,number]; points: Point[];
}
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
}
interface VisibleItem { node: Node; minX: number; maxX: number; minY: number; maxY: number }

/** Map-only adapter for the original first-stage scene and Floor material.
 * Geometry is already projected from the original Unity transforms by the importer.
 * Combat owns camera movement; this class neither changes player state nor advances time.
 */
export class OriginalMapView {
  private static readonly effects = new WeakMap<OriginalMapDefinition,EffectAsset>();
  private readonly material: Material;
  readonly node: Node;
  readonly shadowLayer: Node;
  private readonly visibleItems: VisibleItem[] = [];

  static async load(art: ArtLibrary): Promise<OriginalMapDefinition> {
    const map = await art.json('art/maps/forest/map') as OriginalMapDefinition;
    if (map.version !== 1) throw new Error(`Unsupported map definition ${map.version}`);
    await Promise.all(Object.values(map.sprites).map(spec => art.loadFrame(spec.path)));
    const effect = await new Promise<EffectAsset>((resolve,reject) => resources.load(
      map.ground.lighting.effect,EffectAsset,(err,value)=>err?reject(err):resolve(value)));
    this.effects.set(map,effect);
    return map;
  }

  constructor(private readonly art: ArtLibrary, readonly definition: OriginalMapDefinition, parent: Node) {
    this.node = makeNode('OriginalStage1Map',parent);
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
    }
    for (const border of definition.borders) {
      const spec = definition.sprites[border.asset];
      const node = art.image(border.name,{...spec,color:border.color},layer(border.sortingOrder));
      this.applyBasis(node,border);
      this.track(node,this.imageCorners(spec,border));
    }
    // Original Cat/Pivot/Shadow renderer level0:83894 uses Default sorting order -31.
    this.shadowLayer = layer(-31);
    this.shadowLayer.name = 'ActorShadows_SortingMinus31';
    Array.from(layers.keys()).sort((a,b)=>a-b).forEach((order,index)=>layers.get(order)!.setSiblingIndex(index));
  }

  /** Follow.Update copies Cat's position; retain the camera child's small static offset. */
  cameraCenter(player: {x:number;z:number}): {x:number;y:number} {
    const point = projectWorld(player);
    return {x:point.x+this.definition.camera.projectedOffset[0],y:point.y+this.definition.camera.projectedOffset[1]};
  }

  /** Cull existing geometry only. Grass stays fixed in world space as the camera follows. */
  updateCamera(center: {x:number;y:number}, halfWidth: number, halfHeight=this.definition.camera.halfHeight): void {
    const margin = 0.5;
    for (const item of this.visibleItems) {
      item.node.active = item.maxX >= center.x-halfWidth-margin && item.minX <= center.x+halfWidth+margin
        && item.maxY >= center.y-halfHeight-margin && item.minY <= center.y+halfHeight+margin;
    }
  }

  destroy(): void { if (this.node.isValid) this.node.destroy(); }

  private createGround(parent: Node): void {
    const ground = this.definition.ground;
    const original = this.definition.sprites.ground;
    const frame = this.art.frames.get(original.path)!;
    // Original Texture154 is bilinear Repeat with one mip. An atlas padded
    // with edge copies cannot blend opposite edges at each grass repetition.
    if (frame.rect.x !== 0 || frame.rect.y !== 0 || frame.rect.width !== frame.texture.width
      || frame.rect.height !== frame.texture.height || frame.rotated) {
      throw new Error('The repeating ground must remain a standalone, unrotated texture');
    }
    frame.packable = false;
    (frame.texture as Texture2D).setWrapMode(Texture2D.WrapMode.REPEAT,Texture2D.WrapMode.REPEAT);
    const node = this.art.image('OriginalGround_Repeat18x18',{...original,color:ground.color},parent);
    node.getComponent(Sprite)!.customMaterial = this.material;
    this.applyBasis(node,ground);
    this.track(node,this.imageCorners(original,ground));
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

  private track(node: Node,points: Point[]): void {
    this.visibleItems.push({node,minX:Math.min(...points.map(p=>p[0])),maxX:Math.max(...points.map(p=>p[0])),
      minY:Math.min(...points.map(p=>p[1])),maxY:Math.max(...points.map(p=>p[1]))});
  }
}
