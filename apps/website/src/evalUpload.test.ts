import { describe, expect, test } from "vite-plus/test";
import { writeWav } from "vxasr/audio";
import {
  buildEvalSetPayload,
  buildVotePayload,
  submitWinnerPick,
  type EvalCandidateResult,
  type PayloadContext,
  type WinnerPick,
  type WinnerPickDeps,
} from "./evalUpload.ts";
import type { RetainedRecording } from "./recordedAudio.ts";

const votedAt = Date.UTC(2026, 6, 16, 9, 30, 0, 123);

const candidates: EvalCandidateResult[] = [
  {
    configurationId: "qwen/qwen3-asr-flash-realtime",
    transcript: "hello there",
    usage: [{ sku: "qwen-asr", unitPrice: 0.0001, quantity: 9 }],
  },
  {
    configurationId: "qwen/qwen3-asr-flash-realtime+groq",
    transcript: "Hello there!",
  },
  { configurationId: "byteplus/bigmodel", error: "socket hang up" },
];

const pick: WinnerPick = {
  messageId: "msg-1",
  referenceId: "ref-1",
  configurationId: "qwen/qwen3-asr-flash-realtime+groq",
  primaryConfigurationId: "qwen/qwen3-asr-flash-realtime",
  candidates,
  saveForEval: false,
};

/** The browser's own base64 decoder — this bundle has no `Buffer`. */
function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/**
 * A retained recording of `sampleCount` 16-bit samples, built directly. The
 * module under test reads recordings through an injected lookup, so the
 * retention store never has to be involved.
 */
function retain(sampleCount: number): RetainedRecording {
  const pcm = new ArrayBuffer(sampleCount * 2);
  const view = new DataView(pcm);
  // A ramp, so a byte-order or offset slip shows up as wrong samples.
  for (let i = 0; i < sampleCount; i++) view.setInt16(i * 2, i * 11 - 500, true);
  return {
    referenceId: "ref-1",
    chunks: [pcm],
    byteLength: pcm.byteLength,
    capturedByteLength: pcm.byteLength,
    droppedForSize: false,
    createdAt: votedAt,
  };
}

describe("buildVotePayload", () => {
  const context: PayloadContext = { votedAt, subject: "user-1" };

  test("carries no transcript, even though every candidate has one", () => {
    // The privacy promise of #43, pinned: a vote is written on every pick,
    // opted in or not, so it must never be able to carry speech content.
    const vote = buildVotePayload(pick, context);
    const serialized = JSON.stringify(vote);

    expect(serialized).not.toContain("hello there");
    expect(serialized).not.toContain("Hello there!");
    for (const candidate of vote.candidates) {
      expect(candidate).not.toHaveProperty("transcript");
    }
  });

  test("names the winning configuration, not just the provider", () => {
    const vote = buildVotePayload(pick, context);
    // "qwen won" is ambiguous once two qwen configurations compete (#30).
    expect(vote.winner.configurationId).toBe("qwen/qwen3-asr-flash-realtime+groq");
    expect(vote.type).toBe("vote");
  });

  test("records the whole ballot, so a win is a rate and not just a count", () => {
    const vote = buildVotePayload(pick, context);
    expect(vote.candidates.map((c) => c.configurationId)).toEqual([
      "qwen/qwen3-asr-flash-realtime",
      "qwen/qwen3-asr-flash-realtime+groq",
      "byteplus/bigmodel",
    ]);
  });

  test("keeps what a candidate lost on: cost, latency, and failure", () => {
    const vote = buildVotePayload(pick, context);
    expect(vote.candidates[0]?.usage).toEqual([
      { sku: "qwen-asr", unitPrice: 0.0001, quantity: 9 },
    ]);
    // A crash is a loss on availability, not on quality.
    expect(vote.candidates[2]?.error).toBe("socket hang up");
  });

  test("distinguishes confirming the primary from defecting to another", () => {
    const vote = buildVotePayload(pick, context);
    expect(vote.primaryConfigurationId).toBe("qwen/qwen3-asr-flash-realtime");
    expect(vote.winner.configurationId).not.toBe(vote.primaryConfigurationId);
  });

  test("describes the audio's duration but never the audio", () => {
    const recording = retain(16000); // 1 second
    const vote = buildVotePayload(pick, { ...context, recording });

    expect(vote.audio?.durationSeconds).toBe(1);
    expect(vote.audio?.sampleRate).toBe(16000);
    expect(vote.audio).not.toHaveProperty("data");
  });

  test("still records a vote when the audio is gone", () => {
    const vote = buildVotePayload(pick, context);
    expect(vote.audio).toBeUndefined();
    expect(vote.winner.configurationId).toBe("qwen/qwen3-asr-flash-realtime+groq");
  });

  test("flags whether an eval-set exists to join to", () => {
    expect(buildVotePayload(pick, context).savedForEval).toBe(false);
    expect(buildVotePayload({ ...pick, saveForEval: true }, context).savedForEval).toBe(true);
  });
});

