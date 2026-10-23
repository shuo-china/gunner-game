export interface StageCurveKey { time: number; coefficients: number[]; }
export interface StageAnimationBinding {
  node: string; property: 'scale' | 'euler' | 'x' | 'y'; curves: StageCurveKey[][];
}
export interface StageAnimation {
  duration: number; loop: boolean; bindings: StageAnimationBinding[]; source: string;
}

/** Unity streamed coefficients are cubic polynomials relative to each key. */
export function sampleStageCurve(keys: readonly StageCurveKey[], time: number): number {
  let key = keys[0];
  if (!key) throw new Error('Original stage curve has no keys');
  for (let i = 1; i < keys.length && keys[i].time <= time; i++) key = keys[i];
  const t = Math.max(0, time - key.time), c = key.coefficients;
  return ((c[0] * t + c[1]) * t + c[2]) * t + c[3];
}

export function stageAnimationTime(animation: StageAnimation, elapsed: number): number {
  const time = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return animation.loop ? time % animation.duration : Math.min(animation.duration, time);
}

/** RawImage samples UV+offset, so its displayed tiles move against that offset. */
export function stageTextureOffset(speed: number, elapsed: number, tile: number, origin = 0): number {
  const uv = origin + speed * Math.max(0, elapsed);
  return -((uv % 1 + 1) % 1) * tile;
}
