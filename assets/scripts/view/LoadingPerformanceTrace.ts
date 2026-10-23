interface FrameSample { frame: number; atMs: number; intervalMs: number; }
interface PhaseSample { frame: number; atMs: number; feature: string; phase: string; workMs: number; }

/** Bounded, allocation-free frame recording. Copies are made only on demand.
 * CPU timings do not measure GPU execution or infer garbage collections. */
export class LoadingPerformanceTrace {
  private readonly frames: FrameSample[] = Array.from({ length: 1024 }, () => ({ frame: 0, atMs: 0, intervalMs: 0 }));
  private readonly events: PhaseSample[] = Array.from({ length: 512 }, () => ({ frame: 0, atMs: 0, feature: '', phase: '', workMs: 0 }));
  private frameCount = 0;
  private eventCount = 0;
  constructor(private readonly now: () => number = Date.now) {}

  frame(dt: number): void {
    const sample = this.frames[this.frameCount % this.frames.length];
    sample.frame = ++this.frameCount; sample.atMs = this.now();
    sample.intervalMs = Number.isFinite(dt) ? Math.max(0, dt * 1000) : 0;
  }

  mark(feature: string, phase: string, workMs = 0): void {
    const sample = this.events[this.eventCount++ % this.events.length];
    sample.frame = this.frameCount; sample.atMs = this.now(); sample.feature = feature; sample.phase = phase;
    sample.workMs = Number.isFinite(workMs) ? Math.max(0, workMs) : 0;
  }

  measure<T>(feature: string, phase: string, work: () => T): T {
    const started = this.now();
    try { return work(); } finally { this.mark(feature, phase, this.now() - started); }
  }

  snapshot() {
    const ordered = <T>(items: T[], count: number): T[] => {
      const length = Math.min(count, items.length), start = count >= items.length ? count % items.length : 0;
      return Array.from({ length }, (_, index) => ({ ...items[(start + index) % items.length] }));
    };
    return { frames: ordered(this.frames, this.frameCount), events: ordered(this.events, this.eventCount),
      frameCapacity: this.frames.length, eventCapacity: this.events.length,
      gpuTiming: 'unobserved', garbageCollection: 'unobserved' };
  }
}
