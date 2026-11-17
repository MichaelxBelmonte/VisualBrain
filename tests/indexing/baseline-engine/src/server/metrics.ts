// Per-phase timings and memory of one indexing run: wall time, RSS, heap, peak RSS and the longest event-loop stall.
import { performance } from 'node:perf_hooks';

export interface PhaseMetric {
  phase: string;
  ms: number;
  /** RSS and V8 heap at the end of the phase (MB). */
  rssMb: number;
  heapMb: number;
  /** Process peak RSS so far (MB): the phase that raises it is the one that needs the memory. */
  peakRssMb: number;
  /** Longest time the event loop could not answer during the phase (ms); for a synchronous phase it is the whole phase. */
  stallMs: number;
  /** Wall-clock end of the phase (epoch ms), to line phases up with probes taken outside the process. */
  endAt: number;
  /** Phase-specific counters (rows, files, splits of the time). */
  counts?: Record<string, number>;
}

const MB = 1024 * 1024;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** `maxRSS` is in kilobytes on every platform (libuv normalises macOS bytes). */
function peakRssMb(): number {
  return process.resourceUsage().maxRSS / 1024;
}

export class IndexMetrics {
  readonly phases: PhaseMetric[] = [];
  private readonly t0 = performance.now();
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private maxLag = 0;
  private everyMs = 10;

  /** Starts sampling event-loop lag every `everyMs`; without it async phases report a stall of 0. */
  sample(everyMs = 10): this {
    this.everyMs = everyMs;
    this.lastTick = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.maxLag = Math.max(this.maxLag, now - this.lastTick - everyMs);
      this.lastTick = now;
    }, everyMs);
    this.timer.unref();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private begin(): number {
    this.maxLag = 0;
    this.lastTick = performance.now();
    return performance.now();
  }

  private end(phase: string, start: number, sync: boolean, counts?: Record<string, number>): void {
    const now = performance.now();
    const ms = now - start;
    // a synchronous tail (e.g. the DB write after the last await) has not been seen by the timer yet
    if (!sync && this.timer) this.maxLag = Math.max(this.maxLag, now - this.lastTick - this.everyMs);
    const mem = process.memoryUsage();
    this.phases.push({
      phase,
      ms: round(ms),
      rssMb: round(mem.rss / MB),
      heapMb: round(mem.heapUsed / MB),
      peakRssMb: round(peakRssMb()),
      stallMs: round(sync ? ms : Math.max(0, this.maxLag)),
      endAt: Date.now(),
      ...(counts && Object.keys(counts).length ? { counts } : {}),
    });
  }

  /** Measures a synchronous phase. */
  measure<T>(phase: string, fn: () => T, counts?: (out: T) => Record<string, number>): T {
    const start = this.begin();
    const out = fn();
    this.end(phase, start, true, counts?.(out));
    return out;
  }

  /** Measures an asynchronous phase; the stall is the longest event-loop lag seen while sampling. */
  async measureAsync<T>(phase: string, fn: () => Promise<T>, counts?: (out: T) => Record<string, number>): Promise<T> {
    const start = this.begin();
    const out = await fn();
    this.end(phase, start, false, counts?.(out));
    return out;
  }

  /** Records a sub-phase already timed by the caller (e.g. the steps of buildEdges reported through progress). */
  record(phase: string, ms: number, counts?: Record<string, number>): void {
    const mem = process.memoryUsage();
    this.phases.push({ phase, ms: round(ms), rssMb: round(mem.rss / MB), heapMb: round(mem.heapUsed / MB), peakRssMb: round(peakRssMb()), stallMs: round(ms), endAt: Date.now(), ...(counts ? { counts } : {}) });
  }

  totalMs(): number {
    return round(performance.now() - this.t0);
  }
}

/** Splits a synchronous step that reports progress messages into timed sub-steps (`edges:refs`, `edges:similar`…). */
export function splitter(prefix: string, names: string[], metrics: IndexMetrics, forward?: (m: string) => void): (m: string) => void {
  let last = performance.now();
  let i = 0;
  return (m: string) => {
    const now = performance.now();
    if (i < names.length) metrics.record(`${prefix}:${names[i++]}`, now - last);
    last = now;
    forward?.(m);
  };
}
