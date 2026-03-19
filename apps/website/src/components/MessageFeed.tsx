import { useEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import { $messages, $sessionToken, $backendUrl, type Message } from "../store.ts";

const SWIPE_THRESHOLD = 80;

function MessageCard({
  message,
  authToken,
  backendUrl,
}: {
  message: Message;
  authToken: string;
  backendUrl: string;
}) {
  const [copied, setCopied] = useState(false);
  const [offset, setOffset] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const startXRef = useRef(0);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);

  const text =
    message.final ??
    message.partial ??
    (message.status === "recording" ? "…" : (message.error ?? ""));

  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const copyable = message.status !== "recording" && !!text;
  const swipeable = message.status !== "recording";

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!swipeable) return;
    startXRef.current = e.touches[0]!.clientX;
    draggingRef.current = true;
    movedRef.current = false;
    setTransitioning(false);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!draggingRef.current) return;
    const dx = e.touches[0]!.clientX - startXRef.current;
    if (Math.abs(dx) > 5) movedRef.current = true;
    setOffset(dx);
  };

  const handleTouchEnd = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setTransitioning(true);

    if (offset < -SWIPE_THRESHOLD) {
      setOffset(-window.innerWidth);
      void fetch(new URL(`/messages/${message.id}`, backendUrl).toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
    } else if (offset > SWIPE_THRESHOLD) {
      void fetch(new URL(`/messages/${message.id}/swipe`, backendUrl).toString(), {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
      setOffset(0);
    } else {
      setOffset(0);
    }
  };

  const handleClick = () => {
    if (movedRef.current) return;
    if (!copyable) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const direction = offset < 0 ? "left" : offset > 0 ? "right" : null;

  return (
    <div className="relative mx-3 my-2 overflow-hidden rounded-2xl">
      {/* Action background */}
      <div
        className={[
          "absolute inset-0 flex items-center px-5 transition-opacity",
          direction === "left"
            ? "justify-end bg-red-500/80"
            : direction === "right"
              ? "justify-start bg-teal-500/80"
              : "opacity-0",
        ].join(" ")}
      >
        {direction === "left" && (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4h6v2" />
          </svg>
        )}
        {direction === "right" && (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        )}
      </div>

      {/* Card */}
      <div
        style={{
          transform: `translateX(${offset}px)`,
          transition: transitioning ? "transform 0.25s ease" : "none",
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={handleClick}
        className={`bg-gray-900 rounded-2xl px-4 py-3 ${copyable ? "cursor-pointer active:bg-white/5" : ""}`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-white/40">{time}</span>
          {message.status === "recording" && (
            <span className="flex items-center gap-1 text-xs text-red-400">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse inline-block" />
              Recording
            </span>
          )}
          {message.status === "error" && <span className="text-xs text-red-400">Error</span>}
          {copied && <span className="text-xs text-green-400 ml-auto">Copied</span>}
        </div>
        <p className="text-sm text-white/90 whitespace-pre-wrap leading-relaxed">{text}</p>
      </div>
    </div>
  );
}

export function MessageFeed() {
  const messages = useStore($messages);
  const authToken = useStore($sessionToken);
  const backendUrl = useStore($backendUrl);
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
    <div className="flex-1 overflow-y-auto py-1">
      {messages.map((msg) => (
        <MessageCard
          key={msg.id}
          message={msg}
          authToken={authToken ?? ""}
          backendUrl={backendUrl}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
