// DynamoDbStore error mapping against a faithful fake of the DynamoDB client
// edge (the SDK `send` boundary, not src/). Covers the `guard` outage mapping
// (throttling / 5xx -> BackendUnavailableError, other errors pass through) and
// the ConditionalCheckFailedException lost-race path in `take`.
import { describe, expect, it } from "vitest";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { DynamoDbStore } from "../../src/store/dynamodb.ts";
import { BackendUnavailableError } from "../../src/store/store.ts";

type SdkError = Error & { name: string; $metadata?: { httpStatusCode?: number } };

function sdkError(name: string, status?: number): SdkError {
  return Object.assign(new Error(`fake dynamo failure: ${name}`), {
    name,
    $metadata: status === undefined ? undefined : { httpStatusCode: status },
  }) as SdkError;
}

/** A fake DynamoDB client whose `send` behaviour is scripted per test. */
class FakeDynamoClient {
  destroyed = false;
  constructor(private readonly handler: (cmd: unknown) => Promise<unknown>) {}
  send(cmd: unknown): Promise<unknown> {
    return this.handler(cmd);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function store(handler: (cmd: unknown) => Promise<unknown>): DynamoDbStore {
  const client = new FakeDynamoClient(handler) as unknown as DynamoDBClient;
  return new DynamoDbStore(client, "planted-table", () => 0);
}

const OUTAGES: Array<[string, number | undefined]> = [
  ["ProvisionedThroughputExceededException", undefined],
  ["ThrottlingException", undefined],
  ["RequestLimitExceeded", undefined],
  ["InternalServerError", undefined],
  ["SomeOtherName", 500],
  ["SomeOtherName", 503],
];

describe("DynamoDbStore guard", () => {
  for (const [name, status] of OUTAGES) {
    it(`maps_${name}_${status ?? "noStatus"}_to_backend_unavailable`, async () => {
      const s = store(() => Promise.reject(sdkError(name, status)));
      await expect(s.get(["clients", "c1"])).rejects.toBeInstanceOf(BackendUnavailableError);
    });
  }

  it("passes_through_non_outage_errors", async () => {
    const s = store(() => Promise.reject(sdkError("ValidationException", 400)));
    const err = await s.get(["clients", "c1"]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BackendUnavailableError);
    expect((err as Error).name).toBe("ValidationException");
  });

  it("outage_mapping_applies_to_writes_too", async () => {
    const s = store(() => Promise.reject(sdkError("ThrottlingException")));
    await expect(s.set(["clients", "c1"], { ok: true })).rejects.toBeInstanceOf(BackendUnavailableError);
  });
});

describe("DynamoDbStore take", () => {
  it("returns_null_when_conditional_check_fails", async () => {
    // Lost the race: another caller deleted the item first. DynamoDB reports a
    // ConditionalCheckFailedException, which must surface as "not a winner".
    const s = store((cmd) => {
      if (cmd instanceof DeleteItemCommand) {
        return Promise.reject(new ConditionalCheckFailedException({ message: "lost race", $metadata: {} }));
      }
      throw new Error("unexpected command");
    });
    expect(await s.take(["grants", "g1"])).toBeNull();
  });

  it("re_throws_unexpected_delete_errors", async () => {
    const s = store((cmd) => {
      if (cmd instanceof DeleteItemCommand) return Promise.reject(sdkError("ValidationException", 400));
      throw new Error("unexpected command");
    });
    await expect(s.take(["grants", "g1"])).rejects.toHaveProperty("name", "ValidationException");
  });

  it("returns_the_value_for_the_winning_caller", async () => {
    const s = store((cmd) => {
      if (cmd instanceof DeleteItemCommand) {
        return Promise.resolve({ Attributes: marshall({ pk: "grants", sk: "g1", v: { token: "planted" }, expiresAt: null }) });
      }
      throw new Error("unexpected command");
    });
    expect(await s.take(["grants", "g1"])).toEqual({ token: "planted" });
  });

  it("returns_null_when_delete_removed_nothing", async () => {
    const s = store((cmd) => {
      if (cmd instanceof DeleteItemCommand) return Promise.resolve({});
      throw new Error("unexpected command");
    });
    expect(await s.take(["grants", "g1"])).toBeNull();
  });
});

describe("DynamoDbStore commands", () => {
  it("get_returns_null_when_item_absent", async () => {
    const s = store((cmd) => {
      expect(cmd).toBeInstanceOf(GetItemCommand);
      return Promise.resolve({});
    });
    expect(await s.get(["clients", "missing"])).toBeNull();
  });

  it("close_destroys_the_client", async () => {
    const client = new FakeDynamoClient(() => Promise.resolve({}));
    const s = new DynamoDbStore(client as unknown as DynamoDBClient, "planted-table", () => 0);
    await s.close();
    expect(client.destroyed).toBe(true);
  });

  it("set_marshals_without_undefined_values", async () => {
    let captured: unknown;
    const s = store((cmd) => {
      expect(cmd).toBeInstanceOf(PutItemCommand);
      captured = cmd;
      return Promise.resolve({});
    });
    await s.set(["clients", "c1"], { ok: true });
    expect(captured).toBeInstanceOf(PutItemCommand);
  });
});
