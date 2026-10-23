/** Cat Gunner's libunity.so Mathf.PerlinNoise: wrapper 0x529748,
 * kernel 0xd9c308, permutation at 0x1fcce0. The shipped engine takes absolute
 * coordinates and normalizes by (noise + float32(.69)) / float32(1.483).
 * Keep each ARM64 float operation; the usual (noise + 1) / 2 changes the map. */
const permutation = [151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180];
const p = permutation.concat(permutation), f = Math.fround;
function gradient(hash: number, x: number, y: number): number {
  const u = (hash & 8) === 0 ? x : y;
  const v = (hash & 12) === 0 ? y : (hash & 13) === 12 ? x : 0;
  return f(((hash & 1) === 0 ? u : -u) + ((hash & 2) === 0 ? v : -v));
}
function fade(t: number): number { return f(f(t * f(t * t)) * f(f(t * f(f(t * 6) - 15)) + 10)); }
function lerp(a: number, b: number, t: number): number { return f(a + f(t * f(b - a))); }
export function minePerlinNoise(x: number, y: number): number {
  x = Math.abs(f(x)); y = Math.abs(f(y));
  const ix = Math.trunc(x), iy = Math.trunc(y), xx = ix & 255, yy = iy & 255;
  x = f(x - f(ix)); y = f(y - f(iy));
  const a = p[xx] + yy, b = p[xx + 1] + yy, xm = f(x - 1), ym = f(y - 1);
  const u = fade(Math.min(1, x)), v = fade(Math.min(1, y));
  const low = lerp(gradient(p[p[a]], x, y), gradient(p[p[b]], xm, y), u);
  const high = lerp(gradient(p[p[a + 1]], x, ym), gradient(p[p[b + 1]], xm, ym), u);
  return f(f(lerp(low, high, v) + f(.69)) / f(1.483));
}

/** System.Random's subtractive generator, used by Mine_manager.PlaceOres for
 * both noise offsets and the partial Fisher-Yates rare-ore selection. */
export class MineRandom {
  private readonly values = new Array<number>(56).fill(0);
  private nextIndex = 0;
  private nextPrime = 21;
  constructor(seed: number) {
    const n = seed | 0, subtraction = n === -2147483648 ? 2147483647 : Math.abs(n);
    let mj = 161803398 - subtraction, mk = 1;
    this.values[55] = mj;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55; this.values[ii] = mk; mk = mj - mk;
      if (mk < 0) mk += 2147483647; mj = this.values[ii];
    }
    for (let pass = 0; pass < 4; pass++) for (let i = 1; i < 56; i++) {
      this.values[i] -= this.values[1 + (i + 30) % 55];
      if (this.values[i] < 0) this.values[i] += 2147483647;
    }
  }
  next(): number {
    if (++this.nextIndex >= 56) this.nextIndex = 1;
    if (++this.nextPrime >= 56) this.nextPrime = 1;
    let result = this.values[this.nextIndex] - this.values[this.nextPrime];
    if (result === 2147483647) result--;
    if (result < 0) result += 2147483647;
    this.values[this.nextIndex] = result; return result / 2147483647;
  }
  range(min: number, max: number): number { return Math.floor(this.next() * (max - min)) + min; }
}
