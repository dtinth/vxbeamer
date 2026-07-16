import type { UsageRecord } from "vxasr";
import { writeWav } from "vxasr/audio";
import {
  RETAINED_AUDIO_FORMAT,
  getRetainedRecording,
  retainedDurationSeconds,
  type RetainedRecording,
} from "./recordedAudio.ts";

/**
 * Recording a winner pick to object storage.
 *
 * Two objects, one mechanism: the backend presigns a PUT URL per kind and this
 * module PUTs a JSON object straight to the bucket. The audio never passes
 * through the backend, and no bucket credential ever reaches this code — a
 * presigned URL is a signature over one key, one method, and a deadline.
 *
 *  - A **vote** goes out on *every* winner pick. It carries no audio and no
 *    transcripts, which is what makes it safe to store unconditionally.
 *  - An **eval-set** goes out only when the user ticked save-for-eval. It is the
 *    vote plus the audio and every candidate's transcript.
 */

/** Schema version, bumped when a field's meaning changes. */
export const PAYLOAD_VERSION = 1;

/** What one configuration produced when the eval replayed the recording. */
export interface EvalCandidateResult {
  /** The configuration that produced this — the id the vote stream is built on. */
  configurationId: string;
  /** Its transcript. Deliberately dropped from a vote; kept in an eval-set. */
  transcript?: string;
  /** Usage the backend reported for this replay, for per-candidate cost. */
  usage?: readonly UsageRecord[];
  /** Present when this candidate failed rather than produced a transcript. */
  error?: string;
}

/** A user's winner pick — everything the dialog knows at the moment of the click. */
export interface WinnerPick {
  /** The message whose primary answer the winner replaces. */
  messageId: string;
  /** The recording the eval replayed; its PCM is looked up under this id. */
  referenceId?: string;
  /** The winning configuration. Must appear in `candidates`. */
  configurationId: string;
  /** The primary configuration at eval time, from `/asr/configurations`. */
  primaryConfigurationId?: string;
  /** Every configuration on the ballot, winner and primary included. */
  candidates: readonly EvalCandidateResult[];
  /** Whether the user ticked save-for-eval. */
  saveForEval: boolean;
}

interface AudioDescriptor {
  readonly encoding: "wav";
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  readonly channels: number;
  readonly durationSeconds: number;
}

/** A candidate as a vote records it: no transcript, by construction. */
export interface VoteCandidate {
  readonly configurationId: string;
  readonly usage?: readonly UsageRecord[];
  readonly error?: string;
}

/**
 * What every winner pick writes.
 *
 * The fields are chosen to answer one question months later: *which
 * configuration do I actually pick?* A bare winner id cannot answer it.
 *
 *  - `candidates` — the ballot. Without it a win is a count, not a rate, and
 *    counts are dominated by which configurations happened to be enabled that
 *    week. A model added last month with 5 wins from 5 evals is not worse than
 *    one with 50 from 300; you cannot see that without knowing what each was up
 *    against.
 *  - `primaryConfigurationId` — whether this pick *changed* anything. A vote
 *    where the winner is already the primary is a confirmation; one where it is
 *    not is a defection. Only the second kind argues for changing the default,
 *    and without this field a favourite is indistinguishable from an incumbent.
 *  - `error` per candidate — a configuration that crashed did not lose on
 *    quality, it lost on availability. Collapsing the two makes a flaky provider
 *    look like a bad transcriber.
 *  - `usage` per candidate — cost is a legitimate axis alongside accuracy (#38),
 *    so "which do I pick" and "what does it cost" stay answerable together.
 *  - `audio.durationSeconds` — the cheapest covariate that could explain a
 *    preference, since models drift with utterance length. It is a duration, not
 *    the audio.
 *  - `savedForEval` — says whether an eval-set object exists to join to, and
 *    exposes selection bias: if save-for-eval is only ticked on bad results, the
 *    eval-set corpus is not a random sample of the vote stream, and only the
 *    vote stream knows that.
 *  - `votedAt` — vendors update models under a fixed id, so the same
 *    configuration is not the same thing a year apart. A trend needs a time axis.
 *
 * Deliberately absent: transcripts, audio, and any partial text — this object is
 * written whether or not the user opted in to saving anything, so it must carry
 * nothing they would not want stored. `subject` is here because votes from
 * different people would otherwise average into one meaningless trend.
 */
export interface VotePayload {
  readonly type: "vote";
  readonly version: number;
  readonly votedAt: number;
  readonly messageId: string;
  readonly subject?: string;
  readonly winner: { readonly configurationId: string };
  readonly primaryConfigurationId?: string;
  readonly candidates: readonly VoteCandidate[];
  readonly audio?: AudioDescriptor;
  readonly savedForEval: boolean;
}

