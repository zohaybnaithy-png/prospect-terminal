// Types for the read-only helper's exported guards (used by tests).
export class GuardError extends Error {}
export function parseScript(source: string): ({ kind: "sql"; text: string } | { kind: "echo"; text: string })[];
export function classify(sql: string): "skip" | "run";
export function checkTarget(url: string, expectedEndpoint: string): string;
