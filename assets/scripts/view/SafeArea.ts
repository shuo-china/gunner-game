export interface SafeAreaInsets { top: number; bottom: number; }
export interface SafeAreaHost {
  getWindowInfo?(): unknown;
  getSystemInfoSync?(): unknown;
}
interface Viewport { width: number; height: number; }
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' ? value as RecordValue : undefined;
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function positive(value: unknown): value is number { return finite(value) && value > 0; }

/** Notches and navigation bars are edge strips, never a large part of the playfield.
 * Reject a corrupt edge independently instead of clamping it into a large blank band.
 * This generous bound includes normal notches/home indicators on short portrait screens. */
function edge(value: number, viewport: Viewport): number | undefined {
  return finite(value) && value >= 0 && value <= Math.min(viewport.width, viewport.height) / 4 ? value : undefined;
}

function windowInsets(viewport: Viewport, value: unknown): SafeAreaInsets | undefined {
  const info = record(value);
  if (!info || !positive(info.windowWidth) || !positive(info.windowHeight)) return;
  // WeChat window/safeArea values use logical pixels. Convert once to the actual
  // Canvas size; multiplying by pixelRatio here would count the device scale twice.
  const scale = viewport.height / info.windowHeight;
  const screenTop = finite(info.screenTop) && info.screenTop >= 0 ? info.screenTop : 0;
  const statusTop = finite(info.statusBarHeight)
    ? edge(Math.max(0, info.statusBarHeight - screenTop) * scale, viewport) ?? 0 : 0;
  const safe = record(info.safeArea);
  if (!safe || !finite(safe.top) || !finite(safe.bottom) || safe.top < 0 || safe.bottom <= safe.top) {
    return { top: statusTop, bottom: 0 };
  }
  if ((safe.height !== undefined && (!positive(safe.height) || Math.abs(safe.height - (safe.bottom - safe.top)) > 1)) ||
    (safe.width !== undefined && !positive(safe.width)) ||
    (safe.left !== undefined && (!finite(safe.left) || safe.left < 0)) ||
    (safe.right !== undefined && (!finite(safe.right) || safe.right <= (finite(safe.left) ? safe.left : 0))) ||
    (finite(safe.width) && finite(safe.left) && finite(safe.right) && Math.abs(safe.width - (safe.right - safe.left)) > 1)) {
    return { top: statusTop, bottom: 0 };
  }
  // safeArea uses screen coordinates (top-left origin); a window can start below
  // the status bar. Only reserve the intersection with that window.
  const top = edge(Math.max(0, safe.top - screenTop) * scale, viewport) ?? statusTop;
  const bottom = edge(Math.max(0, info.windowHeight + screenTop - safe.bottom) * scale, viewport) ?? 0;
  return { top, bottom };
}

/** One validated layout boundary for immediate, deferred and background-created UI. */
export function resolveSafeAreaInsets(viewport: Viewport, readEngineRect: () => unknown,
  host?: SafeAreaHost): SafeAreaInsets {
  if (!positive(viewport.width) || !positive(viewport.height)) return { top: 0, bottom: 0 };
  if (host) {
    for (const read of [host.getWindowInfo, host.getSystemInfoSync]) {
      if (typeof read !== 'function') continue;
      try {
        const insets = windowInsets(viewport, read.call(host));
        if (insets) return insets;
      } catch (_) { /* Older hosts may expose an unavailable newer API. */ }
    }
  }
  // Creator already returns design units with a bottom-left origin. Keep this
  // path for web/native and unavailable host APIs; do not apply DPR again.
  try {
    const safe = record(readEngineRect());
    if (safe && finite(safe.y) && positive(safe.width) && positive(safe.height)) {
      return {
        top: edge(Math.max(0, viewport.height - safe.y - safe.height), viewport) ?? 0,
        bottom: edge(Math.max(0, safe.y), viewport) ?? 0,
      };
    }
  } catch (_) { /* Invalid platform metrics must not abort game/UI creation. */ }
  return { top: 0, bottom: 0 };
}
