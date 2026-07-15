import { atom, computed, type ReadableAtom } from "nanostores";
import { RETAINED_AUDIO_FORMAT } from "./recordedAudio.ts";

/**
 * An eval run: one retained recording, replayed against every configuration at
 * once, judged by a human.
 *
 * The fan-out lives here rather than on the backend (dtinth/vxbeamer#38) — the
 * frontend opens one `/asr/eval` socket per configuration and replays the same
 * PCM through all of them in parallel. Two consequences shape this module:
 *
 * 1. **Parallel, so an eval costs one clip's worth of wall-clock**, not N of
 *    them. A 9 s clip evaluates in ~9.5 s whether the set holds two
 *    configurations or six. That is why the dialog can show a clip-length
 *    progress bar instead of an indeterminate multi-minute spinner.
 * 2. **Realtime pacing is a correctness requirement, not a slider.** Each
 *    socket gets one 3200-byte frame every 100 ms. This is not an optimisation
 *    target: BytePlus hangs outright on a fast dump and never returns a final,
 *    and vendors document a 100–200 ms send interval. Billing is per
 *    audio-second rather than connection-second, so pacing is also free. The
 *    obvious "speed-up" — dumping the buffer — breaks the feature.
 *
 * Privacy: the PCM this replays never leaves memory. It goes into these sockets
 * and nowhere else. Nothing here writes to disk, localStorage or IndexedDB.
 */

/** One 100 ms frame at 16 kHz / 16-bit / mono. */
export const EVAL_FRAME_BYTES = 3200;

/** See the note above. Do not tune this down. */
export const EVAL_FRAME_INTERVAL_MS = 100;

/** Wire shape of `UsageRecord` — mirrors what `/asr/eval` sends as JSON. */
export interface EvalUsageRecord {
  sku: string;
  unitPrice: number;
  quantity: number;
}

/** Server -> client on `/asr/eval`. Mirrors `EvalServerEvent` on the backend. */
export type EvalServerEvent =
  | { type: "ready"; configurationId: string }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "usage"; records: EvalUsageRecord[] }
  | { type: "end" }
  | { type: "error"; message: string };

/** A candidate, as `GET /asr/configurations` describes it. */
export interface EvalConfiguration {
  id: string;
  label: string;
  configured: boolean;
}

/**
 * Where a row is, from the user's point of view.
 *
 * `listening` and `finishing` are split because they are different waits, and
 * the difference is the whole reason rows do not behave uniformly. A streaming
 * adapter does its work during `listening`, emitting partials as it goes (Qwen
 * emits ~84 on a 9 s clip). A buffering batch adapter is silent through
 * `listening` and only calls its vendor once the audio stops — all of its work
 * happens in `finishing`. A row that shows nothing but an ellipsis is therefore
 * healthy, not stuck, and the layout must not imply otherwise.
 */
export type EvalRowStatus =
  | "skipped"
  | "connecting"
  | "listening"
  | "finishing"
  | "done"
  | "failed";

export interface EvalRow {
  configurationId: string;
  label: string;
  /** The configuration that produced the message's current answer. */
  isPrimary: boolean;
  status: EvalRowStatus;
  /** Live interim text. Stays empty for a row that never streams. */
  partial: string;
  /** The transcript to vote for. Only a row with one can win. */
  final: string | null;
  error: string | null;
  usage: EvalUsageRecord[];
  /** Frames of this clip pushed into this row's socket so far. */
  framesSent: number;
}

export interface EvalSocketHandlers {
  onEvent(event: EvalServerEvent): void;
  onClose(info: { code: number; reason: string }): void;
}

export interface EvalSocket {
  send(data: ArrayBuffer | string): void;
  close(): void;
}

/** Opens one eval socket. Injected so a run can be driven without a network. */
export type EvalConnect = (configurationId: string, handlers: EvalSocketHandlers) => EvalSocket;

