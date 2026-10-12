// Env-gated per-request phase timing (ROUTE_TIMING=1, default off).
//
// Emits a Server-Timing response header summarizing wall-clock durations of
// the request's phases (rate limit, cache reads, ES ping, quantile lookup,
// list compute, marker compute/fill, serialization). When the flag is off,
// every record() is a no-op and no header is added — the response is
// byte-identical to the uninstrumented route.
//
// Durations are wall time, not CPU. Parallel branches (list and markers)
// record their own durations independently; they overlap by design, so
// summing phases can exceed 'total'. `total` is measured once, at header
// construction.
import { flags } from '@/lib/flags';

export class ServerTiming {
  private readonly t0 = performance.now();
  private readonly parts: string[] = [];
  private totalRecorded = false;

  constructor(private readonly enabled: boolean) {}

  record(name: string, durationMs?: number) {
    if (!this.enabled) return;
    const dur = durationMs ?? performance.now() - this.t0;
    this.parts.push(`${name};dur=${Math.max(0, dur).toFixed(1)}`);
  }

  get elapsed(): number {
    return performance.now() - this.t0;
  }

  header(): string | null {
    if (!this.enabled) return null;
    if (!this.totalRecorded) {
      this.totalRecorded = true;
      this.record('total', this.elapsed);
    }
    return this.parts.join(', ');
  }
}

export function makeServerTiming(): ServerTiming {
  return new ServerTiming(flags.routeTiming);
}

// Apply the header to a response if the timing is enabled and the header
// exists. Header mutation is best-effort: never let observability break a
// served response.
export function attachTiming(res: Response, timing: ServerTiming | null): Response {
  if (!timing) return res;
  try {
    const header = timing.header();
    if (header) res.headers.set('Server-Timing', header);
  } catch {
    /* observability only */
  }
  return res;
}
