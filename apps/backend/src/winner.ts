import type { Message } from "./store.ts";
import { normalizeTranscriptText } from "./transcript.ts";

/**
 * The longest transcript we accept from a client. Intake caps a recording at
 * 20 MB of PCM (~11 minutes), which no honest transcript comes near filling;
 * this only stops an authenticated client from parking megabytes of text in the
 * in-memory message log.
 */
const MAX_TRANSCRIPT_LENGTH = 100_000;

export type WinnerErrorCode = "invalid_request" | "unavailable_configuration" | "not_replaceable";

export type WinnerResult =
  | { ok: true; configurationId: string }
  | { ok: false; code: WinnerErrorCode; message: string };

export interface WinnerContext {
  /**
   * Whether this server serves the named configuration. An eval replay is
   * selected exactly like a recording is, so a configuration that is not
   * enabled cannot have produced a transcript — and a vote naming it would be
   * noise in the vote stream, where configuration ids are the whole dataset.
   */
  isEnabledConfiguration(id: string): boolean;
}

function reject(code: WinnerErrorCode, message: string): WinnerResult {
  return { ok: false, code, message };
}

/** Ids arrive from an untrusted body; echo them back short. */
function quoteId(id: string): string {
  return JSON.stringify(id.length > 32 ? `${id.slice(0, 32)}…` : id);
}

/**
 * Replaces a message's primary answer with the winning configuration's
 * transcript, in place, and records which configuration now authored it.
 *
 * The transcript is taken from the client and cannot be otherwise: eval runs
 * are collected in the browser and leave no trace on the backend, which holds
 * no recording to re-transcribe. So the transcript is unverifiable by
 * construction. This is not a hole — the write is scoped to the caller's own
 * message log, and a user who fakes their own transcript has only edited their
 * own words. The configuration id, unlike the transcript, *is* checkable, and
 * is the field the vote stream is built on, so it is checked.
 *
 * A message still `recording` is refused: the live session owns `final` until
 * it ends and would clobber the winner moments later. A message in `error` is
 * accepted and promoted to `done` — the primary failing to produce an answer is
 * one of the cases eval exists to rescue, and the winner *is* the answer now.
 */
export function applyWinner(message: Message, body: unknown, context: WinnerContext): WinnerResult {
  if (typeof body !== "object" || body === null) {
    return reject("invalid_request", "Invalid request body");
  }
  const { configurationId, transcript } = body as {
    configurationId?: unknown;
    transcript?: unknown;
  };
  if (typeof configurationId !== "string" || configurationId.trim() === "") {
    return reject("invalid_request", "Missing configurationId");
  }
  if (typeof transcript !== "string") {
    return reject("invalid_request", "Missing transcript");
  }
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
    return reject("invalid_request", `transcript exceeds ${MAX_TRANSCRIPT_LENGTH} characters`);
  }
  if (!context.isEnabledConfiguration(configurationId)) {
    // "not available" rather than "unknown": an id can also be a real
    // configuration this server does not serve, and claiming it does not exist
    // would send an operator hunting for a typo that isn't there.
    return reject(
      "unavailable_configuration",
      `ASR configuration ${quoteId(configurationId)} is not available`,
    );
  }
  if (message.status === "recording") {
    return reject("not_replaceable", "Message is still recording");
  }

  // Normalized exactly as the live path normalizes a provider's final, so a
  // winner and a primary answer are stored on identical terms.
  message.final = normalizeTranscriptText(transcript);
  message.partial = undefined;
  message.configurationId = configurationId;
  message.status = "done";
  message.error = undefined;
  message.updatedAt = Date.now();

  return { ok: true, configurationId };
}