export interface EvalTimers {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface EvalRunOptions {
  configurations: readonly EvalConfiguration[];
  /** Marks the row whose answer a winner would replace. */
  primaryConfigurationId?: string | null;
  /** The retained recording's PCM, in capture order. */
  chunks: readonly ArrayBuffer[];
  connect: EvalConnect;
  timers?: EvalTimers;
}

export interface EvalRun {
  readonly $rows: ReadableAtom<readonly EvalRow[]>;
  /** How much of the clip has been replayed, 0..1. */
  readonly $progress: ReadableAtom<number>;
  /** True once no row can change again. */
  readonly $settled: ReadableAtom<boolean>;
  readonly frameCount: number;
  /** Close every socket and stop replaying. Idempotent. */
  cancel(): void;
}

const defaultTimers: EvalTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Re-cuts captured PCM into the frames a vendor expects.
 *
 * The AudioWorklet hands over 128-sample chunks — 256 bytes, 8 ms each — which
 * is a render-quantum artefact, not a wire format. Replaying those one per
 * 100 ms would stretch a 9 s clip over 5 minutes, so the audio is concatenated
 * and re-cut into 100 ms frames. The last frame is short whenever the clip does
 * not divide evenly; a vendor takes it as the tail it is.
 */
export function toPacedFrames(
  chunks: readonly ArrayBuffer[],
  frameBytes: number = EVAL_FRAME_BYTES,
): ArrayBuffer[] {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  const frames: ArrayBuffer[] = [];
  for (let start = 0; start < total; start += frameBytes) {
    frames.push(joined.slice(start, Math.min(start + frameBytes, total)).buffer);
  }
  return frames;
}

/** How long a run will take: the clip's own duration, however many rows there are. */
export function evalDurationSeconds(chunks: readonly ArrayBuffer[]): number {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  return total / RETAINED_AUDIO_FORMAT.bytesPerSecond;
}

/** What a row's usage records add up to, in USD. */
export function evalRowCost(row: EvalRow): number {
  return row.usage.reduce((sum, record) => sum + record.unitPrice * record.quantity, 0);
}

/**
 * Builds the URL for one configuration's eval socket.
 *
 * `URLSearchParams` is not a convenience here, it is the requirement: a
 * configuration id may contain `+` (`qwen/qwen3-asr-flash-realtime+groq`), and
 * a hand-concatenated query string would send that `+` literally, which the
 * server decodes back as a space and then fails to recognise. `set`
 * percent-encodes it.
 */
export function buildEvalSocketUrl(options: {
  backendUrl: string;
  accessToken: string;
  configurationId: string;
}): string {
  const url = new URL(options.backendUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/asr/eval";
  url.search = "";
  url.searchParams.set("access_token", options.accessToken);
  url.searchParams.set("configuration", options.configurationId);
  return url.toString();
}

/** The real transport: one WebSocket per configuration. */
export function createEvalConnect(options: {
  backendUrl: string;
  accessToken: string;
}): EvalConnect {
  return (configurationId, handlers) => {
    const ws = new WebSocket(buildEvalSocketUrl({ ...options, configurationId }));
    ws.binaryType = "arraybuffer";

    ws.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      try {
        handlers.onEvent(JSON.parse(event.data) as EvalServerEvent);
      } catch {
        // ignore malformed frames
      }
    });
    // `error` is always followed by `close`, so failures need one path only.
    ws.addEventListener("close", (event) => {
      handlers.onClose({ code: event.code, reason: event.reason });
    });

    return {
      send(data) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(data);
      },
      close() {
        ws.close();
      },
    };
  };
}

function initialRow(
  configuration: EvalConfiguration,
  primaryConfigurationId: string | null | undefined,
): EvalRow {
  return {
    configurationId: configuration.id,
    label: configuration.label,
    isPrimary: configuration.id === primaryConfigurationId,
    // An unconfigured configuration is listed by the server precisely so the
    // gap is visible, with a note that a client should not fan out to it — the
    // socket would open and shut. So it gets a row and no connection: the user
    // sees that the model exists and why it has no answer, and no eval spends
    // ten seconds discovering what the server already said.
    status: configuration.configured ? "connecting" : "skipped",
    partial: "",
    final: null,
    error: configuration.configured ? null : "Not configured on this server",
    usage: [],
    framesSent: 0,
  };
}

const TERMINAL: ReadonlySet<EvalRowStatus> = new Set<EvalRowStatus>(["skipped", "done", "failed"]);

export function isEvalRowSettled(row: EvalRow): boolean {
  return TERMINAL.has(row.status);
}

