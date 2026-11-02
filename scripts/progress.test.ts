import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginStage,
  progress,
  redact,
  setProgressReporter,
  stderrReporter,
} from "../src/ingestion/progress";

test("progress lines redact connection strings and credential parameters", () => {
  const lines: string[] = [];
  setProgressReporter(stderrReporter((line) => lines.push(line)));
  try {
    beginStage("db:connect");
    progress("db:pool-error", {
      message:
        "connect failed for postgresql://user:hunter2@db.example.test/app?sslmode=require password=hunter2",
    });
  } finally {
    setProgressReporter(() => {});
  }
  assert.equal(lines.length, 2);
  assert.match(
    lines[0],
    /^\[\d{4}-\d\d-\d\dT[^\]]+ \+\d+\.\ds\] db:connect\n$/,
  );
  assert.doesNotMatch(lines.join(""), /hunter2|user:/);
  assert.match(lines[1], /<redacted-url>/);
  assert.equal(
    redact("https://statsapi.mlb.com/api/v1/teams?season=2026"),
    "https://statsapi.mlb.com/api/v1/teams?season=2026",
  );
});
