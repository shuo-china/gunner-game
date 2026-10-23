import { Color, Node, Sprite, UITransform } from 'cc';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalParticleMesh } from './OriginalParticleMesh';
import { PetAnimation } from './PetAnimation';
import { PetVisualAssets } from './PetView';
import type { OriginalUiMaterials, WeaponUiConfig } from './OriginalWeaponUi';

interface Transform { m_LocalPosition:{x:number;y:number;z:number};m_LocalScale:{x:number;y:number;z:number};m_LocalRotation:{x:number;y:number;z:number;w:number}; }
export interface AdventureCampSpec {
  node:string;orthographicSize:number;cameraPosition:number[];cameraBasis:number[][];
  sprites:{source:string;image:string;positions:number[][];color:number[];order:number}[];
  pets:{transforms:Transform[];animation:string}[][];
}
interface CampPet { node:Node;grade:number;animator:PetAnimation;parts:{positions:number[][];mesh:OriginalParticleMesh}[];transforms:Transform[];walking:boolean; }

/** The source camp is an orthographic RenderTexture of the original scene.
 * Project its serialized world quads and weighted Spine vertices into the same
 * masked UI rectangle, retaining the camera's complete parent transform. */
export class AdventureCamp {
  private readonly pets=new Map<number,CampPet>();
  private readonly sorting:{node:Node;order:number;depth:number}[]=[];
  private readonly staticMeshes:{original:number[][];positions:number[][];mesh:OriginalParticleMesh}[]=[];
  private readonly layer:Node;
  private generation=0;
  private signature='';
  private scale=1;
  private destroyed=false;
  constructor(private readonly art:ArtLibrary,parent:Node,config:WeaponUiConfig,
    private readonly spec:AdventureCampSpec,private readonly assets:PetVisualAssets,private readonly materials:OriginalUiMaterials={},private readonly invalidate=()=>{}) {
    this.layer=makeNode('OriginalAdventureCamp',parent);
    for(const image of [...spec.sprites].sort((a,b)=>a.order-b.order)) {
      const node=makeNode(image.source,this.layer),sprite=node.addComponent(Sprite);
      sprite.spriteFrame=art.frames.get(config.images[image.image].path)!;sprite.trim=false;
      if(materials.sprite)sprite.customMaterial=materials.sprite;
      sprite.color=new Color(...image.color as [number,number,number,number]);
      const positions=image.positions.map(()=>[0,0,0]);
      this.sorting.push({node,order:image.order,depth:image.positions.reduce((sum,p)=>sum+p[2],0)/image.positions.length});
      this.staticMeshes.push({original:image.positions,positions,mesh:new OriginalParticleMesh(sprite,{positions,uv:[[0,0],[1,0],[0,1],[1,1]],indices:[0,1,2,2,1,3]})});
    }
    this.sortLayers();this.resize();
  }
  resize():void {
    const tr=this.layer.parent!.getComponent(UITransform)!;
    this.layer.getComponent(UITransform)!.setContentSize(tr.width,tr.height);
    this.scale=tr.height/(2*this.spec.orthographicSize);
    this.staticMeshes.forEach(item=>{item.original.forEach((p,i)=>{item.positions[i][0]=p[0]*this.scale;item.positions[i][1]=p[1]*this.scale;});item.mesh.updateProjected();});
    this.update(0);
  }
  setGrades(grades:readonly number[]):void {
    const next=grades.slice(0,19),signature=next.join(',');if(signature===this.signature)return;
    this.signature=signature;const generation=++this.generation;
    for(const [index,pet] of Array.from(this.pets))if(next[index]!==pet.grade){pet.node.destroy();this.pets.delete(index);const sorted=this.sorting.findIndex(item=>item.node===pet.node);if(sorted>=0)this.sorting.splice(sorted,1);}
    this.assets.prepare(next).then(()=>{
      if(this.destroyed||generation!==this.generation)return;
      next.forEach((grade,index)=>{
        if(this.pets.has(index))return;
        const rig=this.assets.rigs.get(grade);if(!rig)return;
        const variant=this.spec.pets[index][grade],node=makeNode(`CampPet_${index}_${grade}`,this.layer),animator=new PetAnimation(rig);
        const parts=animator.meshes.map(source=>{
          const part=makeNode(source.name,node),sprite=part.addComponent(Sprite);sprite.spriteFrame=this.art.frames.get(source.path)!;sprite.trim=false;
          if(this.materials.sprite)sprite.customMaterial=this.materials.sprite;
          sprite.color=new Color(...source.color.map(v=>Math.round(v*255)) as [number,number,number,number]);
          const positions=source.positions.map(()=>[0,0,0]);
          return {positions,mesh:new OriginalParticleMesh(sprite,{positions,uv:source.uv,indices:source.indices})};
        });
        this.pets.set(index,{node,grade,animator,parts,transforms:variant.transforms,walking:variant.animation==='Walk'});
        this.sorting.push({node,order:0,depth:this.depth(variant.transforms)});
      });
      this.sortLayers();
      this.update(0);this.invalidate();
    }).catch(()=>{if(!this.destroyed&&generation===this.generation){this.signature='';this.invalidate();}});
  }
  private sortLayers():void {this.sorting.sort((a,b)=>a.order-b.order||b.depth-a.depth||a.node.name.localeCompare(b.node.name)).forEach((item,index)=>item.node.setSiblingIndex(index));}
  private depth(transforms:Transform[]):number {
    let p=[0,0,0];for(const t of transforms){const [x,y,z]=p.map((v,i)=>v*[t.m_LocalScale.x,t.m_LocalScale.y,t.m_LocalScale.z][i]),q=t.m_LocalRotation,tx=2*(q.y*z-q.z*y),ty=2*(q.z*x-q.x*z),tz=2*(q.x*y-q.y*x);p=[x+q.w*tx+q.y*tz-q.z*ty+t.m_LocalPosition.x,y+q.w*ty+q.z*tx-q.x*tz+t.m_LocalPosition.y,z+q.w*tz+q.x*ty-q.y*tx+t.m_LocalPosition.z];}return p.reduce((sum,v,i)=>sum+(v-this.spec.cameraPosition[i])*this.spec.cameraBasis[2][i],0);
  }
  update(dt:number):void {
    for(const pet of Array.from(this.pets.values())) {
      pet.animator.update(dt,pet.walking);
      pet.animator.meshes.forEach((mesh,index)=>{
        mesh.positions.forEach((point,i)=>{
          let x=point[0],y=point[1],z=0;
          for(const t of pet.transforms){
            x*=t.m_LocalScale.x;y*=t.m_LocalScale.y;z*=t.m_LocalScale.z;
            const q=t.m_LocalRotation,tx=2*(q.y*z-q.z*y),ty=2*(q.z*x-q.x*z),tz=2*(q.x*y-q.y*x);
            const nx=x+q.w*tx+q.y*tz-q.z*ty,ny=y+q.w*ty+q.z*tx-q.x*tz,nz=z+q.w*tz+q.x*ty-q.y*tx;
            x=nx+t.m_LocalPosition.x;y=ny+t.m_LocalPosition.y;z=nz+t.m_LocalPosition.z;
          }
          const delta=[x-this.spec.cameraPosition[0],y-this.spec.cameraPosition[1],z-this.spec.cameraPosition[2]],out=pet.parts[index].positions[i];
          out[0]=delta.reduce((sum,v,j)=>sum+v*this.spec.cameraBasis[0][j],0)*this.scale;
          out[1]=delta.reduce((sum,v,j)=>sum+v*this.spec.cameraBasis[1][j],0)*this.scale;
        });pet.parts[index].mesh.updateProjected();
      });
    }
  }
  get moving():boolean{return this.pets.size>0;}
  destroy():void{this.destroyed=true;this.generation++;this.pets.clear();this.layer.destroy();}
}
