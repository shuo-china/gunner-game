import { TREE_HIT_SURFACES } from './TreeHitSurfaceData';

interface Point { x: number; y: number }
interface SpriteSurface {
  path: string; sizeUnits: readonly number[]; anchor: readonly number[];
}
/** Move visual feedback to the nearest opaque part of the rendered building.
 * This never moves the gameplay collider or changes the accepted damage. */
export function treeHitSurface(point: Point, sprite: SpriteSurface, origin: Point,
  axisX: Point, axisY: Point): Point {
  const surface = TREE_HIT_SURFACES[sprite.path];
  if (!surface) return point;
  let best = point, bestDistance = Infinity;
  const rowWidth = axisX.x * axisX.x + axisX.y * axisX.y;
  if (rowWidth < 1e-12) return point;
  for (const row of surface.rows) {
    const y = (1 - (row[0] + .5) / surface.height - sprite.anchor[1]) * sprite.sizeUnits[1];
    const baseX = origin.x + axisY.x * y, baseY = origin.y + axisY.y * y;
    const along = ((point.x - baseX) * axisX.x + (point.y - baseY) * axisX.y) / rowWidth;
    for (let i = 1; i < row.length; i += 2) {
      const left = ((row[i] + .5) / surface.width - sprite.anchor[0]) * sprite.sizeUnits[0];
      const right = ((row[i + 1] + .5) / surface.width - sprite.anchor[0]) * sprite.sizeUnits[0];
      const x = Math.max(left, Math.min(right, along));
      const candidate = { x: baseX + axisX.x * x, y: baseY + axisX.y * x };
      const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = candidate; }
    }
  }
  return best;
}
