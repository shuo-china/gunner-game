import { Rect, Size, SpriteFrame } from 'cc';
import type { ArtLibrary } from './ArtLibrary';

interface GlyphAtlasConfig {
  atlas: string;
  frames: Record<string, { rect: [number, number, number, number] }>;
}
interface GlyphAtlasState {
  config:GlyphAtlasConfig;atlas:SpriteFrame;frames:Map<string,SpriteFrame>;users:number;
}
const loaded = new WeakMap<ArtLibrary, GlyphAtlasState>();
const pending = new WeakMap<ArtLibrary, Promise<void>>();

/** One immutable texture for all four original fonts. The ordinary ArtLibrary
 * frame cache is untouched, so non-number sprites retain their source assets. */
export function loadNumberGlyphAtlas(art: ArtLibrary): Promise<void> {
  const existing = pending.get(art);
  if (existing) return existing;
  const request = (async () => {
    const config = await art.json<GlyphAtlasConfig>('art/effects/number-atlas/config');
    const atlas = await art.loadFrame(config.atlas);
    atlas.packable = false;
    // No owned subframes exist during asynchronous loading. A cancelled startup
    // therefore cannot strand them before a number layer claims ownership.
    loaded.set(art, {config,atlas,frames:new Map(),users:0});
  })().catch(error => { pending.delete(art); throw error; });
  pending.set(art, request);
  return request;
}

/** Prepare every glyph before publishing its view. Atlas-covered glyphs need
 * no standalone textures; future/custom glyphs keep their ordinary fallback.
 * Return the actual source frames so callers can protect their ownership. */
export async function prepareNumberGlyphFrames(art:ArtLibrary,paths:readonly string[]):Promise<string[]> {
  if(!paths.length)return [];
  await loadNumberGlyphAtlas(art);
  const state=loaded.get(art)!;
  const standalone=Array.from(new Set(paths)).filter(path=>!state.config.frames[path]);
  await Promise.all(standalone.map(path=>art.loadFrame(path)));
  return [state.config.atlas,...standalone];
}

/** Share the frames across main/mine layers, and free our owned Asset objects
 * when their final parent is destroyed. The source texture stays ArtLibrary's. */
export function retainNumberGlyphAtlas(art:ArtLibrary):()=>void {
  const state=loaded.get(art);
  if(!state)return ()=>{};
  state.users++;
  let released=false;
  return ()=>{
    if(released)return;
    released=true;state.users--;
    if(state.users===0){for(const frame of state.frames.values())frame.destroy();state.frames.clear();}
  };
}

export function numberGlyphFrame(art: ArtLibrary, path: string): SpriteFrame {
  const state=loaded.get(art),entry=state?.config.frames[path];
  if(state&&entry){
    const cached=state.frames.get(path);if(cached)return cached;
    const [x,y,width,height]=entry.rect,frame=new SpriteFrame();
    try {
      frame.texture=state.atlas.texture;frame.rect=new Rect(x,y,width,height);
      frame.originalSize=new Size(width,height);frame.packable=false;
      state.frames.set(path,frame);return frame;
    } catch(error){frame.destroy();throw error;}
  }
  const frame = art.frames.get(path);
  if (!frame) throw new Error(`Missing number glyph: ${path}`);
  return frame;
}
