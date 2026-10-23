import { Node, SpriteFrame } from 'cc';
import { DecimalAmount, ORIGINAL_NUMBER_UNITS, projectWorld } from '../core';
import { ArtLibrary, ImageSpec } from './ArtLibrary';
import { originalDamageBucket, originalDamageDirtyKeys, sampleOriginalDamageCurve as sample } from './OriginalFeedbackMath';
import { OrderedQuadBatch } from './OrderedQuadBatch';
import { loadNumberGlyphAtlas, numberGlyphFrame, retainNumberGlyphAtlas } from './NumberGlyphAtlas';

export interface DamageCurve {
  movementX: number[]; movementY: number[]; scale: number[]; alpha: number[];
}
export interface DamageNumberConfig {
  glyphs: Record<string, ImageSpec>; curves: DamageCurve[];
  gap: number; duration: number; worldScale: number; bucketSize: number; cooldown: number;
}
export interface MoneyNumberConfig extends DamageNumberConfig {
  height: number;
}

/** Money uses the original Font315 glyphs, with their authored green palette. */
export async function loadOriginalMoneyNumbers(art:ArtLibrary):Promise<MoneyNumberConfig> {
  const config=await art.json<MoneyNumberConfig>('art/effects/money-numbers/config');
  await loadNumberGlyphAtlas(art);
  return config;
}
interface NumberGlyph {
  frame:SpriteFrame;x:number;width:number;height:number;anchorX:number;anchorY:number;
  scaleX:number;scaleY:number;angle:number;color:number[];
}
interface NumberSlot {
  digits:NumberGlyph[];glyphCount:number;time:number;origin:{x:number;y:number};curve:DamageCurve;
  startedAt:number;dirtyKeys:number[];config:DamageNumberConfig;
  x:number;y:number;scale:number;opacity:number;
}

