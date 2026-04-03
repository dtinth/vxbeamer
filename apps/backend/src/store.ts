import type { UsageRecord } from "vxasr";

const ONE_DAY_MS = 86_400_000;

export interface Message {
  id: string;
  referenceId?: string;
  status: "recording" | "done" | "error";
  partial?: string;
  final?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  usage?: UsageRecord[];
}

type SseSend = (data: string) => void;

interface SubjectState {
  messages: Message[];
  sseClients: Set<SseSend>;
}

export function createSubjectStore() {
  const stateBySubject = new Map<string, SubjectState>();

  function ensureState(subject: string): SubjectState {
    let state = stateBySubject.get(subject);
    if (!state) {
      state = {
        messages: [],
        sseClients: new Set(),
      };
      stateBySubject.set(subject, state);
    }
    return state;
  }

  function pruneMessages(subject: string): Message[] {
    const { messages } = ensureState(subject);
    const cutoff = Date.now() - ONE_DAY_MS;
    let i = 0;
    while (i < messages.length && messages[i]!.updatedAt < cutoff) i++;
    if (i > 0) messages.splice(0, i);
    return messages;
  }

  return {
    listMessages(subject: string): Message[] {
      return pruneMessages(subject);
    },

    findMessage(subject: string, id: string): Message | undefined {
      return pruneMessages(subject).find((message) => message.id === id);
    },

    addMessage(subject: string, message: Message): void {
      ensureState(subject).messages.push(message);
    },

    deleteMessage(subject: string, id: string): boolean {
      const messages = pruneMessages(subject);
      const index = messages.findIndex((message) => message.id === id);
      if (index === -1) return false;
      messages.splice(index, 1);
      return true;
    },

    subscribe(subject: string, send: SseSend): () => void {
      const { sseClients } = ensureState(subject);
      sseClients.add(send);
      return () => {
        const state = stateBySubject.get(subject);
        if (!state) return;
        state.sseClients.delete(send);
        if (state.messages.length === 0 && state.sseClients.size === 0) {
          stateBySubject.delete(subject);
        }
      };
    },

    broadcast(subject: string, payload: unknown): void {
      const data = JSON.stringify(payload);
      const clients = stateBySubject.get(subject)?.sseClients;
      if (!clients) return;
      for (const send of clients) send(data);
    },
  };
}