/**
 * The vote, plus what the vote refuses to carry: the audio and the transcripts.
 *
 * Modelled as a superset rather than a separate shape, so a reader can treat the
 * eval-set corpus as an enriched slice of the vote stream and the two can never
 * disagree about the same pick. `type` tells them apart, matching the existing
 * webhook convention (`{type: "message.updated", …}`).
 */
export interface EvalSetPayload extends Omit<VotePayload, "type" | "candidates" | "audio"> {
  readonly type: "eval-set";
  readonly candidates: readonly EvalCandidateResult[];
  readonly audio: AudioDescriptor & {
    /** base64 of a complete WAV file — header included, so it just plays. */
    readonly data: string;
  };
}

/** Strips `transcript` off a candidate. The vote's privacy promise, in one place. */
function toVoteCandidate(candidate: EvalCandidateResult): VoteCandidate {
  const { configurationId, usage, error } = candidate;
  return {
    configurationId,
    ...(usage ? { usage } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function describeAudio(recording: RetainedRecording | undefined): AudioDescriptor | undefined {
  if (!recording) return undefined;
  return {
    encoding: "wav",
    sampleRate: RETAINED_AUDIO_FORMAT.sampleRate,
    bitsPerSample: RETAINED_AUDIO_FORMAT.bitsPerSample,
    channels: RETAINED_AUDIO_FORMAT.channels,
    durationSeconds: retainedDurationSeconds(recording),
  };
}

export interface PayloadContext {
  readonly votedAt: number;
  readonly subject?: string | undefined;
  readonly recording?: RetainedRecording | undefined;
}

export function buildVotePayload(pick: WinnerPick, context: PayloadContext): VotePayload {
  const audio = describeAudio(context.recording);
  return {
    type: "vote",
    version: PAYLOAD_VERSION,
    votedAt: context.votedAt,
    messageId: pick.messageId,
    ...(context.subject ? { subject: context.subject } : {}),
    winner: { configurationId: pick.configurationId },
    ...(pick.primaryConfigurationId ? { primaryConfigurationId: pick.primaryConfigurationId } : {}),
    candidates: pick.candidates.map(toVoteCandidate),
    ...(audio ? { audio } : {}),
    savedForEval: pick.saveForEval,
  };
}

/** Flattens the retained chunks into the contiguous PCM a WAV body needs. */
function concatChunks(chunks: readonly ArrayBuffer[], byteLength: number): Uint8Array {
  const pcm = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return pcm;
}

/**
 * `btoa` takes a string, and spreading a 400 KB array into `fromCharCode` blows
 * the argument limit, so walk it in blocks.
 */
function toBase64(bytes: Uint8Array): string {
  const BLOCK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += BLOCK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BLOCK));
  }
  return btoa(binary);
}

/**
 * Builds the eval-set. Returns `null` when the audio is gone — retention has
 * caps and a long recording is dropped outright, and an eval-set without its
 * audio is not an eval set. The vote still stands on its own.
 */
export function buildEvalSetPayload(
  pick: WinnerPick,
  context: PayloadContext,
): EvalSetPayload | null {
  const { recording } = context;
  if (!recording || recording.droppedForSize || recording.byteLength === 0) return null;

  const vote = buildVotePayload(pick, context);
  const audio = describeAudio(recording);
  if (!audio) return null;

  // WAV rather than raw PCM, and written by the same module that reads it back
  // (`vxasr`'s `writeWav`/`readPcm`): 44 bytes buys a file that plays anywhere
  // and states its own sample rate, which is what a saved set revisited months
  // later — or re-run against new models — actually needs.
  const wav = writeWav(concatChunks(recording.chunks, recording.byteLength));

  const { type: _type, candidates: _candidates, audio: _audio, ...shared } = vote;
  return {
    ...shared,
    type: "eval-set",
    candidates: pick.candidates,
    audio: { ...audio, data: toBase64(wav) },
  };
}

/** The `upload` block `POST /messages/:id/winner` returns. `null` = storage off. */
export interface EvalUploadTargets {
  vote: { url: string; key: string };
  evalSet: { url: string; key: string };
  expiresInSeconds: number;
}

export type UploadOutcome = "uploaded" | "skipped" | "failed";

/**
 * Reports the user-visible act and the bookkeeping separately, on purpose. The
 * caller must show `winnerError`; it must **not** show a storage failure as if
 * the pick failed, because the pick did not fail.
 */
export interface WinnerPickOutcome {
  /** Whether the winner replaced the primary answer. The thing the user asked for. */
  winnerApplied: boolean;
  /** Why it did not. Present only when `winnerApplied` is false. */
  winnerError?: string;
  vote: UploadOutcome;
  evalSet: UploadOutcome;
  /** Non-fatal storage detail, for logging rather than for the user. */
  storageError?: string;
}

