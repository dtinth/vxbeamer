import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import { $backendUrl, $sessionToken, type Message } from "../store.ts";
import { getRetainedRecording } from "../recordedAudio.ts";
import {
  canWinEval,
  createEvalConnect,
  evalDurationSeconds,
  evalRowCost,
  startEvalRun,
  type EvalConfiguration,
  type EvalRow,
  type EvalRun,
} from "../evalRun.ts";
// One call, one call site: this applies the winner, records the vote, and
// uploads the eval-set when it is ticked (dtinth/vxbeamer#42/#43).
import { submitWinnerPick, type EvalCandidateResult } from "../evalUpload.ts";

/**
 * The Eval dialog: the same nine seconds, heard by every configuration at once.
 *
 * The layout inverts the usual model-comparison card, and does so deliberately.
 * There is no score to show — a configuration is run **once** (dtinth/vxbeamer#29),
 * because these models are non-deterministic LLMs and one sample is an act of
 * preference, not a measurement. Averaging, repeat runs and confidence
 * indicators were all explicitly ruled out: the signal lives in the vote stream
 * accumulated across many messages, not in this dialog.
 *
 * So the only thing worth looking at is the prose. The transcript gets the type
 * size and the leading; the configuration's name shrinks to an eyebrow above it
 * and the cost to fine print below. The user is reading, not scanning a
 * dashboard — and the difference between two rows is often the whole story
 * (one clip, same second: "project นี้เขียนด้วยภาษา TypeScript…" against
 * "project Niagara typescript Chai framework…").
 */

export interface EvalDialogProps {
  message: Message;
  onClose: () => void;
}

interface ConfigurationsResponse {
  primaryConfigurationId: string;
  configurations: EvalConfiguration[];
}

/**
 * Rows do not behave alike, and the layout has to hold still while they differ.
 *
 * A streaming configuration fills this box a few words at a time; a buffering
 * batch adapter shows an ellipsis for the whole clip and then drops a finished
 * paragraph in. Reserving the height means the row that says nothing for nine
 * seconds looks like it is working rather than broken, and the list does not
 * jump under the user's thumb the moment a slow row lands.
 *
 * Only for rows that could still produce text, though. A row that is out of the
 * running — failed, or never started — will never fill this, and reserving it
 * anyway spends three lines of a phone screen saying nothing. On a server with
 * a few uncredentialled configurations, that was enough to push the one row
 * with an answer below the fold.
 */
const TRANSCRIPT_MIN_HEIGHT = "3.25rem";

function statusLabel(row: EvalRow): string | null {
  switch (row.status) {
    case "connecting":
      return "Connecting";
    case "listening":
      return "Listening";
    case "finishing":
      // Named for what the user is waiting on, not for what the socket did. A
      // batch adapter does all of its work here.
      return "Transcribing";
    case "failed":
      return "Failed";
    case "skipped":
      return "Not set up";
    case "done":
      return null;
  }
}

