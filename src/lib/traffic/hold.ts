import { onVercel } from "@/lib/platform";

/**
 * Refusals are answered after a short delay so a client that ignores Retry-After cannot turn each
 * connection into hundreds of refusals per second (measured: one address with 16 connections sent
 * 18,911 requests in 30 s with immediate refusals, 2,401 in 150 s with a 1 s delay).
 *
 * A held refusal keeps two sockets open (client↔Caddy, Caddy↔app) and an app file descriptor, so
 * holding is bounded twice: per client (so one client cannot take every slot) and in total (so the
 * app stays far below its file-descriptor limit; deploy/prospect-terminal.service raises it). Beyond
 * either bound a refusal is answered immediately, which is always safe.
 */
export const HOLD_TOTAL_LIMIT = 256;
export const heldPerClientLimit = 32;

export function holdDecision(held: Map<string, number>, key: string | null, total: number): "hold" | "immediate" {
  if (total >= HOLD_TOTAL_LIMIT) return "immediate";
  if (key && (held.get(key) ?? 0) >= heldPerClientLimit) return "immediate";
  return "hold";
}

/**
 * `PT_REFUSAL_DELAY_MS` (0–5000): 0 answers every refusal immediately.
 *
 * Default 1000 on the single server. On Vercel the default is 0: a held refusal there keeps a
 * function invocation open, which is billed as provisioned memory and counts against the Hobby
 * allowance, while the platform's edge (not this process) holds the client's connection, so holding
 * protects nothing. An explicit value still wins.
 */
export function refusalDelayMs(env: Record<string, string | undefined> = process.env): number {
  const fallback = onVercel(env) ? 0 : 1000;
  const raw = env.PT_REFUSAL_DELAY_MS;
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 5000 ? n : fallback;
}