export interface WinnerPickDeps {
  backendUrl: string;
  accessToken: string;
  subject?: string | undefined;
  fetch: typeof fetch;
  getRecording(referenceId: string): RetainedRecording | undefined;
  now(): number;
}

/**
 * The production wiring, pulled in only when a caller supplies no deps.
 *
 * Imported dynamically rather than at module scope because `store.ts` reads
 * `localStorage` as it loads: a static import would drag a browser global into
 * every consumer of this module, including its own tests, for the sake of a
 * default path those tests never take.
 */
async function resolveDeps(): Promise<WinnerPickDeps> {
  const { $backendUrl, $userInfo, obtainSessionToken } = await import("./store.ts");
  return {
    backendUrl: $backendUrl.get(),
    accessToken: await obtainSessionToken(),
    subject: $userInfo.get()?.sub,
    fetch: (...args) => fetch(...args),
    getRecording: getRetainedRecording,
    now: Date.now,
  };
}

async function putJson(deps: WinnerPickDeps, url: string, payload: unknown): Promise<void> {
  const response = await deps.fetch(url, {
    method: "PUT",
    // Must match the content type the URL was signed with, or S3 rejects it.
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Storage rejected the upload: ${response.status}`);
  }
}

/**
 * Applies a winner pick and records it.
 *
 * Call this once, from the eval dialog, when the user picks a winner. It:
 *
 *  1. `POST`s the winner to the backend, which replaces the message's primary
 *     answer (#41) and returns presigned upload URLs;
 *  2. PUTs the vote to storage — always, on every pick;
 *  3. PUTs the eval-set — only when `saveForEval` is set.
 *
 * **Never throws, and never lets storage break the pick.** Step 1 is the
 * user-visible action and has already completed and broadcast before a single
 * byte is uploaded, so a bucket that is down, misconfigured, or absent costs a
 * vote and nothing else. That is not error handling bolted on — it is the order
 * of operations. If step 1 fails, steps 2 and 3 do not run: a pick that did not
 * happen must not appear in the vote stream.
 */
export async function submitWinnerPick(
  pick: WinnerPick,
  deps?: WinnerPickDeps,
): Promise<WinnerPickOutcome> {
  const resolved = deps ?? (await resolveDeps());
  const winner = pick.candidates.find((c) => c.configurationId === pick.configurationId);

  let upload: EvalUploadTargets | null = null;
  try {
    const response = await resolved.fetch(
      new URL(
        `/messages/${encodeURIComponent(pick.messageId)}/winner`,
        resolved.backendUrl,
      ).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${resolved.accessToken}`,
        },
        body: JSON.stringify({
          configurationId: pick.configurationId,
          transcript: winner?.transcript ?? "",
        }),
      },
    );
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null;
      return {
        winnerApplied: false,
        winnerError: detail?.error ?? `Winner was rejected: ${response.status}`,
        vote: "skipped",
        evalSet: "skipped",
      };
    }
    const body = (await response.json()) as { upload?: EvalUploadTargets | null };
    upload = body.upload ?? null;
  } catch (error) {
    return {
      winnerApplied: false,
      winnerError: error instanceof Error ? error.message : String(error),
      vote: "skipped",
      evalSet: "skipped",
    };
  }

  // Past this line the winner has been applied. Nothing below may change that.
  const outcome: WinnerPickOutcome = { winnerApplied: true, vote: "skipped", evalSet: "skipped" };
  if (!upload) return outcome;

  const context: PayloadContext = {
    votedAt: resolved.now(),
    subject: resolved.subject,
    recording: pick.referenceId ? resolved.getRecording(pick.referenceId) : undefined,
  };

  const fail = (error: unknown) => {
    outcome.storageError = error instanceof Error ? error.message : String(error);
  };

  // The vote goes first and alone. It is ~1 KB and it is the dataset; an
  // eval-set is hundreds of KB of opt-in extra, and letting the two race for a
  // phone's uplink would risk the one that matters for the sake of the one that
  // does not.
  try {
    await putJson(resolved, upload.vote.url, buildVotePayload(pick, context));
    outcome.vote = "uploaded";
  } catch (error) {
    outcome.vote = "failed";
    fail(error);
  }

  if (!pick.saveForEval) return outcome;

  const evalSet = buildEvalSetPayload(pick, context);
  if (!evalSet) return outcome; // audio is gone; nothing to save
  try {
    await putJson(resolved, upload.evalSet.url, evalSet);
    outcome.evalSet = "uploaded";
  } catch (error) {
    outcome.evalSet = "failed";
    fail(error);
  }
  return outcome;
}
