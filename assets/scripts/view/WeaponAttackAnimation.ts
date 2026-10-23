import { catRecoilWeight, CatDynamics } from './OriginalCatAnimation';

/** Attack overlays are sampled before the simulation reads the projectile origin. */
export type WeaponAnimationCategory = 'bow' | 'crossbow' | 'glove' | 'staff' | 'fan' | 'handgun' | 'cannon';
export interface WeaponAttackState {
  attackInterval: number;
  /** Normalized simulation cooldown, not a second visual attack timer. */
  attackProgress: number;
  willFire: boolean;
  hasTarget: boolean;
}
export interface WeaponAttackPose {
  phase: 'idle' | 'ready' | 'windup' | 'release' | 'recover';
  rightArmRotation: number;
  weaponRotation: number;
  weaponOffset: [number, number];
  weaponScale: [number, number];
  /** Support palm target in the weapon-holding arm's local coordinates. */
  supportGripOffset: [number, number] | null;
  hideHoldingHand: boolean;
  /** Bow-only extension along the aiming arm; preserved by the idle/walk layer. */
  holdingArmReach?: number;
  /** Normalized string and hand pull progress; separated during release. */
  bowStringPull?: number;
  bowHandPull?: number;
  /** Fixed original gun palms; only the holding wrist turns during a cast. */
  staffCast?: StaffCastPose;
}
export interface StaffCastPose {
  time: number;
  holdingRotation: number;
  charge: number;
  flash: number;
}
export const STAFF_PREVIEW_PPU = 22.1645031;
/** Registration on a stringless bow sprite, in top-left source pixels. */
export interface BowStringSpec {
  upperPx: [number, number];
  lowerPx: [number, number];
  bracePx: [number, number];
  drawPx: number;
  /** Move the drawing arm's aim target backward without moving the bow. */
  handRetreatPx?: number;
  color?: [number, number, number, number];
  lineWidthPx?: number;
}
export function bowStringPoints(spec: BowStringSpec,
  pose: Pick<WeaponAttackPose, 'bowStringPull' | 'bowHandPull'> & {phase?: WeaponAttackPose['phase']}, drawScale = 1): {
  upper: [number, number]; lower: [number, number]; nock: [number, number]; hand: [number, number];
} {
  const retreat = spec.handRetreatPx ?? 0;
  // Battle travel can be tuned without changing the artwork registration or
  // the full-draw span used to size the holding-hand orbit.
  const travel = spec.drawPx * drawScale;
  // On release only the string springs to its original brace. The drawing
  // arm keeps aiming at the held point before its target returns to the brace.
  const held = pose.phase === 'release' ? 0 : pose.phase === 'recover' ? 1 - (pose.bowHandPull ?? 0) : 1;
  return { upper: spec.upperPx, lower: spec.lowerPx,
    nock: [spec.bracePx[0] - retreat * held - travel * (pose.bowStringPull ?? 0), spec.bracePx[1]],
    hand: [spec.bracePx[0] - retreat - travel * (pose.bowHandPull ?? 0), spec.bracePx[1]] };
}
const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const smooth = (value: number): number => { const t = clamp01(value); return t * t * (3 - 2 * t); };
// Retain the accepted spotlight study's rotation and effects rhythm. Both
// palms stay at the original gun positions throughout the complete cycle.
const STAFF_KEYS = [
  { t: 0, angle: -78 },
  { t: .08, angle: -78 },
  { t: .21, angle: -72 },
  { t: .29, angle: -26 },
  { t: .35, angle: -26 },
  { t: .57, angle: -78 },
  { t: .60, angle: -78 },
];

function applyStaffCast(pose: WeaponAttackPose, state: WeaponAttackState, interval: number, elapsed: number): void {
  // Rotate the preview cycle so its .29-second release coincides with the
  // simulation's fire event. Recovery also finishes when the target vanishes.
  // A first shot jumps straight to release instead of delaying combat.
  const afterRelease = elapsed * .6 / interval;
  const returning = Number.isFinite(elapsed) && afterRelease < .31;
  const time = state.willFire ? .29 : returning ? .29 + afterRelease :
    state.hasTarget ? Math.min(.29 - 1e-9, Math.max(0, clamp01(state.attackProgress) * .6 - .31)) : 0;
  let index = 0;
  while (index < STAFF_KEYS.length - 2 && time > STAFF_KEYS[index + 1].t) index++;
  const a = STAFF_KEYS[index], b = STAFF_KEYS[index + 1], blend = smooth((time - a.t) / (b.t - a.t));
  const charge = time < .29 ? smooth((time - .08) / .15) : 0;
  pose.weaponRotation = a.angle + (b.angle - a.angle) * blend;
  pose.staffCast = { time, holdingRotation: pose.weaponRotation - STAFF_KEYS[0].angle, charge,
    flash: returning && afterRelease < .065 ? Math.sin(Math.PI * afterRelease / .065) : 0 };
  pose.phase = state.willFire ? 'release' : returning && time < .57 ? 'recover' :
    charge > 0 ? 'windup' : state.hasTarget ? 'ready' : 'idle';
}
type WeaponRecoil = CatDynamics['recoil'];
// CatView supplies the extracted rig/weapon definition. These source floats
// also keep standalone preview/pose sampling consistent with the game.
const SOURCE_GUN_RECOIL: WeaponRecoil = {
  duration: Math.fround(.2), position: [Math.fround(-.6), 0], gunScale: [Math.fround(.7), Math.fround(1.1)],
};

