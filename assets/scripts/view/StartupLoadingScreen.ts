import { ImageAsset, Label, Node, Sprite, SpriteFrame, Texture2D, UITransform } from 'cc';
import { makeNode } from './ArtLibrary';
import type { ResourceLoadingStatus } from './GameResourceLoader';

interface StartupTheme {
  image: HTMLImageElement | null;
  progress: number;
  canvas(): HTMLCanvasElement;
  load(): Promise<HTMLImageElement | null>;
  setProgress(value: number): number;
  layout(width: number,height: number): {top:number;height:number};
  overlay(ctx: CanvasRenderingContext2D,width:number,height:number,value:number,error:boolean,offset:number,status?:string):void;
  hideBrowserCover():void;
  release():void;
}

/** Shares one decoded local JPEG with the engine boot. The small transparent
 * progress strip is uploaded only when its integer percentage/state changes. */
export class StartupLoadingScreen {
  readonly available: boolean;
  private theme?:StartupTheme;
  private root?:Node;
  private background?:Node;
  private overlay?:Node;
  private overlayCanvas?:HTMLCanvasElement;
  private backgroundImage?:ImageAsset;
  private backgroundTexture?:Texture2D;
  private backgroundFrame?:SpriteFrame;
  private overlayImage?:ImageAsset;
  private overlayTexture?:Texture2D;
  private overlayFrame?:SpriteFrame;
  private disposed=false;
  private width=720;
  private height=1280;
  private lastState='';
  resourceStatus?:()=>ResourceLoadingStatus;

  constructor(parent:Node,private readonly message:Label) {
    this.theme=(globalThis as typeof globalThis & {__FOREST_STARTUP_VISUALS__?:StartupTheme}).__FOREST_STARTUP_VISUALS__;
    this.available=!!this.theme;
    if(!this.theme)return;
    this.root=makeNode('FoxStartupArt',parent);
    this.background=makeNode('ForestBackground',this.root);
    this.overlay=makeNode('StartupProgress',this.root);
    this.overlayCanvas=this.theme.canvas();
    this.overlay.addComponent(Sprite).sizeMode=Sprite.SizeMode.CUSTOM;
    this.message.enabled=false;
    this.resize(720,1280);
    void this.theme.load().then(image=>{
      if(this.disposed)return;
      if(image){
        this.backgroundImage=new ImageAsset(image);this.backgroundTexture=new Texture2D();this.backgroundTexture.image=this.backgroundImage;
        this.backgroundFrame=new SpriteFrame();this.backgroundFrame.texture=this.backgroundTexture;
        const backgroundSprite=this.background!.addComponent(Sprite);backgroundSprite.sizeMode=Sprite.SizeMode.CUSTOM;backgroundSprite.spriteFrame=this.backgroundFrame;
      }
      this.resize(this.width,this.height);
      // Let the engine render the prepared cover before removing the DOM boot.
      setTimeout(()=>{if(!this.disposed)this.theme?.hideBrowserCover();},0);
    });
  }

  // Resource callbacks may complete together. The frame's sync() publishes the
  // latest state once; resize still paints immediately for a valid GPU frame.
  setProgress(value:number):void {this.theme?.setProgress(value);}

  resize(width:number,height:number):void {
    this.width=width;this.height=height;
    if(!this.theme||!this.root||!this.overlayCanvas)return;
    this.root.getComponent(UITransform)!.setContentSize(width,height);
    if(this.backgroundFrame){
      const image=this.theme.image!,scale=Math.max(width/image.width,height/image.height);
      this.background!.getComponent(UITransform)!.setContentSize(image.width*scale,image.height*scale);
    }
    // Render at logical 720 px width even on tall phones; no device-DPR inflation.
    const w=720,h=Math.round(720*height/width),layout=this.theme.layout(w,h),scale=width/w;
    this.overlayCanvas.width=w;this.overlayCanvas.height=layout.height;
    const oldFrame=this.overlayFrame,oldTexture=this.overlayTexture,oldImage=this.overlayImage;
    this.overlayImage=new ImageAsset(this.overlayCanvas);
    this.overlayTexture=new Texture2D();this.overlayTexture.image=this.overlayImage;
    this.overlayFrame=new SpriteFrame();this.overlayFrame.texture=this.overlayTexture;this.overlayFrame.packable=false;
    // Resizing Texture2D replaces its GPU view. Rebind a new frame so Sprite's
    // descriptor cannot retain the destroyed view (which rendered a blank bar).
    this.overlay!.getComponent(Sprite)!.spriteFrame=this.overlayFrame;
    oldFrame?.destroy();oldTexture?.destroy();oldImage?.destroy();
    this.overlay!.getComponent(UITransform)!.setContentSize(width,layout.height*scale);
    this.overlay!.setPosition(0,height/2-(layout.top+layout.height/2)*scale);
    this.lastState='';this.sync();
  }

  sync():void {
    if(!this.theme||this.disposed||!this.overlayCanvas)return;
    const error=/失败|点击这里重试/.test(this.message.string),percent=Math.floor(this.theme.progress*100);
    let status=this.message.string;
    if(!error&&this.resourceStatus){
      const resources=this.resourceStatus();
      // Foreground/decode requests gate readiness. Speculative preloads must
      // not hide the actual resource that is holding up startup.
      const waiting=resources.pending.find(item=>!item.preload)??resources.pending[0];
      if(waiting)status+=`\n${waiting.preload?'预下载':'正在加载'}：${waiting.path}\n已等待 ${Math.floor(waiting.elapsedMs/1000)} 秒 · 等待中 ${resources.pending.length} 项`;
      else if(resources.failure)status+=`\n资源失败：${resources.failure.path}\n${resources.failure.reason}`;
    }
    const key=`${percent}:${error}:${status}`;
    if(key===this.lastState)return;
    this.lastState=key;
    const w=this.overlayCanvas.width,h=Math.round(w*this.height/this.width),layout=this.theme.layout(w,h);
    const ctx=this.overlayCanvas.getContext('2d')!;
    ctx.clearRect(0,0,w,this.overlayCanvas.height);
    this.theme.overlay(ctx,w,h,this.theme.progress,error,layout.top,status);
    this.overlayTexture!.uploadData(this.overlayCanvas);
  }

  destroy():void {
    this.resourceStatus=undefined;
    this.disposed=true;this.theme?.hideBrowserCover();
    this.root?.destroy();this.backgroundFrame?.destroy();this.overlayFrame?.destroy();
    this.backgroundTexture?.destroy();this.overlayTexture?.destroy();
    this.backgroundImage?.destroy();this.overlayImage?.destroy();
    // The startup-only source bitmap is no longer retained during gameplay.
    this.theme?.release();
  }
}
