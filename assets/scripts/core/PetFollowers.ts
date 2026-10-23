import type { Vec2 } from './types';

export interface PetFollowerState {
  grade: number; position: Vec2; velocity: Vec2; offset: Vec2; moving: boolean; walking: boolean; facing: -1 | 1;
}
/** Pet_Ingame_manager.FixedUpdate. Decorative companions have no attack,
 * collider, target, reward or combat-completion participation. */
export class PetFollowers {
  readonly pets: PetFollowerState[] = [];
  private lastCat: Vec2 = {x:0,z:0};
  private catSpeed = 0;
  setSelected(selected: readonly number[], cat: Vec2): void {
    const grades = selected.filter(id => id >= 0);
    if (grades.length > 3 || grades.some(id => !Number.isInteger(id) || id > 9)) throw new Error('Invalid equipped pets');
    const old = this.pets.slice();
    this.pets.splice(0,this.pets.length,...grades.map((grade,i) => {
      const angle = grades.length === 1 ? 0 : (-30 + i*60/(grades.length-1))*Math.PI/180;
      const offset = {x:Math.sin(angle)*5,z:-Math.cos(angle)*5};
      return old[i] ? {...old[i],grade,offset} : {grade,offset,position:{x:cat.x,z:cat.z-4},velocity:{x:0,z:0},moving:false,walking:false,facing:1 as const};
    }));
    if (!old.length) { this.lastCat = {...cat}; this.catSpeed = 0; }
  }
  warp(cat: Vec2): void {
    this.lastCat = {...cat}; this.catSpeed = 0;
    for (const pet of this.pets) { pet.position = {x:cat.x+pet.offset.x,z:cat.z+pet.offset.z}; pet.velocity = {x:0,z:0}; pet.moving = pet.walking = false; }
  }
  fixedStep(dt: number, cats: readonly Vec2[]): void {
    if (!(dt > 0) || !cats.length) return;
    const cat = cats[0];
    this.catSpeed += (Math.hypot(cat.x-this.lastCat.x,cat.z-this.lastCat.z)/dt-this.catSpeed)*Math.fround(.12);
    this.lastCat = {...cat};
    const forces = this.pets.map(() => ({x:0,z:0}));
    const force = (a: Vec2,b: Vec2,radius: number,strength: number): Vec2 => {
      const x=a.x-b.x,z=a.z-b.z,d=Math.hypot(x,z);
      if (d < .001 || d > radius) return {x:0,z:0};
      const k=(1-d/radius)**2*strength/d; return {x:x*k,z:z*k};
    };
    for (let i=0;i<this.pets.length;i++) {
      for (let j=i+1;j<this.pets.length;j++) {
        const f=force(this.pets[i].position,this.pets[j].position,1.5,5);
        forces[i].x+=f.x;forces[i].z+=f.z;forces[j].x-=f.x;forces[j].z-=f.z;
      }
      for (const cat of cats) { const f=force(this.pets[i].position,cat,2,7); forces[i].x+=f.x;forces[i].z+=f.z; }
    }
    this.pets.forEach((pet,i) => {
      const dx=cat.x+pet.offset.x-pet.position.x,dz=cat.z+pet.offset.z-pet.position.z,d=Math.hypot(dx,dz);
      if (!pet.moving && d>3.5) pet.moving=true; else if (pet.moving && d<Math.fround(2.2)) pet.moving=false;
      const t=Math.max(0,Math.min(1,(d-Math.fround(2.2))/(14-Math.fround(2.2))));
      const speed=4+(Math.max(20,this.catSpeed*Math.fround(1.15))-4)*t*t*(3-2*t);
      pet.velocity={x:forces[i].x+(pet.moving&&d>0?dx/d*speed:0),z:forces[i].z+(pet.moving&&d>0?dz/d*speed:0)};
      pet.walking=Math.hypot(pet.velocity.x,pet.velocity.z)>.4;
      if (pet.walking && Math.abs(pet.velocity.x)>=Math.fround(.05)) pet.facing=pet.velocity.x>0?1:-1;
      pet.position.x+=pet.velocity.x*dt;pet.position.z+=pet.velocity.z*dt;
    });
  }
}
