import { expect, test, vi } from "vite-plus/test";
import { createSwipedEvent } from "./events.ts";
import type { Message } from "./store.ts";

function createMessage(): Message {
  return {
    id: "message-1",
    status: "done",
    final: "Hello",
    createdAt: 1,
    updatedAt: 1,
  };
}

test("createSwipedEvent assigns a unique event id", () => {
  const randomUuid = vi
    .spyOn(crypto, "randomUUID")
    .mockReturnValue("11111111-1111-1111-1111-111111111111");

  const event = createSwipedEvent(createMessage());

  expect(event).toEqual({
    type: "swiped",
    eventId: "11111111-1111-1111-1111-111111111111",
    message: createMessage(),
  });

  randomUuid.mockRestore();
});
