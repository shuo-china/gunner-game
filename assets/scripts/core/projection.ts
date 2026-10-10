import { ScreenPoint, Vec2 } from './types';

/** Main camera basis, measured from the original serialized quaternion. */
export const CAMERA_BASIS = {
  rightX: 0.7071067796452598,
  rightZ: 0.7071068328480861,
  upX: -0.4082444121793012,
  upY: 0.8165004704498066,
  upZ: 0.4082444440367463,
  forwardX: -0.5773530748033027,
  forwardY: -0.5773448069936156,
  forwardZ: 0.5773530143110772,
} as const;

export function projectWorld(position: Vec2, height = 0): ScreenPoint {
  return {
    x: CAMERA_BASIS.rightX * position.x + CAMERA_BASIS.rightZ * position.z,
    y: CAMERA_BASIS.upX * position.x + CAMERA_BASIS.upZ * position.z + CAMERA_BASIS.upY * height,
  };
}

export function unprojectGround(point: ScreenPoint): Vec2 {
  const a = CAMERA_BASIS.rightX, b = CAMERA_BASIS.rightZ;
  const c = CAMERA_BASIS.upX, d = CAMERA_BASIS.upZ;
  const determinant = a * d - b * c;
  return { x: (d * point.x - b * point.y) / determinant, z: (-c * point.x + a * point.y) / determinant };
}

/** Original Cat.ScreenSpeedMultiplier, including ScreenSpeedK = 1.2. */
export function screenSpeedMultiplier(direction: Vec2): number {
  // Cat uses its static CamCorrection (+45 degrees) and CamPitchSin;
  // these are intentionally separate from the serialized camera quaternion.
  const x = Math.SQRT1_2 * (direction.x + direction.z);
  const z = Math.SQRT1_2 * (direction.z - direction.x);
  const magnitude = Math.hypot(x, z * Math.fround(0.57735026));
  return magnitude >= Math.fround(0.0001) ? (1 / Math.fround(1.2)) / magnitude : 1;
}