function formatCost(cost: number): string {
  if (cost === 0) return "";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

export function EvalRowCard({
  row,
  selectable,
  pending,
  onPick,
}: {
  row: EvalRow;
  /** The run has settled and this row has a transcript to vote for. */
  selectable: boolean;
  /** This row's winner POST is in flight. */
  pending: boolean;
  onPick?: () => void;
}) {
  const label = statusLabel(row);
  const cost = formatCost(evalRowCost(row));
  const live = row.status === "listening" || row.status === "finishing";
  const out = row.status === "failed" || row.status === "skipped";

  const body = row.error ? (
    // Red is for something that broke. A configuration the server was never
    // given credentials for did not break — it was never in the running, and
    // colouring it like a fault reads as N things going wrong at once.
    <p
      className={[
        "text-sm leading-relaxed",
        row.status === "failed" ? "text-(--m3-error)" : "text-(--m3-outline)",
      ].join(" ")}
    >
      {row.error}
    </p>
  ) : row.final ? (
    <p className="text-base leading-relaxed whitespace-pre-wrap text-(--m3-on-surface)">
      {row.final}
    </p>
  ) : row.partial ? (
    <p className="text-base leading-relaxed whitespace-pre-wrap text-(--m3-on-surface-variant)">
      {row.partial}
    </p>
  ) : (
    // Not a spinner: a row may legitimately stay here for the whole clip.
    <p className="text-base leading-relaxed text-(--m3-outline)" aria-label="Waiting for text">
      {live ? <span className="eval-ellipsis">…</span> : "…"}
    </p>
  );

  const inner = (
    <>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="truncate text-xs tracking-wider text-(--m3-on-surface-variant) uppercase">
          {row.label}
        </span>
        {row.isPrimary && (
          <span
            className="flex-none rounded-full bg-(--m3-secondary-container) px-2 py-0.5 text-[10px] font-medium tracking-wider text-(--m3-on-secondary-container) uppercase"
            title="The configuration that produced this message's current answer"
          >
            Current
          </span>
        )}
        <span className="ml-auto flex flex-none items-center gap-1.5">
          {cost && <span className="font-mono text-[10px] text-(--m3-outline)">{cost}</span>}
          {label && (
            <span
              className={[
                "flex items-center gap-1 text-[10px] tracking-wider uppercase",
                row.status === "failed" ? "text-(--m3-error)" : "text-(--m3-on-surface-variant)",
              ].join(" ")}
            >
              {live && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-(--m3-primary)" />
              )}
              {label}
            </span>
          )}
        </span>
      </div>
      <div style={out ? undefined : { minHeight: TRANSCRIPT_MIN_HEIGHT }}>{body}</div>
      {selectable && (
        <p className="mt-2 text-xs font-medium text-(--m3-primary)">
          {pending ? "Saving…" : "Use this answer"}
        </p>
      )}
    </>
  );

  const className = [
    "block w-full rounded-2xl px-4 py-3 text-left transition-colors",
    selectable
      ? "cursor-pointer bg-(--m3-surface-container-high) ring-1 ring-(--m3-primary)/40 hover:bg-(--m3-surface-container-highest) focus-visible:ring-2 focus-visible:ring-(--m3-primary) focus-visible:outline-none"
      : "bg-(--m3-surface-container)",
    row.status === "skipped" || row.status === "failed" ? "opacity-70" : "",
  ].join(" ");

  if (!selectable) {
    return (
      <div className={className} data-eval-row={row.configurationId}>
        {inner}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onPick}
      disabled={pending}
      className={className}
      data-eval-row={row.configurationId}
    >
      {inner}
    </button>
  );
}

