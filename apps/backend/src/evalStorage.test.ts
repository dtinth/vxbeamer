import { describe, expect, test } from "vite-plus/test";
import {
  UPLOAD_URL_TTL_SECONDS,
  buildObjectKey,
  createEvalStorage,
  type EvalStorageEnv,
} from "./evalStorage.ts";

/**
 * Signing is offline HMAC, so these exercise the real presigner against fake
 * credentials pointed at a fake endpoint. Nothing here reaches the network: a
 * presigned URL is computed, never fetched.
 */
const fakeEnv: EvalStorageEnv = {
  EVAL_STORAGE_BUCKET: "vxbeamer-evals",
  EVAL_STORAGE_REGION: "us-east-1",
  EVAL_STORAGE_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE",
  EVAL_STORAGE_SECRET_ACCESS_KEY: "fake-secret-not-a-real-credential",
};

/** 2026-07-16T09:30:00.123Z */
const at = Date.UTC(2026, 6, 16, 9, 30, 0, 123);

describe("buildObjectKey", () => {
  test("files a vote under votes/, by UTC date, time-then-id", () => {
    expect(buildObjectKey({ kind: "vote", messageId: "msg-1", at })).toBe(
      "votes/2026/07/16/2026-07-16T09-30-00-123Z-msg-1.json",
    );
  });

  test("files an eval-set under its own prefix", () => {
    expect(buildObjectKey({ kind: "eval-set", messageId: "msg-1", at })).toBe(
      "eval-sets/2026/07/16/2026-07-16T09-30-00-123Z-msg-1.json",
    );
  });

  test("a pick's vote and eval-set share a suffix, so one finds the other", () => {
    const vote = buildObjectKey({ kind: "vote", messageId: "msg-1", at });
    const evalSet = buildObjectKey({ kind: "eval-set", messageId: "msg-1", at });
    expect(vote.replace(/^votes\//, "")).toBe(evalSet.replace(/^eval-sets\//, ""));
  });

  test("keys sort chronologically within a day", () => {
    const earlier = buildObjectKey({ kind: "vote", messageId: "zzz", at });
    const later = buildObjectKey({ kind: "vote", messageId: "aaa", at: at + 1000 });
    // Id ordering must not beat time ordering — the timestamp comes first.
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  test("pads months and days so lexicographic order is date order", () => {
    expect(
      buildObjectKey({ kind: "vote", messageId: "m", at: Date.UTC(2026, 0, 5, 0, 0, 0, 0) }),
    ).toBe("votes/2026/01/05/2026-01-05T00-00-00-000Z-m.json");
  });

  test("applies an optional prefix, however it is punctuated", () => {
    for (const prefix of ["team", "team/", "/team/"]) {
      expect(buildObjectKey({ kind: "vote", messageId: "m", at, prefix })).toBe(
        "team/votes/2026/07/16/2026-07-16T09-30-00-123Z-m.json",
      );
    }
  });

  test("an empty prefix adds no leading slash", () => {
    expect(buildObjectKey({ kind: "vote", messageId: "m", at, prefix: "  " })).toBe(
      "votes/2026/07/16/2026-07-16T09-30-00-123Z-m.json",
    );
  });
});

describe("createEvalStorage", () => {
  test("is null when no bucket is configured, so the feature is simply off", () => {
    expect(createEvalStorage({})).toBeNull();
  });

  test("throws at boot when a bucket is named without credentials", () => {
    expect(() => createEvalStorage({ EVAL_STORAGE_BUCKET: "b" })).toThrow(/cannot sign uploads/);
  });

  test("signs a PUT URL per kind, pointing at the matching key", async () => {
    const storage = createEvalStorage(fakeEnv);
    const targets = await storage!.createUploadTargets({ messageId: "msg-1", at });

    expect(targets.vote.key).toBe("votes/2026/07/16/2026-07-16T09-30-00-123Z-msg-1.json");
    expect(targets.evalSet.key).toBe("eval-sets/2026/07/16/2026-07-16T09-30-00-123Z-msg-1.json");
    expect(new URL(targets.vote.url).pathname).toBe(`/${targets.vote.key}`);
    expect(new URL(targets.evalSet.url).pathname).toBe(`/${targets.evalSet.key}`);
    expect(targets.vote.url).not.toBe(targets.evalSet.url);
  });

  test("signs no body checksum, so a real upload is not rejected as corrupt", async () => {
    // Regression: the SDK's default checksum behaviour computes a CRC32 over the
    // request body while presigning. The body is empty then — it is the browser
    // that supplies it — so the URL carries the checksum of zero bytes and S3
    // 400s every actual PUT. Nothing about this fails until a real bucket is
    // wired up, which is exactly why it is pinned here.
    const storage = createEvalStorage(fakeEnv);
    const targets = await storage!.createUploadTargets({ messageId: "msg-1", at });
    const params = new URL(targets.vote.url).searchParams;

    expect(params.get("x-amz-checksum-crc32")).toBeNull();
    expect(params.get("x-amz-sdk-checksum-algorithm")).toBeNull();
  });

  test("signs with a bounded expiry and never leaks the secret", async () => {
    const storage = createEvalStorage(fakeEnv);
    const targets = await storage!.createUploadTargets({ messageId: "msg-1", at });
    const url = new URL(targets.vote.url);

    expect(targets.expiresInSeconds).toBe(UPLOAD_URL_TTL_SECONDS);
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(UPLOAD_URL_TTL_SECONDS));
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    // The access key id is public by design; the secret must never appear.
    expect(targets.vote.url).not.toContain(fakeEnv.EVAL_STORAGE_SECRET_ACCESS_KEY!);
  });

  test("honours a custom S3-compatible endpoint", async () => {
    const storage = createEvalStorage({
      ...fakeEnv,
      EVAL_STORAGE_ENDPOINT: "https://minio.example.com",
      EVAL_STORAGE_FORCE_PATH_STYLE: "true",
    });
    const targets = await storage!.createUploadTargets({ messageId: "msg-1", at });
    const url = new URL(targets.vote.url);

    expect(url.host).toBe("minio.example.com");
    // Path style puts the bucket in the path rather than the hostname.
    expect(url.pathname.startsWith("/vxbeamer-evals/")).toBe(true);
  });
});
