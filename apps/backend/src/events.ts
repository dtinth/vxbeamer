import type { Message } from "./store.ts";

export interface SwipedEvent {
  type: "swiped";
  eventId: string;
  message: Message;
}

export function createSwipedEvent(message: Message): SwipedEvent {
  return {
    type: "swiped",
    eventId: crypto.randomUUID(),
    message,
  };
}
