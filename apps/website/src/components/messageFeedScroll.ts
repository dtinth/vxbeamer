import type { Message } from "../store.ts";

export function getMessageFeedScrollBehavior(hasScrolledInitially: boolean): ScrollBehavior {
  return hasScrolledInitially ? "smooth" : "auto";
}

/**
 * Eval is opt-in per message (privacy) and only offered where it's possible at
 * all — the audio outlives its message only in this tab's memory, and a
 * client-only connect-error placeholder (`message.connectionError`) has no
 * server-side message to submit a winner against in the first place.
 */
export function canEvalMessage(message: Message, hasRetainedAudio: boolean): boolean {
  return message.status !== "recording" && !message.connectionError && hasRetainedAudio;
}

/** What a message's bubble shows: the final transcript once there is one,
 *  falling back to a live partial, then a spinner placeholder while still
 *  recording, then the error text if the recording failed outright. */
export function getMessageDisplayText(message: Message): string {
  return (
    message.final ??
    message.partial ??
    (message.status === "recording" ? "…" : (message.error ?? ""))
  );
}

/**
 * A connect-error placeholder has an error string, not a transcript — there
 * is nothing to copy. A message still recording is copyable too, but only
 * once `final` has actually arrived: the backend can deliver the finished
 * transcript slightly ahead of the follow-up event that flips `status` to
 * `"done"`, so gating on `status` alone leaves a real window where the full
 * transcript is already on screen but copying it silently does nothing.
 */
export function isMessageCopyable(message: Message): boolean {
  const settled = message.status !== "recording" || !!message.final;
  return settled && !message.connectionError && !!getMessageDisplayText(message);
}

/**
 * A connect-error placeholder has no server-assigned position in the
 * conversation — it always sorts after every real message, regardless of
 * when the recording was attempted.
 */
export function compareMessagesForDisplay(a: Message, b: Message): number {
  if (!!a.connectionError !== !!b.connectionError) return a.connectionError ? 1 : -1;
  return a.createdAt - b.createdAt;
}

/**
 * The id of the most recent copyable message, in display order — what the
 * `c` keyboard shortcut copies (dtinth/vxbeamer#86). `null` when nothing
 * copyable exists yet.
 */
export function selectLatestCopyableMessageId(messages: Iterable<Message>): string | null {
  const sorted = Array.from(messages).sort(compareMessagesForDisplay);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const candidate = sorted[i];
    if (candidate && isMessageCopyable(candidate)) return candidate.id;
  }
  return null;
}

/** Fallback delay for pruning trimmed bubbles when `scrollend` never fires
 *  (e.g. the feed was already at the bottom, so no scroll animation runs). */
export const MESSAGE_FEED_PRUNE_FALLBACK_MS = 700;

/**
 * The tail of `messages` that the feed should keep mounted. `limit === null`
 * keeps everything; otherwise the newest `limit` entries survive. Order is
 * preserved, and the input is never mutated.
 */
export function selectVisibleMessages<T>(messages: readonly T[], limit: number | null): T[] {
  if (limit === null || messages.length <= limit) return messages.slice();
  return messages.slice(messages.length - limit);
}

export const MESSAGE_CARD_ACTION_WIDTH = 120;

export const MESSAGE_CARD_SNAP_TOLERANCE = 24;

export type MessageCardSnapAction = "swipe-left" | "swipe-right" | null;

export function getMessageCardInitialScrollLeft(actionWidth = MESSAGE_CARD_ACTION_WIDTH): number {
  return actionWidth;
}

export function getMessageCardSnapAction(
  scrollLeft: number,
  actionWidth = MESSAGE_CARD_ACTION_WIDTH,
  tolerance = MESSAGE_CARD_SNAP_TOLERANCE,
): MessageCardSnapAction {
  if (scrollLeft <= tolerance) return "swipe-right";
  if (scrollLeft >= actionWidth * 2 - tolerance) return "swipe-left";
  return null;
}