/** Mounted only once a run exists, so the run's atoms can be read with hooks. */
function EvalRunView({
  run,
  message,
  clipSeconds,
  primaryConfigurationId,
  onClose,
}: {
  run: EvalRun;
  message: Message;
  clipSeconds: number;
  /** Recorded with the vote: it is what makes a pick a defection or a confirmation. */
  primaryConfigurationId: string | undefined;
  onClose: () => void;
}) {
  const rows = useStore(run.$rows);
  const progress = useStore(run.$progress);
  const settled = useStore(run.$settled);
  const [saveForEval, setSaveForEval] = useState(false);
  const [pendingWinner, setPendingWinner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickWinner = async (row: EvalRow): Promise<void> => {
    if (!row.final || pendingWinner) return;
    setPendingWinner(row.configurationId);
    setError(null);

    // The whole ballot, not just the winner: a win is a count without it, and a
    // count is dominated by whichever configurations happened to be enabled.
    // Failures travel too — a configuration that crashed lost on availability,
    // not on quality, and collapsing the two would libel a flaky provider.
    const candidates: EvalCandidateResult[] = rows.map((candidate) => ({
      configurationId: candidate.configurationId,
      ...(candidate.final ? { transcript: candidate.final } : {}),
      ...(candidate.usage.length > 0 ? { usage: candidate.usage } : {}),
      ...(candidate.error ? { error: candidate.error } : {}),
    }));

    // No deps: the module wires its own production path, which is better than
    // anything this component could hand it — a refreshed token rather than a
    // possibly-stale one, the subject the vote needs, and the audio lookup.
    const outcome = await submitWinnerPick({
      messageId: message.id,
      referenceId: message.referenceId,
      configurationId: row.configurationId,
      primaryConfigurationId,
      candidates,
      saveForEval,
    });

    if (!outcome.winnerApplied) {
      setPendingWinner(null);
      setError(outcome.winnerError ?? "Could not save the winner");
      return;
    }

    // Storage trouble is not shown. The winner has already replaced the answer
    // and been broadcast — a vote that failed to upload is bookkeeping the user
    // can do nothing about, and an alarm about it would be an alarm about
    // something that did not go wrong.
    if (outcome.storageError) console.warn("eval: storage failed", outcome.storageError);

    onClose();
  };

  const anyWinnable = rows.some(canWinEval);

  return (
    <>
      <div className="flex-none px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold">Eval</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close eval"
            className="p-1 text-(--m3-on-surface-variant) transition-colors hover:text-(--m3-on-surface)"
          >
            ✕
          </button>
        </div>
        <p className="mt-0.5 text-xs text-(--m3-on-surface-variant)">
          {clipSeconds.toFixed(1)}s clip · {rows.length} configuration{rows.length === 1 ? "" : "s"}
        </p>
        {/* Every row hears the clip at once, so the wait is the clip's own
            length however many rows there are — a real bar, not a spinner. */}
        {!settled && (
          <div
            className="mt-3 h-0.5 w-full overflow-hidden rounded-full bg-(--m3-surface-container-highest)"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <div
              className="eval-progress h-full bg-(--m3-primary)"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
        {rows.map((row) => (
          <EvalRowCard
            key={row.configurationId}
            row={row}
            selectable={settled && canWinEval(row)}
            pending={pendingWinner === row.configurationId}
            onPick={() => void pickWinner(row)}
          />
        ))}
      </div>

      <div className="flex-none space-y-3 border-t border-(--m3-outline-variant) px-4 pt-3 pb-4">
        {error && <p className="text-xs text-(--m3-error)">{error}</p>}
        {/* Offered before the pick, because the pick is what commits it: one tap
            sends the vote and, if this is ticked, the clip and every transcript
            with it. */}
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={saveForEval}
            onChange={(event) => setSaveForEval(event.target.checked)}
            className="mt-0.5 h-4 w-4 flex-none accent-(--m3-primary)"
          />
          <span className="space-y-0.5">
            <span className="block text-sm text-(--m3-on-surface)">Save this clip for eval</span>
            <span className="block text-xs text-(--m3-on-surface-variant)">
              Uploads the audio and every transcript above. Leave it off to send only the vote.
            </span>
          </span>
        </label>
        <p className="text-xs text-(--m3-on-surface-variant)">
          {settled
            ? anyWinnable
              ? "Pick the transcript you like. It replaces this message's answer."
              : "No configuration returned a transcript."
            : "Replaying the clip…"}
        </p>
      </div>
    </>
  );
}

export function EvalDialog({ message, onClose }: EvalDialogProps) {
  const backendUrl = useStore($backendUrl);
  const authToken = useStore($sessionToken);
  const [run, setRun] = useState<EvalRun | null>(null);
  const [clipSeconds, setClipSeconds] = useState(0);
  const [primaryConfigurationId, setPrimaryConfigurationId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let started: EvalRun | null = null;
    let disposed = false;

    void (async () => {
      const recording = message.referenceId ? getRetainedRecording(message.referenceId) : undefined;
      if (!recording || recording.chunks.length === 0) {
        setError(
          recording?.droppedForSize
            ? "This recording was too long to keep, so there is nothing to replay."
            : "This message's audio is no longer in memory.",
        );
        return;
      }

      let configurations: ConfigurationsResponse;
      try {
        const response = await fetch(new URL("/asr/configurations", backendUrl).toString(), {
          headers: { Authorization: `Bearer ${authToken ?? ""}` },
        });
        if (!response.ok) throw new Error(`The server returned ${response.status}`);
        configurations = (await response.json()) as ConfigurationsResponse;
      } catch (err) {
        setError(
          err instanceof Error
            ? `Could not load the configurations: ${err.message}`
            : "Could not load the configurations",
        );
        return;
      }
      if (disposed) return;

      setClipSeconds(evalDurationSeconds(recording.chunks));
      setPrimaryConfigurationId(configurations.primaryConfigurationId);
      started = startEvalRun({
        configurations: configurations.configurations,
        primaryConfigurationId: configurations.primaryConfigurationId,
        chunks: recording.chunks,
        connect: createEvalConnect({ backendUrl, accessToken: authToken ?? "" }),
      });
      setRun(started);
    })();

    // Closing the dialog is the only stop button there is: the sockets are
    // costing money and holding this tab's audio, so they go with it.
    return () => {
      disposed = true;
      started?.cancel();
    };
  }, [message.referenceId, backendUrl, authToken]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-(--m3-scrim)/70 backdrop-blur-sm">
      <div className="h-8 flex-none" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Eval"
        className="flex min-h-0 flex-1 flex-col rounded-t-2xl bg-(--m3-surface-container-low)"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <p className="text-sm text-(--m3-error)">{error}</p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-(--m3-secondary-container) px-4 py-2 text-sm font-medium text-(--m3-on-secondary-container)"
            >
              Close
            </button>
          </div>
        ) : run ? (
          <EvalRunView
            run={run}
            message={message}
            clipSeconds={clipSeconds}
            primaryConfigurationId={primaryConfigurationId}
            onClose={onClose}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-(--m3-on-surface-variant)">Loading configurations…</p>
          </div>
        )}
      </div>
    </div>
  );
}