describe("buildEvalSetPayload", () => {
  const context = (recording: RetainedRecording): PayloadContext => ({
    votedAt,
    subject: "user-1",
    recording,
  });

  test("carries the audio as a base64 WAV, not as raw PCM", () => {
    const recording = retain(1600);
    const evalSet = buildEvalSetPayload({ ...pick, saveForEval: true }, context(recording));
    const decoded = decodeBase64(evalSet!.audio.data);

    // Decision 5: what lands in the bucket is a real WAV file — it announces
    // itself, so whoever opens it later needs no side channel telling them it is
    // 16 kHz mono. That vxasr's reader accepts what its writer emits is proven
    // where both live (`packages/vxasr/tests/audio.test.ts`); here we only care
    // that the payload carries the container and the right samples.
    expect(String.fromCharCode(...decoded.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...decoded.subarray(8, 12))).toBe("WAVE");
    expect(decoded).toEqual(writeWav(new Uint8Array(recording.chunks[0]!)));
    expect(evalSet!.audio.encoding).toBe("wav");
    expect(evalSet!.audio.durationSeconds).toBe(0.1);
  });

  test("keeps every candidate's transcript — the point of saving it", () => {
    const evalSet = buildEvalSetPayload({ ...pick, saveForEval: true }, context(retain(160)));
    expect(evalSet!.candidates.map((c) => c.transcript)).toEqual([
      "hello there",
      "Hello there!",
      undefined,
    ]);
  });

  test("is the vote plus audio and transcripts, and says so with `type`", () => {
    const recording = retain(160);
    const evalSet = buildEvalSetPayload({ ...pick, saveForEval: true }, context(recording));
    const vote = buildVotePayload({ ...pick, saveForEval: true }, context(recording));

    expect(evalSet!.type).toBe("eval-set");
    // Same pick, same metadata: the two objects can never disagree.
    expect(evalSet!.messageId).toBe(vote.messageId);
    expect(evalSet!.winner).toEqual(vote.winner);
    expect(evalSet!.primaryConfigurationId).toBe(vote.primaryConfigurationId);
    expect(evalSet!.votedAt).toBe(vote.votedAt);
    expect(evalSet!.subject).toBe(vote.subject);
  });

  test("is null when the recording outgrew retention", () => {
    const dropped: RetainedRecording = {
      referenceId: "ref-1",
      chunks: [],
      byteLength: 0,
      capturedByteLength: 99_999_999,
      droppedForSize: true,
      createdAt: votedAt,
    };
    expect(buildEvalSetPayload({ ...pick, saveForEval: true }, context(dropped))).toBeNull();
  });

  test("is null when there is no audio at all", () => {
    expect(buildEvalSetPayload({ ...pick, saveForEval: true }, { votedAt })).toBeNull();
  });
});

/** A fake backend + bucket. Records every request; reaches no network. */
function createFakeDeps(
  options: {
    upload?: unknown;
    winnerStatus?: number;
    winnerBody?: unknown;
    putStatus?: number;
    recording?: RetainedRecording;
  } = {},
): WinnerPickDeps & { requests: { url: string; method: string; body: unknown }[] } {
  const requests: { url: string; method: string; body: unknown }[] = [];
  const {
    winnerStatus = 200,
    putStatus = 200,
    upload = {
      vote: { url: "https://bucket.example.com/votes/v.json?sig=1", key: "votes/v.json" },
      evalSet: {
        url: "https://bucket.example.com/eval-sets/e.json?sig=2",
        key: "eval-sets/e.json",
      },
      expiresInSeconds: 300,
    },
  } = options;

  return {
    requests,
    backendUrl: "https://backend.example.com",
    accessToken: "test-token",
    subject: "user-1",
    now: () => votedAt,
    getRecording: () => options.recording,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      // The module only ever passes a string URL and a JSON string body; assert
      // that rather than stringifying whatever turns up, so a change to either
      // fails loudly here instead of recording "[object Object]".
      if (typeof input !== "string") throw new Error("expected a string URL");
      if (init?.body !== undefined && typeof init.body !== "string") {
        throw new Error("expected a serialized JSON body");
      }
      const url = input;
      const body: unknown = init?.body ? JSON.parse(init.body) : undefined;
      requests.push({ url, method: init?.method ?? "GET", body });

      if (url.includes("/winner")) {
        return new Response(JSON.stringify(options.winnerBody ?? { ok: true, upload }), {
          status: winnerStatus,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: putStatus });
    }) as typeof fetch,
  };
}

