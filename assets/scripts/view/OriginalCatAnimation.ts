/** Pure playback of Cat controller :300 and streamed clips :263/:264. */
export interface CatBonePose { p: [number, number]; r: number; s: [number, number] }
export interface CatCurveKey { time: number; coefficients: [number, number, number, number] }
export interface CatCurveBinding {
  bone: number; property: 'position' | 'scale' | 'euler'; firstChannel: number;
}
export interface CatClip {
  duration: number;
  sampleRate: number;
  frames: CatBonePose[][];
  loop?: boolean;
  cubicCurves?: { bindings: CatCurveBinding[]; channels: Record<string, CatCurveKey[]> };
}
export interface CatAnimatorSettings {
  idleSpeed: number; walkSpeed: number; transitionDuration: number;
  hasFixedDuration: boolean; hasExitTime: boolean; transitionOffset: number;
  interruptionSource: number; idleCycleOffset: number; walkCycleOffset: number;
}
export interface CatDynamics {
  handRestAngle: number; handRotateSpeed: number; leftHandBone: number;
  faceRotateSpeed: number; faceAngleRange: [number, number];
  facePivot: { position: [number, number]; radius: number };
  animator: CatAnimatorSettings;
  recoil: { duration: number; position: [number, number]; gunScale: [number, number] };
}
type AnimationName = 'idle' | 'walk';
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Mathf.DeltaAngle keeps the exact 180-degree tie positive. */
export const catAngleDelta = (a: number, b: number): number => {
  const delta = ((b - a) % 360 + 360) % 360;
  return delta > 180 ? delta - 360 : delta;
};

/** Coefficients are the original Unity streamed cubic, not fitted keyframes. */
export function sampleCatChannel(keys: CatCurveKey[], time: number): number {
  let low = 0, high = keys.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (keys[middle].time <= time) low = middle;
    else high = middle;
  }
  const key = keys[low], [a, b, c, d] = key.coefficients, t = time - key.time;
  return ((a * t + b) * t + c) * t + d;
}

export function sampleCatPose(clip: CatClip, clock: number, bone: number,
  pose: CatBonePose = { p: [0, 0], r: 0, s: [1, 1] }): CatBonePose {
  const time = clip.loop === false ? Math.max(0, Math.min(clip.duration, clock))
    : ((clock % clip.duration) + clip.duration) % clip.duration;
  // Frame zero retains serialized Transform defaults for channels not animated
  // by this clip (the original states both have Write Defaults enabled).
  const first = clip.frames[0][bone];
  pose.p[0] = first.p[0]; pose.p[1] = first.p[1]; pose.r = first.r;
  pose.s[0] = first.s[0]; pose.s[1] = first.s[1];
  if (clip.cubicCurves) {
    const channels = clip.cubicCurves.channels;
    for (const binding of clip.cubicCurves.bindings) {
      if (binding.bone !== bone) continue;
      if (binding.property === 'euler') pose.r = sampleCatChannel(channels[binding.firstChannel + 2], time);
      else {
        const values = binding.property === 'position' ? pose.p : pose.s;
        values[0] = sampleCatChannel(channels[binding.firstChannel], time);
        values[1] = sampleCatChannel(channels[binding.firstChannel + 1], time);
      }
    }
    return pose;
  }
  // Replacement rigs may still supply only baked animation frames.
  const frame = time * clip.sampleRate, index = Math.min(Math.floor(frame), clip.frames.length - 1), t = frame - index;
  const a = clip.frames[index][bone], b = clip.frames[Math.min(index + 1, clip.frames.length - 1)][bone];
  pose.p[0] = lerp(a.p[0], b.p[0], t); pose.p[1] = lerp(a.p[1], b.p[1], t);
  pose.r = a.r + catAngleDelta(a.r, b.r) * t;
  pose.s[0] = lerp(a.s[0], b.s[0], t); pose.s[1] = lerp(a.s[1], b.s[1], t);
  return pose;
}

/** Both transitions are 0.25 real seconds, no exit time and no interruption.
 * The outgoing walk continues advancing during a stop blend. Do not freeze its
 * feet or preserve the destination phase: each transition's offset is zero.
 */
