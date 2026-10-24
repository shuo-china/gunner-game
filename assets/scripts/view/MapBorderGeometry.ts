import type { ImageSpec } from './ArtLibrary';
import type { ParticleMeshGeometry } from './OriginalParticleMesh';

export interface MapBorderSeam { shiftPx: number; lipPx: number }

/** Measured at the actual 3–5 px overlap, not the bitmap's last column.
 * These three replacement upper walls have a mismatched lip, while their
 * floor silhouettes already join. Positive values lower the left lip.
 * Keep the source art, anchor, floor edge and the other seven skins intact. */
export const MAP_BORDER_SEAMS: Readonly<Record<number, MapBorderSeam>> = {
  1: { shiftPx: 20.3, lipPx: 250 },
  6: { shiftPx: -7.2, lipPx: 291 },
  9: { shiftPx: 12.3, lipPx: 261 },
};

const smooth = (value: number): number => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

/** A static local mesh. Only the first 64 source pixels bend, fading out
 * above the rail and before the floor. No bitmap resampling, blurred blend,
 * extra material, per-frame geometry work or change to combat coordinates. */
export function createMapBorderGeometry(spec: ImageSpec, seam?: MapBorderSeam): ParticleMeshGeometry {
  const [width, height] = spec.sizePx;
  const columns = [0, 8, 16, 24, 32, 48, 64, width];
  const positions: number[][] = [], uv: number[][] = [], indices: number[] = [];
  for (let row = 0; row <= 16; row++) {
    const y = height * row / 16;
    for (const x of columns) {
      const lip = (seam?.lipPx ?? 0) - x * .577350269;
      const floor = height - x * .577350269;
      const weight = seam ? (1 - smooth(x / 64)) * smooth((y - lip + 64) / 48)
        * (1 - smooth((y - lip - 64) / (floor - lip - 112))) : 0;
      const adjustedY = y + (seam?.shiftPx ?? 0) * weight;
      positions.push([(x / width - spec.anchor[0]) * spec.sizeUnits[0],
        (1 - adjustedY / height - spec.anchor[1]) * spec.sizeUnits[1], 0]);
      uv.push([x / width, 1 - y / height]);
    }
  }
  for (let row = 0; row < 16; row++) for (let column = 0; column < columns.length - 1; column++) {
    const a = row * columns.length + column, b = a + columns.length;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  return { positions, uv, indices };
}
