import { CAMERA_BASIS } from '../core/projection';

export interface PlaneMatrix { a: number; b: number; c: number; d: number }

/** Source particle gradients; optional output avoids per-particle array allocations. */
export function sampleParticleStops(keys:readonly (readonly number[])[],t:number,out:number[]=[]):number[] {
  let first=keys[0],second=first,u=0;
  if(t>first[0]) {
    first=keys[keys.length-1];second=first;
    for(let i=1;i<keys.length;i++)if(t<=keys[i][0]) {
      first=keys[i-1];second=keys[i];u=(t-first[0])/(second[0]-first[0]);break;
    }
  }
  out.length=first.length-1;
  for(let i=1;i<first.length;i++)out[i-1]=first[i]+(second[i]-first[i])*u;
  return out;
}

/** Camera projection of the original Unity sprite's local X/Y axes. */
export function projectedSpritePlane(q: readonly number[]): PlaneMatrix {
  const [x, y, z, w] = q;
  const xx = 1 - 2 * (y * y + z * z), xy = 2 * (x * y + z * w), xz = 2 * (x * z - y * w);
  const yx = 2 * (x * y - z * w), yy = 1 - 2 * (x * x + z * z), yz = 2 * (y * z + x * w);
  const p = CAMERA_BASIS;
  return {
    a: p.rightX * xx + p.rightZ * xz,
    b: p.rightX * yx + p.rightZ * yz,
    c: p.upX * xx + p.upY * xy + p.upZ * xz,
    d: p.upX * yx + p.upY * yy + p.upZ * yz,
  };
}

/** A = rotation(outer) * scale(x,y) * rotation(inner), including projection shear. */
export function decomposeProjectedPlane(m: PlaneMatrix): { outer: number; x: number; y: number; inner: number } {
  const angle = .5 * Math.atan2(2 * (m.a * m.c + m.b * m.d), m.a * m.a + m.b * m.b - m.c * m.c - m.d * m.d);
  const c = Math.cos(angle), s = Math.sin(angle);
  const rowX = c * m.a + s * m.c, rowY = c * m.b + s * m.d;
  const x = Math.hypot(rowX, rowY);
  return { outer: angle * 180 / Math.PI, x, y: (m.a * m.d - m.b * m.c) / x,
    inner: Math.atan2(-rowY, rowX) * 180 / Math.PI };
}

/** Bounce_Custom uses two clamped linear lerps, not a sinusoid or an angle. */
export function originalBounceScale(elapsed: number, duration: number, peak: readonly number[]): { x: number; y: number } {
  const half = duration * .5;
  const amount = elapsed <= half ? elapsed / half : (duration - elapsed) / half;
  const t = Math.max(0, Math.min(1, amount));
  return { x: 1 + (peak[0] - 1) * t, y: 1 + (peak[1] - 1) * t };
}

/** DamageTextAnimationCurve.Bake/EvalBaked uses 65 samples and linear interpolation. */
export function sampleOriginalDamageCurve(values: readonly number[], t: number): number {
  const last = values.length - 1;
  const u = Math.max(0, Math.min(1, t)) * last;
  const i = Math.min(last - 1, Math.floor(u));
  return values[i] + (values[i + 1] - values[i]) * (u - i);
}

/** DoAnimation stores raw curve values but only rebuilds changed mesh channels.
 * Its dirty keys are signed movement*8 cast to ushort and scale*64 cast to byte.
 * They control redraws; they must not quantize the values used for vertices.
 */
export function originalDamageDirtyKeys(x: number, y: number, scale: number): number[] {
  return [Math.trunc(x * 8) & 0xffff, Math.trunc(y * 8) & 0xffff,
    Math.trunc(Math.max(0, Math.min(255, scale * 64)))];
}

/** CanSpawnText buckets world X/Y (not the ground X/Z) using Mathf.RoundToInt. */
export function originalDamageBucket(x: number, y: number, bucketSize = 1.5): string {
  const round = (value: number): number => {
    const v = Math.fround(Math.fround(value) / bucketSize), lower = Math.floor(v);
    return v - lower === .5 ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(v);
  };
  return `${round(x)},${round(y)}`;
}