/** Only a row that produced a transcript can be voted for. */
export function canWinEval(row: EvalRow): boolean {
  return row.status === "done" && !!row.final;
}

export function startEvalRun(options: EvalRunOptions): EvalRun {
  const timers = options.timers ?? defaultTimers;
  const frames = toPacedFrames(options.chunks);
  const $rows = atom<readonly EvalRow[]>(
    options.configurations.map((configuration) =>
      initialRow(configuration, options.primaryConfigurationId),
    ),
  );

  let cancelled = false;
  const sockets: EvalSocket[] = [];
  const pumpTimers: number[] = [];

  const patch = (index: number, changes: Partial<EvalRow>): void => {
    const rows = $rows.get();
    const row = rows[index];
    if (!row) return;
    const next = [...rows];
    next[index] = { ...row, ...changes };
    $rows.set(next);
  };

  options.configurations.forEach((configuration, index) => {
    if (!configuration.configured) return;

    let socket: EvalSocket | null = null;
    let timer: number | null = null;
    let framesSent = 0;
    let stopped = false;

    const stopPump = (): void => {
      if (timer === null) return;
      timers.clearTimeout(timer);
      timer = null;
    };

    /**
     * One frame per tick. Each socket paces from its own `ready` rather than
     * from a clock shared across the run: a socket that connects late must
     * still hear its audio at 1x, and catching it up in a burst would be the
     * fast dump this whole module exists to avoid.
     */
    const pump = (): void => {
      if (cancelled || stopped) return;
      if (framesSent >= frames.length) {
        stopped = true;
        socket?.send(JSON.stringify({ type: "stop" }));
        // The audio is all in. Whatever happens now is the vendor's own
        // latency — or, for a buffering adapter, its entire transcription.
        patch(index, { status: "finishing" });
        return;
      }
      socket?.send(frames[framesSent]!);
      framesSent += 1;
      patch(index, { framesSent });
      timer = timers.setTimeout(pump, EVAL_FRAME_INTERVAL_MS);
      pumpTimers.push(timer);
    };

    socket = options.connect(configuration.id, {
      onEvent(event) {
        if (cancelled) return;
        switch (event.type) {
          case "ready":
            patch(index, { status: "listening" });
            pump();
            break;
          case "partial":
            patch(index, { partial: event.text });
            break;
          case "final":
            patch(index, { final: event.text, partial: "" });
            break;
          case "usage":
            patch(index, { usage: [...($rows.get()[index]?.usage ?? []), ...event.records] });
            break;
          case "end":
            stopped = true;
            stopPump();
            patch(index, { status: "done" });
            break;
          case "error":
            stopped = true;
            stopPump();
            patch(index, { status: "failed", error: event.message, partial: "" });
            break;
        }
      },

      onClose(info) {
        stopped = true;
        stopPump();
        if (cancelled) return;
        const row = $rows.get()[index];
        if (!row || isEvalRowSettled(row)) return;
        // A socket that shut without an `end` failed, whatever it managed to
        // say first. The close reason is where the server puts the diagnosis
        // for a rejected configuration ("... is not enabled", "GROQ_API_KEY not
        // configured"), so it is worth more to the user than the code.
        // `||` rather than `??`: an abnormal close (1006) carries an empty
        // reason, not a missing one, and "" tells the user nothing.
        patch(index, {
          status: "failed",
          error: row.error || info.reason || `Connection closed (${info.code})`,
          partial: "",
        });
      },
    });
    sockets.push(socket);
  });

  return {
    $rows,
    // The bar tracks the clip, not the models: every row replays the same
    // audio at the same pace, so the furthest-along row is how far the replay
    // has got. Rows that lag behind say so themselves, in their own status.
    $progress: computed($rows, (rows) => {
      if (frames.length === 0) return 1;
      const sent = rows.reduce((most, row) => Math.max(most, row.framesSent), 0);
      return Math.min(1, sent / frames.length);
    }),
    $settled: computed($rows, (rows) => rows.every(isEvalRowSettled)),
    frameCount: frames.length,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const timer of pumpTimers) timers.clearTimeout(timer);
      for (const socket of sockets) socket.close();
    },
  };
}
