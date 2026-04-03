import { expect, test } from "vite-plus/test";
import { createSubjectStore, type Message } from "./store.ts";

function createMessage(id: string, updatedAt = Date.now()): Message {
  return {
    id,
    status: "recording",
    createdAt: updatedAt,
    updatedAt,
  };
}

test("stores and retrieves messages per subject", () => {
  const store = createSubjectStore();
  const user1Message = createMessage("message-1");
  const user2Message = createMessage("message-2");

  store.addMessage("user-1", user1Message);
  store.addMessage("user-2", user2Message);

  expect(store.listMessages("user-1")).toEqual([user1Message]);
  expect(store.listMessages("user-2")).toEqual([user2Message]);
  expect(store.findMessage("user-1", "message-2")).toBeUndefined();
});

test("delete and broadcasts stay within the same subject", () => {
  const store = createSubjectStore();
  const user1Events: string[] = [];
  const user2Events: string[] = [];
  const message = createMessage("message-1");

  store.addMessage("user-1", message);
  const unsubscribeUser1 = store.subscribe("user-1", (payload) => user1Events.push(payload));
  const unsubscribeUser2 = store.subscribe("user-2", (payload) => user2Events.push(payload));

  store.broadcast("user-1", { type: "updated", message });
  expect(user1Events).toEqual([JSON.stringify({ type: "updated", message })]);
  expect(user2Events).toEqual([]);

  expect(store.deleteMessage("user-2", "message-1")).toBe(false);
  expect(store.deleteMessage("user-1", "message-1")).toBe(true);
  expect(store.listMessages("user-1")).toEqual([]);

  unsubscribeUser1();
  unsubscribeUser2();
});