/** Original damage/money bitmap fonts, shared CanSpawnText buckets and baked curves. */
export class DamageNumbers {
  private readonly slots:NumberSlot[]=[];
  private readonly config:DamageNumberConfig;
  private readonly cooldowns=new Map<string,number>();
  private readonly poseKeys:number[]=[];
  private readonly batch:OrderedQuadBatch;
  private readonly color=[1,1,1,1];
  private dirty=false;
  private clock=0;
  constructor(private readonly art:ArtLibrary,parent:Node,
    private readonly moneyConfig?:MoneyNumberConfig) {
    this.config=art.catalog.feedback.damage;
    this.batch=new OrderedQuadBatch(art,parent,'NumberGlyphs');
    parent.once(Node.EventType.NODE_DESTROYED,retainNumberGlyphAtlas(art));
  }
  spawn(position:{x:number;z:number},amount:DecimalAmount|number,frameTime=this.clock,critical=false,height=2):void {
    if(typeof amount==='number'&&(!Number.isFinite(amount)||amount<0))return;
    this.spawnText(position,height,DecimalAmount.from(amount).format(ORIGINAL_NUMBER_UNITS),
      critical?(this.art.weaponVisuals?.config.criticalDamage??this.config):this.config,frameTime);
  }
  spawnMoney(position:{x:number;z:number},amount:DecimalAmount|number,frameTime=this.clock):void {
    if(!this.moneyConfig||(typeof amount==='number'&&(!Number.isFinite(amount)||amount<=0)))return;
    const value=DecimalAmount.from(amount);
    if(value.compare(0)<=0)return;
    // Font315 maps '+' to the original cash icon. It is not a UI font plus sign.
    this.spawnText(position,this.moneyConfig.height,`+${value.format(ORIGINAL_NUMBER_UNITS)}`,this.moneyConfig,frameTime);
  }
  /** Ore's original Font314 includes the diamond sign and decimal glyphs. */
  spawnStyledText(position:{x:number;z:number},height:number,text:string,config:DamageNumberConfig,frameTime=this.clock):void {
    this.spawnText(position,height,text,config,frameTime);
  }
  private spawnText(position:{x:number;z:number},height:number,value:string,
    config:DamageNumberConfig,frameTime:number):void {
    const chars=value.split('');
    // Unsupported numeric notation must not consume the shared cooldown or a slot.
    if(chars.some(char=>!config.glyphs[char]))return;
    const bucket=originalDamageBucket(position.x,height,config.bucketSize);
    const last=this.cooldowns.get(bucket);
    if(last!==undefined&&Math.fround(Math.fround(frameTime)-last)<Math.fround(config.cooldown))return;
    this.cooldowns.set(bucket,Math.fround(frameTime));
    // RequestHudNumber grows its free-list pool when every object is in use.
    const slot=this.slots.find(s=>s.time<=0)??this.createSlot(config);
    slot.config=config;
    const width=chars.reduce((n,c)=>n+config.glyphs[c].sizeUnits[0]+config.gap,0);
    let x=-width/2;
    chars.forEach((char,i)=>{
      const spec=config.glyphs[char];
      const digit=slot.digits[i]??(slot.digits[i]={frame:numberGlyphFrame(this.art,spec.path),
        x:0,width:0,height:0,anchorX:0,anchorY:0,scaleX:spec.localScale?.[0]??1,
        scaleY:spec.localScale?.[1]??1,angle:spec.localRotationDeg??0,color:[1,1,1,1]});
      digit.frame=numberGlyphFrame(this.art,spec.path);
      // Damage and money share this pool: restore the requesting style on every
      // use, including untinted money glyphs after another style's tint.
      for(let c=0;c<4;c++)digit.color[c]=spec.color?spec.color[c]/255:1;
      digit.width=spec.sizeUnits[0];digit.height=spec.sizeUnits[1];
      digit.anchorX=spec.anchor[0];digit.anchorY=spec.anchor[1];
      digit.x=x;x+=spec.sizeUnits[0]+config.gap;
    });
    slot.glyphCount=chars.length;
    const origin=projectWorld(position,height);
    slot.origin.x=origin.x;slot.origin.y=origin.y;
    slot.curve=config.curves[Math.floor(Math.random()*config.curves.length)];
    slot.time=config.duration;slot.startedAt=Math.fround(frameTime);
    this.pose(slot,true);
    this.dirty=true;
  }
  update(dt:number,frameTime=this.clock+Math.max(0,dt)):void {
    this.clock=Math.fround(frameTime);
    for(const s of this.slots)if(s.time>0){
      // The hit can originate in a physics tick. ShowDamageText records that
      // tick's Time.time, while DamageTextManager.Update reads render-frame time.
      s.time=Math.max(0,s.config.duration-Math.max(0,Math.fround(this.clock-s.startedAt)));
      if(s.time>0)this.pose(s);else this.dirty=true;
    }
    // Events are accumulated before this render update. Submit the complete
    // ordered glyph list once, even when a dense frame spawns many numbers.
    if(this.dirty)this.render();
  }
  reset():void {
    for(const s of this.slots)s.time=0;
    this.cooldowns.clear();this.clock=0;
    this.batch.begin();this.batch.end();this.dirty=false;
  }
  diagnostics():{active:number;pooled:number} {
    let active=0;
    for(const slot of this.slots)if(slot.time>0)active++;
    return {active,pooled:this.slots.length};
  }
  private createSlot(config:DamageNumberConfig):NumberSlot {
    const slot:NumberSlot={digits:[],glyphCount:0,time:0,origin:{x:0,y:0},curve:config.curves[0],
      startedAt:0,dirtyKeys:[],config,x:0,y:0,scale:1,opacity:255};
    this.slots.push(slot);return slot;
  }
  private pose(s:NumberSlot,force=false):void {
    const t=1-s.time/s.config.duration;
    const x=sample(s.curve.movementX,t),y=sample(s.curve.movementY,t),scale=sample(s.curve.scale,t);
    const keys=originalDamageDirtyKeys(x,y,scale,this.poseKeys);
    if(force||keys[0]!==s.dirtyKeys[0]||keys[1]!==s.dirtyKeys[1]||keys[2]!==s.dirtyKeys[2]) {
      s.x=s.origin.x+x*s.config.worldScale;s.y=s.origin.y+y*s.config.worldScale;s.scale=scale;
      this.dirty=true;
    }
    s.dirtyKeys[0]=keys[0];s.dirtyKeys[1]=keys[1];s.dirtyKeys[2]=keys[2];
    const opacity=Math.round(255*Math.max(0,Math.min(1,sample(s.curve.alpha,t))));
    if(s.opacity!==opacity){s.opacity=opacity;this.dirty=true;}
  }
  private render():void {
    this.batch.begin();
    for(const slot of this.slots)if(slot.time>0)for(let i=0;i<slot.glyphCount;i++) {
      const digit=slot.digits[i],scale=slot.scale;
      this.color[0]=digit.color[0];this.color[1]=digit.color[1];this.color[2]=digit.color[2];
      this.color[3]=digit.color[3]*slot.opacity/255;
      this.batch.add(digit.frame,slot.x+digit.x*scale,slot.y,digit.width*digit.scaleX*scale,
        digit.height*digit.scaleY*scale,digit.anchorX,digit.anchorY,digit.angle,this.color);
    }
    this.batch.end();this.dirty=false;
  }
}
