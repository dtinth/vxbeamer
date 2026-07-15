import { expect, test, vi } from "vite-plus/test";
import type { Message } from "./store.ts";
import { applyWinner, type WinnerContext } from "./winner.ts";

const QWEN = "qwen/qwen3-asr-flash-realtime";
const QWEN_GROQ = "qwen/qwen3-asr-flash-realtime+groq";

/** Stands in for the boot-time selector; no catalogue, no credentials, no network. */
const context: WinnerContext = {
  isEnabledConfiguration: (id) => id === QWEN || id === QWEN_GROQ,
};

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "message-1",
    status: "done",
    final: "the primary answer",
    configurationId: QWEN,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function expectOk(result: ReturnType<typeof applyWinner>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.message}`);
  return result;
}

function expectErr(result: ReturnType<typeof applyWinner>) {
  if (result.ok) throw new Error("expected an error");
  return result;
}

// --- Replacing the primary answer ---

test("the winner's transcript becomes the message's answer", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const message = createMessage();

  const result = expectOk(
    applyWinner(message, { configurationId: QWEN_GROQ, transcript: "the winner" }, context),
  );

  expect(result.configurationId).toBe(QWEN_GROQ);
  expect(message.final).toBe("the winner");
  expect(message.updatedAt).toBe(1000);
  now.mockRestore();
});

test("the message records which configuration authored the answer", () => {
  // Without this a second `message.updated` is an unexplained transcript change,
  // and no client can tell a winner's answer from the primary's.
  const message = createMessage({ configurationId: QWEN });

  applyWinner(message, { configurationId: QWEN_GROQ, transcript: "the winner" }, context);

  expect(message.configurationId).toBe(QWEN_GROQ);
});

test("the winner's transcript is normalized like a provider's final", () => {
  const message = createMessage();

  applyWinner(message, { configurationId: QWEN, transcript: "trailing space   \n\n" }, context);

  expect(message.final).toBe("trailing space");
});

test("an empty transcript is a legitimate winner", () => {
  // "this clip is silence" is a real judgement, and the live path stores an
  // empty final the same way.
  const message = createMessage();

  expectOk(applyWinner(message, { configurationId: QWEN, transcript: "" }, context));

  expect(message.final).toBe("");
});

test("a leftover partial is cleared", () => {
  const message = createMessage({ partial: "stale interim" });

  applyWinner(message, { configurationId: QWEN, transcript: "the winner" }, context);

  expect(message.partial).toBeUndefined();
});

test("the primary configuration may win its own message", () => {
  // The primary is just another candidate, so picking it is a no-op answer
  // change and an ordinary vote — not a special case to reject.
  const message = createMessage({ configurationId: QWEN });

  expectOk(applyWinner(message, { configurationId: QWEN, transcript: "the winner" }, context));

  expect(message.final).toBe("the winner");
});

// --- Which messages can be replaced ---

test("a winner rescues a message whose primary errored", () => {
  const message = createMessage({ status: "error", error: "ASR blew up", final: undefined });

  expectOk(applyWinner(message, { configurationId: QWEN, transcript: "the winner" }, context));

  expect(message.status).toBe("done");
  expect(message.error).toBeUndefined();
  expect(message.final).toBe("the winner");
});

test("a message still recording is refused", () => {
  // The live session owns `final` until it ends and would clobber the winner.
  const message = createMessage({ status: "recording", final: undefined });

  const error = expectErr(
    applyWinner(message, { configurationId: QWEN, transcript: "the winner" }, context),
  );

  expect(error.code).toBe("not_replaceable");
  expect(message.final).toBeUndefined();
  expect(message.status).toBe("recording");
});

// --- Validation ---

test("a real configuration this server does not serve is rejected without calling it unknown", () => {
  // byteplus/bigmodel is a genuine catalogue entry — it just is not enabled
  // here, so it cannot have produced this transcript. Saying "unknown" would
  // send an operator hunting for a typo that isn't there.
  const message = createMessage();

  const error = expectErr(
    applyWinner(message, { configurationId: "byteplus/bigmodel", transcript: "x" }, context),
  );

  expect(error.code).toBe("unavailable_configuration");
  expect(error.message).toContain("byteplus/bigmodel");
  expect(error.message).not.toContain("Unknown");
});

test("an unknown configuration id fails cleanly rather than crashing", () => {
  const message = createMessage();

  expect(
    expectErr(
      applyWinner(message, { configurationId: "definitely/not-real", transcript: "x" }, context),
    ).code,
  ).toBe("unavailable_configuration");
});

test("an absurd configuration id is not echoed back whole", () => {
  const message = createMessage();

  const error = expectErr(
    applyWinner(message, { configurationId: "x".repeat(400), transcript: "y" }, context),
  );

  expect(error.message.length).toBeLessThan(100);
});

test("a missing configurationId is rejected", () => {
  expect(expectErr(applyWinner(createMessage(), { transcript: "x" }, context)).code).toBe(
    "invalid_request",
  );
});

test("a blank configurationId is rejected", () => {
  expect(
    expectErr(applyWinner(createMessage(), { configurationId: "   ", transcript: "x" }, context))
      .code,
  ).toBe("invalid_request");
});

test("a missing transcript is rejected", () => {
  expect(expectErr(applyWinner(createMessage(), { configurationId: QWEN }, context)).code).toBe(
    "invalid_request",
  );
});

test("a non-string transcript is rejected", () => {
  expect(
    expectErr(applyWinner(createMessage(), { configurationId: QWEN, transcript: 42 }, context))
      .code,
  ).toBe("invalid_request");
});

test("a non-object body is rejected", () => {
  expect(expectErr(applyWinner(createMessage(), "nope", context)).code).toBe("invalid_request");
  expect(expectErr(applyWinner(createMessage(), null, context)).code).toBe("invalid_request");
});

test("an oversized transcript is rejected", () => {
  const error = expectErr(
    applyWinner(
      createMessage(),
      { configurationId: QWEN, transcript: "x".repeat(100_001) },
      context,
    ),
  );

  expect(error.code).toBe("invalid_request");
});

test("a rejected request leaves the message exactly as it was", () => {
  const message = createMessage({ partial: "interim" });
  const before = { ...message };

  expectErr(
    applyWinner(message, { configurationId: "definitely/not-real", transcript: "x" }, context),
  );

  expect(message).toEqual(before);
  expect(message.final).toBe("the primary answer");
});