describe("submitWinnerPick", () => {
  test("applies the winner, then votes", async () => {
    const deps = createFakeDeps();
    const outcome = await submitWinnerPick(pick, deps);

    expect(outcome).toEqual({ winnerApplied: true, vote: "uploaded", evalSet: "skipped" });
    expect(deps.requests[0]?.url).toBe("https://backend.example.com/messages/msg-1/winner");
    expect(deps.requests[0]?.body).toEqual({
      configurationId: "qwen/qwen3-asr-flash-realtime+groq",
      transcript: "Hello there!", // the winning candidate's own transcript
    });
    expect(deps.requests[1]?.method).toBe("PUT");
    expect(deps.requests[1]?.url).toContain("/votes/");
  });

  test("votes on every pick, with save-for-eval unticked", async () => {
    const deps = createFakeDeps();
    await submitWinnerPick(pick, deps);
    // The vote stream is the dataset (#29), so it cannot be opt-in.
    expect(deps.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    expect(deps.requests[1]?.body).toMatchObject({ type: "vote", savedForEval: false });
  });

  test("uploads the eval-set too when save-for-eval is ticked", async () => {
    const deps = createFakeDeps({ recording: retain(160) });
    const outcome = await submitWinnerPick({ ...pick, saveForEval: true }, deps);

    expect(outcome).toEqual({ winnerApplied: true, vote: "uploaded", evalSet: "uploaded" });
    const puts = deps.requests.filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(2);
    // Vote first: it is small and it is the one that must land.
    expect(puts[0]?.url).toContain("/votes/");
    expect(puts[1]?.url).toContain("/eval-sets/");
    expect(puts[0]?.body).toMatchObject({ type: "vote" });
    expect(puts[1]?.body).toMatchObject({ type: "eval-set" });
  });

  test("a bucket that is down does not break the winner", async () => {
    const deps = createFakeDeps({ putStatus: 503, recording: retain(160) });
    const outcome = await submitWinnerPick({ ...pick, saveForEval: true }, deps);

    // The user-visible act stands; only bookkeeping was lost.
    expect(outcome.winnerApplied).toBe(true);
    expect(outcome.vote).toBe("failed");
    expect(outcome.storageError).toMatch(/503/);
  });

  test("storage being unconfigured is not an error", async () => {
    const deps = createFakeDeps({ upload: null });
    const outcome = await submitWinnerPick(pick, deps);

    expect(outcome).toEqual({ winnerApplied: true, vote: "skipped", evalSet: "skipped" });
    expect(deps.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  test("records no vote for a pick the backend refused", async () => {
    const deps = createFakeDeps({
      winnerStatus: 409,
      winnerBody: { error: "Message is still recording" },
    });
    const outcome = await submitWinnerPick(pick, deps);

    expect(outcome.winnerApplied).toBe(false);
    expect(outcome.winnerError).toBe("Message is still recording");
    // A pick that did not happen must not pollute the vote stream.
    expect(deps.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  test("survives the backend being unreachable", async () => {
    const deps = createFakeDeps();
    const outcome = await submitWinnerPick(pick, {
      ...deps,
      fetch: (() => Promise.reject(new Error("Failed to fetch"))) as unknown as typeof fetch,
    });

    expect(outcome.winnerApplied).toBe(false);
    expect(outcome.winnerError).toBe("Failed to fetch");
  });

  test("PUTs with the content type the URL was signed for", async () => {
    const deps = createFakeDeps();
    const seen: (HeadersInit | undefined)[] = [];
    await submitWinnerPick(pick, {
      ...deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") seen.push(init.headers);
        return deps.fetch(input, init);
      }) as typeof fetch,
    });
    expect(seen[0]).toMatchObject({ "content-type": "application/json" });
  });

  test("skips the eval-set when the audio is gone but still votes", async () => {
    const deps = createFakeDeps({ recording: undefined });
    const outcome = await submitWinnerPick({ ...pick, saveForEval: true }, deps);

    expect(outcome.vote).toBe("uploaded");
    expect(outcome.evalSet).toBe("skipped");
  });
});