/** Pure pose calculation; never changes fire cadence, damage or projectile count. */
export function sampleWeaponAttack(category: WeaponAnimationCategory, state: WeaponAttackState, sinceRelease = Infinity,
  recoil: WeaponRecoil = SOURCE_GUN_RECOIL): WeaponAttackPose {
  const interval = Number.isFinite(state.attackInterval) && state.attackInterval > 0 ? state.attackInterval : .6;
  const recoveryDuration = Math.min(category === 'cannon' ? .28 : .19, interval * .42);
  const elapsed = Math.max(0, sinceRelease);
  // Two smooth legs give a distinct follow-through without a delayed first shot.
  const recover = state.willFire || !Number.isFinite(elapsed) || elapsed >= recoveryDuration ? 0 :
    elapsed < recoveryDuration * .25 ? smooth(elapsed / (recoveryDuration * .25)) :
      1 - smooth((elapsed - recoveryDuration * .25) / (recoveryDuration * .75));
  const windup = state.hasTarget && !state.willFire ? smooth((clamp01(state.attackProgress) - .48) / .52) : 0;
  const pose: WeaponAttackPose = {
    phase: state.willFire ? 'release' : recover > 0 ? 'recover' : windup > 0 ? 'windup' : state.hasTarget ? 'ready' : 'idle',
    rightArmRotation: 0, weaponRotation: 0, weaponOffset: [0, 0], weaponScale: [1, 1],
    supportGripOffset: null, hideHoldingHand: category === 'glove',
  };
  switch (category) {
    case 'bow': {
      // Keep the bow-holding palm and bow body fixed. The string and drawing
      // hand pull back; CatView anchors the hand's starting point on the body.
      // On the firing frame the string releases before the hand returns.
      const draw = state.hasTarget && !state.willFire ? smooth((clamp01(state.attackProgress) - .38) / .58) : 0;
      const returnDuration = Math.min(.16, interval * .35);
      const returning = Number.isFinite(elapsed) && elapsed < returnDuration;
      const t = clamp01(elapsed / returnDuration);
      pose.holdingArmReach = 4.8;
      pose.bowStringPull = state.willFire ? 0 : returning ? .075 * Math.sin(t * Math.PI * 4) * (1 - t) ** 2 : draw;
      pose.bowHandPull = state.willFire ? 1 : returning ? 1 - smooth((t - .2) / .8) : draw;
      pose.phase = state.willFire ? 'release' : returning ? 'recover' : draw > 0 ? 'windup' : state.hasTarget ? 'ready' : 'idle';
      pose.supportGripOffset = [-.32 - .92 * pose.bowHandPull, .05];
      break;
    }
    case 'crossbow':
    case 'glove': {
      // Source gun recoil is a linear compression/return along its firing
      // axis, not a wrist swing. Sample it once per volley before firing.
      const duration = Math.min(recoil.duration, interval * .8);
      const pulse = state.willFire ? 0 : catRecoilWeight(elapsed, duration);
      pose.weaponOffset = [recoil.position[0] * pulse, recoil.position[1] * pulse];
      pose.weaponScale = [1 + (recoil.gunScale[0] - 1) * pulse, 1 + (recoil.gunScale[1] - 1) * pulse];
      pose.phase = state.willFire ? 'release' : pulse > 0 ? 'recover' : state.hasTarget ? 'ready' : 'idle';
      // The source gun support arm rotates toward Gun_Pivot. Its position
      // remains on the original Idle/Walk bone rather than tracking artwork.
      break;
    }
    case 'staff':
      applyStaffCast(pose, state, interval, elapsed);
      break;
    case 'fan':
      pose.rightArmRotation = -30 * windup + 27 * recover;
      pose.weaponRotation = -12 * windup + 18 * recover;
      pose.weaponOffset = [.18 * recover, .1 * windup];
      break;
    case 'handgun':
      pose.rightArmRotation = 7 * recover;
      pose.weaponRotation = 3 * recover;
      pose.weaponOffset = [-.32 * recover, 0];
      break;
    case 'cannon':
      pose.rightArmRotation = 10 * recover;
      pose.weaponRotation = 3 * recover;
      pose.weaponOffset = [-.65 * recover, -.08 * recover];
      pose.supportGripOffset = [1.1, -.12];
      break;
  }
  return pose;
}

/** Each actor owns this clock. willFire synchronizes the release, including a first shot. */
export class WeaponAttackAnimator {
  private sinceRelease = Infinity;
  reset(): void { this.sinceRelease = Infinity; }
  sample(category: WeaponAnimationCategory, state: WeaponAttackState, dt: number, recoil?: WeaponRecoil): WeaponAttackPose {
    if (state.willFire) this.sinceRelease = 0;
    else if (Number.isFinite(this.sinceRelease)) this.sinceRelease += Math.max(0, Number.isFinite(dt) ? dt : 0);
    const pose = sampleWeaponAttack(category, state, this.sinceRelease, recoil);
    const interval = Number.isFinite(state.attackInterval) && state.attackInterval > 0 ? state.attackInterval : .6;
    // At high attack speed the whole sine pulse can fall between two samples.
    // Show its peak on the real release frame in that case; do not invent a
    // second clock, hold a stale flash, or delay the simulation's shot.
    if (pose.staffCast && state.willFire && Number.isFinite(dt) && dt >= interval * .065 / .6)
      pose.staffCast.flash = 1;
    return pose;
  }
}
