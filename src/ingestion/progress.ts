/** Diagnostic progress events. Silent unless a reporter is installed (the CLI writes to stderr). */
type Fields = Record<string, string | number | boolean | undefined>;
export type ProgressReporter = (event: string, fields?: Fields) => void;
let reporter: ProgressReporter = () => {};
let stage = { name: "idle", startedAt: Date.now(), fields: {} as Fields };

export function setProgressReporter(next: ProgressReporter) {
  reporter = next;
}
export function progress(event: string, fields?: Fields) {
  reporter(event, fields);
}
/** Marks a long-running stage so heartbeats can say where the process is waiting. */
export function beginStage(name: string, fields: Fields = {}) {
  stage = { name, startedAt: Date.now(), fields };
  reporter(name, fields);
}
export function updateStage(fields: Fields) {
  stage.fields = { ...stage.fields, ...fields };
}

const credentialUrl = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'@/]*@[^\s"']*/gi;
const credentialParam = /\b(password|passwd|pwd|secret|token)=[^\s&"']+/gi;
/** Strips connection strings and credential parameters from anything written to logs. */
export function redact(text: string) {
  return text
    .replace(credentialUrl, "<redacted-url>")
    .replace(credentialParam, "$1=<redacted>");
}
const format = (fields?: Fields) =>
  Object.entries(fields ?? {})
    .filter(([, v]) => v !== undefined)
    .map(
      ([k, v]) =>
        ` ${k}=${typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : v}`,
    )
    .join("");

export function stderrReporter(
  write: (line: string) => void = (line) => process.stderr.write(line),
  startedAt = Date.now(),
): ProgressReporter {
  return (event, fields) =>
    write(
      redact(
        `[${new Date().toISOString()} +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${event}${format(fields)}\n`,
      ),
    );
}

/** Periodic liveness line; unref'd so it never keeps the process alive by itself. */
export function startHeartbeat(intervalMs = 5000) {
  const timer = setInterval(
    () =>
      reporter("heartbeat", {
        stage: stage.name,
        stageSeconds: Math.round((Date.now() - stage.startedAt) / 1000),
        ...stage.fields,
        rssMb: Math.round(process.memoryUsage().rss / 1e6),
      }),
    intervalMs,
  );
  timer.unref();
  return () => clearInterval(timer);
}
