export function getMessageFeedScrollBehavior(hasScrolledInitially: boolean): ScrollBehavior {
  return hasScrolledInitially ? "smooth" : "auto";
}

export const MESSAGE_CARD_ACTION_WIDTH = 96;

const MESSAGE_CARD_SNAP_TOLERANCE = 24;

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
