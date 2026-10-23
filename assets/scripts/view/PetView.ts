import { Color, Node, Sprite } from 'cc';
import { CAMERA_BASIS as C, projectWorld } from '../core/projection';
import type { PetFollowerState } from '../core/PetFollowers';
import { ArtLibrary, makeNode } from './ArtLibrary';
import { OriginalParticleMesh } from './OriginalParticleMesh';
import { PetAnimation, PetRig } from './PetAnimation';
import { loadResourceBatch } from './ResourceBatch';

/** Independent lazy cache. Loading validates every mesh before equipment can commit. */
export class PetVisualAssets {
  readonly rigs = new Map<number,PetRig>();
  private readonly pending = new Map<number,Promise<void>>();
  constructor(private readonly art: ArtLibrary) {}
  isLoaded(id:number):boolean {return this.rigs.has(id);}
  async prepare(grades:readonly number[]):Promise<void> {await Promise.all(Array.from(new Set(grades.filter(id=>id>=0))).map(id=>this.ensureLoaded(id)));}
  ensureLoaded(id:number):Promise<void> {
    if(!Number.isInteger(id)||id<0||id>9)return Promise.reject(new Error('Invalid pet grade'));
    if(this.rigs.has(id))return Promise.resolve();
    const pending=this.pending.get(id);if(pending)return pending;
    const request=this.art.json<PetRig>(`art/pet-system/characters/${id}/rig`).then(async rig=>{
      new PetAnimation(rig);
      await loadResourceBatch(Object.values(rig.images).map(image=>()=>this.art.loadFrame(image.path)));
      this.rigs.set(id,rig);
    }).then(()=>{this.pending.delete(id);},error=>{this.pending.delete(id);throw error;});this.pending.set(id,request);return request;
  }
}

export class PetView {
  readonly node:Node;
  readonly animator:PetAnimation;
  private readonly parts:{mesh:OriginalParticleMesh;positions:number[][]}[];
  sortingDepth=0;
  constructor(art:ArtLibrary,parent:Node,rig:PetRig) {
    this.node=makeNode(`Pet_${rig.name}`,parent);this.animator=new PetAnimation(rig);
    this.parts=this.animator.meshes.map(source=>{
      const node=makeNode(`PetSlot_${source.name}`,this.node),sprite=node.addComponent(Sprite);
      sprite.spriteFrame=art.frames.get(source.path)!;sprite.trim=false;
      if(art.linearSpriteMaterial)sprite.customMaterial=art.linearSpriteMaterial;
      sprite.color=new Color(...source.color.map(c=>Math.round(c*255)) as [number,number,number,number]);
      const positions=source.positions.map(()=>[0,0,0]);
      return {positions,mesh:new OriginalParticleMesh(sprite,{positions,uv:source.uv,indices:source.indices})};
    });
  }
  update(dt:number,state:PetFollowerState):void {
    this.animator.update(dt,state.walking);
    const root=projectWorld(state.position);this.node.setPosition(root.x,root.y,0);
    // Skin (New) retains its authored 3.5 scale, quaternion and local offset.
    // The outer Pet transform is driven by Pet_Ingame_manager, never by art data.
    const chain=this.animator.rig.sourceTransforms.slice(0,-1);
    this.animator.meshes.forEach((mesh,i)=>{
      mesh.positions.forEach((p,j)=>{
        let x=p[0]*state.facing,y=p[1],z=0;
        for(const t of chain){
          x*=t.m_LocalScale.x;y*=t.m_LocalScale.y;z*=t.m_LocalScale.z;
          const q=t.m_LocalRotation,tx=2*(q.y*z-q.z*y),ty=2*(q.z*x-q.x*z),tz=2*(q.x*y-q.y*x);
          const nx=x+q.w*tx+q.y*tz-q.z*ty,ny=y+q.w*ty+q.z*tx-q.x*tz,nz=z+q.w*tz+q.x*ty-q.y*tx;
          x=nx+t.m_LocalPosition.x;y=ny+t.m_LocalPosition.y;z=nz+t.m_LocalPosition.z;
        }
        const out=this.parts[i].positions[j];out[0]=C.rightX*x+C.rightZ*z;out[1]=C.upX*x+C.upY*y+C.upZ*z;
      });this.parts[i].mesh.updateProjected();
    });
    this.sortingDepth=C.forwardX*state.position.x+C.forwardZ*state.position.z;
  }
  destroy():void {this.node.destroy();}
}
