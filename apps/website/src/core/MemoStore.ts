import { atom, computed, type ReadableAtom, type WritableAtom } from "nanostores";

/**
 * What the feed shows, and where it comes from, with nothing in it that
 * touches the browser.
 *
 * A *memo* is one recording as the user sees it. It can be made of up to three
 * things, joined by `referenceId` (the id the client mints for a recording and
 * the backend echoes on its message):
 *
 * - the **transcript**, a server message. The feed carries every signed-in
 *   device's messages, so a memo recorded on another device is just a
 *   transcript with no audio here;
 * - the **audio**, kept on this device (see `recordedAudio.ts`), together with
 *   the last transcript the server gave for it; and
 * - a **connect error**, when this tab's `/ws` for the recording never opened.
 *
 * The server only remembers messages for so long. A memo whose audio is here
 * keeps the transcript it was given, so it outlives the server's copy and goes
 * when its audio does (the user deletes it, or it ages out of the storage cap).
 *
 * A recording whose audio is here but which has no transcript at all (recorded
 * offline, or the tab reloaded before it connected) shows as "not transcribed
 * yet": a retryable memo, so the audio can be sent again.
 *
 * The device and the network come in as {@link MemoPorts}, so all of this is
 * plain state: events in, one `memos` store out.
 */

export interface Message {
  id: string;
  referenceId?: string;
  status: "recording" | "done" | "error";
  partial?: string;
  final?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** The model configuration that authored `final` — the recording's own, or an eval winner's. */
  configurationId?: string;
  /**
   * Client-synthesized placeholder for a recording with no server message —
   * its `/ws` connect failed or timed out, or it was never transcribed — never
   * set by the server. Marks the bubble as retryable and is reconciled away
   * once the real message for the same `referenceId` arrives over SSE.
   */
  connectionError?: boolean;
}

/** The part of the server's event stream that changes which messages exist. */
export type FeedEvent =
  | { type: "snapshot"; messages: Message[] }
  | { type: "created"; message: Message }
  | { type: "updated"; message: Message }
  | { type: "deleted"; messageId: string };

export interface SavedAudio {
  /** When the recording started (epoch ms), for placing it in the feed. */
  createdAt: number;
  /** The last finished transcript the server gave for this recording, if any. */
  transcript?: Message;
}

export interface MemoPorts {
  /** Recordings whose audio is on this device, by reference id. */
  audio: ReadableAtom<ReadonlyMap<string, SavedAudio>>;
  /** Erase the audio (and transcript) of recordings that no longer have a memo. */
  removeAudio(referenceIds: readonly string[]): void;
  /** Keep a finished transcript with its recording's audio, if that audio is here. */
  rememberTranscript(message: Message): void;
}

export const NOT_TRANSCRIBED_YET = "Not transcribed yet";

export function localMemoId(referenceId: string): string {
  return `local:${referenceId}`;
}

function collectReferenceIds(messages: Iterable<Message>): Set<string> {
  const referenceIds = new Set<string>();
  for (const message of messages) {
    if (message.referenceId) referenceIds.add(message.referenceId);
  }
  return referenceIds;
}

export class MemoStore {
  private readonly ports: MemoPorts;
  /** The server's messages, as the feed last described them. */
  private readonly serverMessages = atom<Map<string, Message>>(new Map());
  /** Client-only error bubbles, kept apart from server state so a snapshot cannot wipe them. */
  private readonly connectionErrors = atom<Map<string, Message>>(new Map());
  /** Whether the feed has described the server's state at least once. */
  private readonly feedReady = atom(false);
  /** Recordings started (or re-sent) in this page's life: their own connection is still handling them. */
  private readonly live = atom<ReadonlySet<string>>(new Set());

  /** The server's messages. Written through {@link applyFeedEvent}; tests may seed it directly. */
  readonly messages: WritableAtom<Map<string, Message>> = this.serverMessages;
  readonly localConnectionErrors: ReadableAtom<Map<string, Message>> = this.connectionErrors;

  /** What the feed renders. */
  readonly memos: ReadableAtom<Map<string, Message>>;

