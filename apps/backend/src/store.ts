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

export function createSubjectStore() {
  const messagesBySubject = new Map<string, Message[]>();
  const sseClientsBySubject = new Map<string, Set<SseSend>>();

  function ensureMessages(subject: string): Message[] {
    let messages = messagesBySubject.get(subject);
    if (!messages) {
      messages = [];
      messagesBySubject.set(subject, messages);
    }
    return messages;
  }

  function ensureSseClients(subject: string): Set<SseSend> {
    let clients = sseClientsBySubject.get(subject);
    if (!clients) {
      clients = new Set();
      sseClientsBySubject.set(subject, clients);
    }
    return clients;
  }

  function pruneMessages(subject: string): Message[] {
    const messages = ensureMessages(subject);
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
      ensureMessages(subject).push(message);
    },

    deleteMessage(subject: string, id: string): boolean {
      const messages = pruneMessages(subject);
      const index = messages.findIndex((message) => message.id === id);
      if (index === -1) return false;
      messages.splice(index, 1);
      return true;
    },

    subscribe(subject: string, send: SseSend): () => void {
      const clients = ensureSseClients(subject);
      clients.add(send);
      return () => {
        clients.delete(send);
        if (clients.size === 0) sseClientsBySubject.delete(subject);
      };
    },

    broadcast(subject: string, payload: unknown): void {
      const data = JSON.stringify(payload);
      const clients = sseClientsBySubject.get(subject);
      if (!clients) return;
      for (const send of clients) send(data);
    },
  };
}
