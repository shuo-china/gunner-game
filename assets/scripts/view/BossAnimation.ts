import { CatCurveKey, sampleCatChannel, catAngleDelta } from './OriginalCatAnimation';

export interface BossBone { path: string; parent: string | null; position: number[]; scale: number[]; rotation: number[]; }
export interface BossClip {
  duration: number; loop: boolean; channels: Record<string, CatCurveKey[]>;
  bindings: { bone: string; property: 'position' | 'scale' | 'euler'; firstChannel: number }[];
}
export interface BossBonePose { x: number; y: number; sx: number; sy: number; angle: number; }
type State = 'idle' | 'walk' | 'death';

/** Original controller 301: streamed cubic channels plus the constant leg tracks
 * in clip268; transitions use fixed .25 seconds and start the new clip at zero. */
export class BossAnimator {
  state: State = 'idle'; clock = 0;
  previous: State | null = null; previousClock = 0; blendTime = 0;
  constructor(readonly clips: Record<string, BossClip>, readonly transitionDuration = .25) {}
  update(dt: number, moving: boolean, alive: boolean): void {
    const state: State = !alive ? 'death' : moving ? 'walk' : 'idle';
    if (state !== this.state && (!this.previous || state === 'death')) {
      this.previous = this.state; this.previousClock = this.clock;
      this.state = state; this.clock = 0; this.blendTime = 0;
    }
    this.clock += dt;
    if (this.previous) {
      this.previousClock += dt; this.blendTime += dt;
      if (this.blendTime >= this.transitionDuration) this.previous = null;
    }
  }
  pose(bone: BossBone): BossBonePose {
    const next = sampleBossBone(this.clips[this.state], this.clock, bone);
    if (!this.previous) return next;
    const old = sampleBossBone(this.clips[this.previous], this.previousClock, bone);
    const t = Math.min(1, this.blendTime / this.transitionDuration);
    return { x: old.x + (next.x - old.x) * t, y: old.y + (next.y - old.y) * t,
      sx: old.sx + (next.sx - old.sx) * t, sy: old.sy + (next.sy - old.sy) * t,
      angle: old.angle + catAngleDelta(old.angle, next.angle) * t };
  }
}

export function sampleBossBone(clip: BossClip, clock: number, bone: BossBone): BossBonePose {
  const time = clip.loop ? Math.max(0, clock) % clip.duration : Math.max(0, Math.min(clip.duration, clock));
  const [qx, qy, qz, qw] = bone.rotation;
  const pose = { x: bone.position[0], y: bone.position[1], sx: bone.scale[0], sy: bone.scale[1],
    angle: Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)) * 180 / Math.PI };
  for (const binding of clip.bindings) {
    if (binding.bone !== bone.path) continue;
    const sample = (axis: number): number => sampleCatChannel(clip.channels[binding.firstChannel + axis], time);
    if (binding.property === 'position') { pose.x = sample(0); pose.y = sample(1); }
    else if (binding.property === 'scale') { pose.sx = sample(0); pose.sy = sample(1); }
    else pose.angle = sample(2);
  }
  return pose;
}
