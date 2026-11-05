import type { AflDataResult } from "@/services/afl/types";

const messages: Record<Exclude<AflDataResult["status"], "ok">, string> = {
  "not-configured":
    "Real data is not connected: the server has no database configured.",
  empty:
    "No 2026 Minor League or Arizona Fall League data has been ingested yet.",
  unavailable:
    "Player data is temporarily unavailable. Please try again in a moment.",
};

/** Empty/error state for real-data sections. Never shows connection details. */
export function AflDataNotice({
  status,
  compact = false,
}: {
  status: Exclude<AflDataResult["status"], "ok">;
  compact?: boolean;
}) {
  return (
    <div
      className={compact ? "afl-notice compact" : "afl-notice"}
      role="status"
    >
      {messages[status]}
    </div>
  );
}

export function aflDataNoticeText(
  status: Exclude<AflDataResult["status"], "ok">,
) {
  return messages[status];
}
