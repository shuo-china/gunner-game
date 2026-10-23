import type { ScreenPoint, Vec2 } from './types';

/** Cat.Update / HandleMovement, constant at ELF VA 0x106c200. */
export const MANUAL_INPUT_SQUARED_THRESHOLD = Math.fround(0.0001);
const SCREEN_SPEED_K = Math.fround(1.2);

/** Joystick.HandleInput: preserve analog magnitude inside the unit circle. */
export function clampMovementInput(input: Readonly<ScreenPoint>): ScreenPoint {
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return { x: 0, y: 0 };
  const magnitude = Math.hypot(input.x, input.y);
  const divisor = Math.max(1, magnitude);
  return { x: input.x / divisor, y: input.y / divisor };
}

/** Quaternion.Euler(0,-45,0) * (Horizontal,0,Vertical).
 * Face rotation uses this unscaled direction, not the movement velocity. */
export function manualLookDirection(input: Readonly<ScreenPoint>): Vec2 {
  return { x: Math.SQRT1_2 * (input.x - input.y), z: Math.SQRT1_2 * (input.x + input.y) };
}

/** Cat.HandleMovement ARM64 0x2b3add8..2b3ae3c: X/K, Z*K, rotate, speed.
 * Do not normalize again or apply automatic movement's screenSpeedMultiplier. */
export function manualVelocity(input: Readonly<ScreenPoint>, speed: number): Vec2 {
  const direction = manualLookDirection({ x: input.x / SCREEN_SPEED_K, y: input.y * SCREEN_SPEED_K });
  return { x: direction.x * speed, z: direction.z * speed };
}