  constructor(ports: MemoPorts) {
    this.ports = ports;
    this.memos = computed(
      [this.serverMessages, this.connectionErrors, this.feedReady, this.live, ports.audio],
      (messages, connectionErrors, feedReady, live, audio) => {
        const serverRefs = collectReferenceIds(messages.values());
        let merged: Map<string, Message> | null = null;
        const add = (id: string, memo: Message) => {
          merged ??= new Map(messages);
          merged.set(id, memo);
        };

        for (const [referenceId, placeholder] of connectionErrors) {
          if (!serverRefs.has(referenceId)) add(localMemoId(referenceId), placeholder);
        }
        for (const [referenceId, saved] of audio) {
          if (serverRefs.has(referenceId) || live.has(referenceId)) continue;
          if (connectionErrors.has(referenceId)) continue;
          // The server no longer has it (or has not said yet), but this device
          // kept the transcript.
          if (saved.transcript) {
            add(saved.transcript.id, saved.transcript);
            continue;
          }
          // Audio with no transcript, once the feed has had its say: the
          // server's messages are not known until then, so nothing is "missing"
          // yet. A recording this page is itself still delivering is not either.
          if (feedReady) {
            add(localMemoId(referenceId), {
              id: localMemoId(referenceId),
              referenceId,
              status: "error",
              error: NOT_TRANSCRIBED_YET,
              connectionError: true,
              createdAt: saved.createdAt,
              updatedAt: saved.createdAt,
            });
          }
        }
        return merged ?? messages;
      },
    );
  }

  applyFeedEvent(event: FeedEvent): void {
    if (event.type === "snapshot") {
      const next = new Map(event.messages.map((m) => [m.id, m]));
      this.serverMessages.set(next);
      this.feedReady.set(true);
      // A message the list leaves out is not erased here: the server only
      // keeps messages for so long, and the device keeps what it has.
      for (const message of next.values()) this.remember(message);
    } else if (event.type === "created" || event.type === "updated") {
      const next = new Map(this.serverMessages.get());
      next.set(event.message.id, event.message);
      this.serverMessages.set(next);
      this.remember(event.message);
    } else {
      const next = new Map(this.serverMessages.get());
      const removed = next.get(event.messageId);
      next.delete(event.messageId);
      this.serverMessages.set(next);
      // Deleted on purpose (from here or another device), unlike a message that
      // merely aged out of the server's list. It may be a memo only this
      // device still shows, so look at the saved transcripts too.
      let referenceId = removed?.referenceId;
      if (!referenceId) {
        for (const [ref, saved] of this.ports.audio.get()) {
          if (saved.transcript?.id === event.messageId) referenceId = ref;
        }
      }
      if (referenceId) this.ports.removeAudio([referenceId]);
    }
  }

  /** Keep a finished transcript with its audio; a partial one is still changing. */
  private remember(message: Message): void {
    if (message.referenceId && message.status !== "recording") {
      this.ports.rememberTranscript(message);
    }
  }

  /** This page started delivering a recording; until its own connection gives up, it is not "missing". */
  markLive(referenceId: string): void {
    if (this.live.get().has(referenceId)) return;
    this.live.set(new Set(this.live.get()).add(referenceId));
  }

  /**
   * Show (or update) a client-only error bubble for a recording whose `/ws`
   * connect failed or timed out — there is no server message to attach an
   * error to yet, since the backend only creates one once the socket opens.
   */
  setConnectionError(referenceId: string, error: string, now = Date.now()): void {
    const map = new Map(this.connectionErrors.get());
    const existing = map.get(referenceId);
    map.set(referenceId, {
      id: localMemoId(referenceId),
      referenceId,
      status: "error",
      error,
      connectionError: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.connectionErrors.set(map);
  }

  /** The recording's connect error is over (it opened). Its audio stays: the transcript is on its way. */
  clearConnectionError(referenceId: string): void {
    if (!this.connectionErrors.get().has(referenceId)) return;
    const map = new Map(this.connectionErrors.get());
    map.delete(referenceId);
    this.connectionErrors.set(map);
  }

  /** The user dismissed a memo that has no server message: its error and its audio go. */
  forget(referenceId: string): void {
    this.clearConnectionError(referenceId);
    if (this.live.get().has(referenceId)) {
      const live = new Set(this.live.get());
      live.delete(referenceId);
      this.live.set(live);
    }
    this.ports.removeAudio([referenceId]);
  }
}
