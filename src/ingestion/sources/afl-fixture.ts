import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  SourceAdapter,
  SourceSnapshot,
  NormalizedBatch,
} from "../contracts";
import { recordSchema } from "../contracts";
const envelope = z
  .object({
    fixture: z.literal(true),
    version: z.literal(1),
    observedAt: z.iso.datetime({ offset: true }),
    records: z.array(z.unknown()).max(10000),
  })
  .strict();
/** Synthetic provider protocol, not captured MLB data and not a claimed MLB API contract. */
export class AflFixtureAdapter implements SourceAdapter {
  readonly id = "afl-fixture";
  readonly version = "1";
  constructor(private readonly path: string) {}
  async load(): Promise<SourceSnapshot> {
    const raw = await readFile(this.path, "utf8");
    if (Buffer.byteLength(raw) > 5_000_000)
      throw new Error("Fixture exceeds 5 MB limit");
    const payload: unknown = JSON.parse(raw);
    const parsed = envelope.parse(payload);
    return {
      provider: this.id,
      adapterVersion: this.version,
      key: "afl-proof-of-concept",
      observedAt: parsed.observedAt,
      fetchedAt: new Date().toISOString(),
      sourceUrl: "fixture://afl-proof-of-concept",
      payload,
    };
  }
  normalize(snapshot: SourceSnapshot): NormalizedBatch {
    const parsed = envelope.safeParse(snapshot.payload);
    if (!parsed.success)
      return {
        records: [],
        issues: [
          {
            recordKey: "snapshot",
            code: "invalid-snapshot",
            message: "Invalid synthetic source envelope",
          },
        ],
      };
    const result: NormalizedBatch = { records: [], issues: [] };
    parsed.data.records.forEach((raw, index) => {
      const external = z
        .object({
          entity: z.string(),
          id: z.string().optional(),
          fullName: z.string().optional(),
        })
        .passthrough()
        .safeParse(raw);
      if (!external.success) {
        result.issues.push({
          recordKey: `row:${index}`,
          code: "invalid-record",
          message: "Missing source entity discriminator",
        });
        return;
      }
      const { entity, id, fullName, ...fields } = external.data;
      const record = recordSchema.safeParse({
        ...fields,
        kind: entity,
        ...(id ? { externalId: id } : {}),
        ...(fullName ? { name: fullName } : {}),
      });
      if (
        record.success &&
        record.data.kind === "team" &&
        record.data.organization !== null
      )
        result.issues.push({
          recordKey: `row:${index}`,
          code: "invalid-record",
          message:
            "An AFL team cannot be assigned a single parent organization",
        });
      else if (record.success) result.records.push(record.data);
      else
        result.issues.push({
          recordKey: `row:${index}`,
          code: "invalid-record",
          message: `Invalid ${entity.slice(0, 40)} record: ${record.error.issues
            .map((i) => i.path.join(".") || "record")
            .join(", ")
            .slice(0, 200)}`,
        });
    });
    return result;
  }
}
