/** Original PlayerSettings uses Linear; Mobile_RPAsset is LDR, renderScale=.7. */
export const ORIGINAL_WORLD_LAYER = 1 << 19;
export const ORIGINAL_RENDER_SCALE = Math.fround(0.7);
/** Scene Camera 64047 stores this sRGB background; URP converts it to linear. */
export const ORIGINAL_CAMERA_CLEAR = [0.22641509771347046, 0.16476261615753174, 0.09077963978052139, 0] as const;
/** Unity 6000 UniversalCameraData casts the float product to int (rounds down). */
export function originalRenderExtent(pixels:number):number {
  return Math.max(1, Math.floor(Math.fround(pixels * ORIGINAL_RENDER_SCALE)));
}
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

