import { ArtLibrary, ImageSpec } from './ArtLibrary';

export interface TreeAppearanceConfig {
  projectionScaleY: number;
  hit: { duration: number; peakScale: [number, number] };
  healthBar: {
    position: [number, number]; scale: [number, number];
    background: ImageSpec; fill: ImageSpec; fillColor: [number, number, number, number];
  };
}

export interface TargetReticleConfig {
  sprite: ImageSpec;
  height: number;
  scale: [number, number];
  planeQuaternion: [number, number, number, number];
  degreesPerSecond: number;
}

export interface OriginalFeedbackConfig {
  tree: TreeAppearanceConfig;
  reticle: TargetReticleConfig;
}

/** Separate source-derived feedback assets, so character/catalog conversion cannot overwrite them. */
export async function loadOriginalFeedback(art: ArtLibrary): Promise<OriginalFeedbackConfig> {
  const config: OriginalFeedbackConfig = await art.json('art/effects/original_feedback/config');
  const images = [config.tree.healthBar.background, config.tree.healthBar.fill, config.reticle.sprite];
  await Promise.all(images.map(spec => art.loadFrame(spec.path)));
  return config;
}
