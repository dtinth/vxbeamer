import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";
import { $messages, type Message } from "../store.ts";

function MessageCard({ message }: { message: Message }) {
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const text =
    message.final ??
    message.partial ??
    (message.status === "recording" ? "…" : (message.error ?? ""));

  return (
    <div className="px-4 py-3 border-b border-white/5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-white/40">{time}</span>
        {message.status === "recording" && (
          <span className="flex items-center gap-1 text-xs text-red-400">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse inline-block" />
            Recording
          </span>
        )}
        {message.status === "error" && <span className="text-xs text-red-400">Error</span>}
      </div>
      <p className="text-sm text-white/90 whitespace-pre-wrap leading-relaxed">{text}</p>
    </div>
  );
}

export function MessageFeed() {
  const messages = useStore($messages);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-white/30 text-sm">No messages yet. Start speaking.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {messages.map((msg) => (
        <MessageCard key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
