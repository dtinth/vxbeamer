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