export class OriginalCatAnimator {
  animation: AnimationName = 'idle';
  clock = 0;
  previousAnimation: AnimationName | null = null;
  previousClock = 0;
  transitionTime = 0;
  private readonly blendPose: CatBonePose = { p: [0, 0], r: 0, s: [1, 1] };

  constructor(private readonly clips: { idle: CatClip; walk: CatClip }, private readonly settings: CatAnimatorSettings) {
    if (!settings.hasFixedDuration || settings.hasExitTime || settings.interruptionSource !== 0) {
      throw new Error('Unsupported Cat controller transition; recheck the original controller export.');
    }
    this.reset();
  }

  reset(): void {
    this.animation = 'idle'; this.clock = this.settings.idleCycleOffset * this.clips.idle.duration;
    this.previousAnimation = null; this.previousClock = 0; this.transitionTime = 0;
  }

  update(dt: number, walk: boolean): void {
    const name = walk ? 'walk' : 'idle';
    if (name !== this.animation && this.previousAnimation === null) {
      this.previousAnimation = this.animation; this.previousClock = this.clock; this.transitionTime = 0;
      this.animation = name;
      const cycleOffset = name === 'walk' ? this.settings.walkCycleOffset : this.settings.idleCycleOffset;
      this.clock = (this.settings.transitionOffset + cycleOffset) * this.clips[name].duration;
    }
    this.clock += dt * (this.animation === 'walk' ? this.settings.walkSpeed : this.settings.idleSpeed);
    if (this.previousAnimation !== null) {
      this.previousClock += dt * (this.previousAnimation === 'walk' ? this.settings.walkSpeed : this.settings.idleSpeed);
      this.transitionTime += dt;
      if (this.transitionTime >= this.settings.transitionDuration) this.previousAnimation = null;
    }
  }

  pose(bone: number, out?: CatBonePose): CatBonePose {
    const current = sampleCatPose(this.clips[this.animation], this.clock, bone, out);
    if (this.previousAnimation === null) return current;
    const previous = sampleCatPose(this.clips[this.previousAnimation], this.previousClock, bone, this.blendPose);
    const blend = this.transitionTime / this.settings.transitionDuration;
    current.p[0] = lerp(previous.p[0], current.p[0], blend); current.p[1] = lerp(previous.p[1], current.p[1], blend);
    current.r = previous.r + catAngleDelta(previous.r, current.r) * blend;
    current.s[0] = lerp(previous.s[0], current.s[0], blend); current.s[1] = lerp(previous.s[1], current.s[1], blend);
    return current;
  }
}

/** Bounce_Custom / Bounce_Position MoveNext use two linear half-duration legs. */
export function catRecoilWeight(elapsed: number, duration: number): number {
  return elapsed >= 0 && elapsed < duration ? 1 - Math.abs(elapsed / (duration * .5) - 1) : 0;
}

// ARM64 float at ELF VA 0x0106c200, used by UpdateFaceRotation/UpdateHandRotation.
export const CAT_DIRECTION_SQUARED_THRESHOLD = 9.999999747378752e-5;

/** Cat.CalcBulletSpawnPos projects Shoot_trans along Cat's fixed 40-degree
 * CamDir to Y=2. CamDir is not the rendered camera's 35.264-degree forward.
 * The displayed rig has already mirrored X; its Y is the billboard-plane Y
 * foreshortened by the camera/billboard pitch difference. Any component along
 * the plane normal cancels when projecting along that same normal to height.
 */
export function originalBulletSpawnOffset(socket: {x:number;y:number}, projectionScaleY: number,
  height: number): {x:number;z:number} {
  const sine = Math.sin(40 * Math.PI / 180), cosine = Math.cos(40 * Math.PI / 180);
  const planeY = socket.y / projectionScaleY;
  const muzzleX = Math.SQRT1_2 * (socket.x - sine * planeY);
  const muzzleY = cosine * planeY;
  const muzzleZ = Math.SQRT1_2 * (socket.x + sine * planeY);
  const distance = (height - muzzleY) / -sine;
  return { x: muzzleX - Math.SQRT1_2 * cosine * distance,
    z: muzzleZ + Math.SQRT1_2 * cosine * distance };
}
