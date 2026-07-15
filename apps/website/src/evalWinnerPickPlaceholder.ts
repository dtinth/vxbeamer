import type { EvalUsageRecord } from "./evalRun.ts";

/**
 * TEMPORARY — delete this whole file when `evalUpload.ts` lands.
 *
 * The real implementation is `submitWinnerPick` in `apps/website/src/evalUpload.ts`,
 * built in parallel on `feat/vote-and-eval-set-upload` (dtinth/vxbeamer#42/#43).
 * It is not on this branch, so the dialog would not compile against it and the
 * prototype could not be run or demonstrated. This stands in until then.
 *
 * It deliberately mirrors that module's exported signature and semantics
 * exactly — same `WinnerPick` in, same `WinnerPickOutcome` out, same "never
 * throws" contract — so integrating is:
 *
 *   1. delete this file;
 *   2. in `EvalDialog.tsx`, change the import to `./evalUpload.ts`.
 *
 * There is no third step, and no second call site: this is the only place the
 * dialog posts a winner, so the duplicated `POST /winner` and double vote that
 * two independent call sites would cause cannot survive the swap.
 *
 * What this does NOT do, and must never be extended to do: mint presigned URLs,
 * encode WAV, or upload anything. Storage is the other module's job. This posts
 * the winner and stops.
 */

/** Mirrors `EvalCandidateResult` in `evalUpload.ts`. */
export interface EvalCandidateResult {
  configurationId: string;
  transcript?: string;
  usage?: readonly EvalUsageRecord[];
  latencyMs?: number;
  error?: string;
}

/** Mirrors `WinnerPick` in `evalUpload.ts`. */
export interface WinnerPick {
  messageId: string;
  referenceId?: string;
  configurationId: string;
  primaryConfigurationId?: string;
  candidates: readonly EvalCandidateResult[];
  saveForEval: boolean;
}

export type UploadOutcome = "uploaded" | "skipped" | "failed";

/** Mirrors `WinnerPickOutcome` in `evalUpload.ts`. */
export interface WinnerPickOutcome {
  winnerApplied: boolean;
  winnerError?: string;
  vote: UploadOutcome;
  evalSet: UploadOutcome;
  storageError?: string;
}

export interface WinnerPickDeps {
  backendUrl: string;
  accessToken: string;
  fetch: typeof fetch;
}

/**
 * Applies a winner pick, and only that.
 *
 * `vote` and `evalSet` always report `"skipped"`: nothing here uploads, because
 * `saveForEval` has nowhere to go until the storage module lands. The field is
 * carried on {@link WinnerPick} regardless so the dialog is already passing the
 * checkbox state the real implementation needs, and the swap changes no caller.
 */
export async function submitWinnerPick(
  pick: WinnerPick,
  deps: WinnerPickDeps,
): Promise<WinnerPickOutcome> {
  const winner = pick.candidates.find((c) => c.configurationId === pick.configurationId);
  try {
    const response = await deps.fetch(
      new URL(`/messages/${encodeURIComponent(pick.messageId)}/winner`, deps.backendUrl).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.accessToken}`,
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
  } catch (error) {
    return {
      winnerApplied: false,
      winnerError: error instanceof Error ? error.message : String(error),
      vote: "skipped",
      evalSet: "skipped",
    };
  }
  return { winnerApplied: true, vote: "skipped", evalSet: "skipped" };
}
