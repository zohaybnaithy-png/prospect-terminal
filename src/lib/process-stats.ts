import { getHeapStatistics } from "node:v8";

/**
 * Coarse process figures for /health and the monitor (scripts/ops/monitor.ts): memory in MB and
 * uptime. The systemd unit caps the app at MemoryMax=3G with a 1.5 GB heap; a resident size that
 * keeps growing toward that is the early warning before an out-of-memory restart.
 */
export function processStats() {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1_048_576);
  return {
    uptimeSeconds: Math.round(process.uptime()),
    rssMB: mb(m.rss),
    heapUsedMB: mb(m.heapUsed),
    heapLimitMB: mb(getHeapStatistics().heap_size_limit),
  };
}
