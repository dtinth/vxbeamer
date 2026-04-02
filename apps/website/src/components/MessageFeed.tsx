import { useEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import {
  $activeRecordingReferenceId,
  $backendUrl,
  $lastSwipedMessage,
  $messages,
  $sessionToken,
  type Message,
} from "../store.ts";
import { getMessageFeedScrollBehavior } from "./messageFeedScroll.ts";

const SWIPE_THRESHOLD = 80;
const SWIPE_GLOW_DURATION_MS = 900;

function MessageCard({
  message,
  authToken,
  backendUrl,
  isActiveRecording,
  swipeHighlightKey,
}: {
  message: Message;
  authToken: string;
  backendUrl: string;
  isActiveRecording: boolean;
  swipeHighlightKey: number | null;
}) {
  const [copied, setCopied] = useState(false);
  const [offset, setOffset] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const [swipeGlowing, setSwipeGlowing] = useState(false);
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

  useEffect(() => {
    if (swipeHighlightKey === null) return;
    setSwipeGlowing(false);
    const frame = window.requestAnimationFrame(() => setSwipeGlowing(true));
    const timeout = window.setTimeout(() => setSwipeGlowing(false), SWIPE_GLOW_DURATION_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [swipeHighlightKey]);

  return (
    <div
      className={[
        "relative mx-3 my-2 overflow-hidden rounded-2xl transition-shadow duration-200",
        swipeGlowing ? "message-card-swipe-glow" : "",
      ].join(" ")}
    >
      {/* Action background */}
      <div
        className={[
          "absolute inset-0 flex items-center px-5 transition-opacity",
          direction === "left"
            ? "justify-end bg-(--m3-error-container)"
            : direction === "right"
              ? "justify-start bg-(--m3-tertiary-container)"
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
        className={[
          "bg-(--m3-surface-container-high) rounded-2xl px-4 py-3",
          copyable ? "cursor-pointer active:bg-(--m3-surface-container-highest)" : "",
          isActiveRecording ? "message-card-active-recording" : "",
        ].join(" ")}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-(--m3-on-surface-variant)">{time}</span>
          {message.status === "recording" && (
            <span className="flex items-center gap-1 text-xs text-(--m3-error)">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse inline-block" />
              Recording
            </span>
          )}
          {message.status === "error" && <span className="text-xs text-(--m3-error)">Error</span>}
          {copied && <span className="text-xs text-green-400 ml-auto">Copied</span>}
        </div>
        <p
          className={`text-sm whitespace-pre-wrap leading-relaxed ${message.final ? "text-(--m3-on-surface)" : "text-(--m3-on-surface-variant)"}`}
        >
          {text}
        </p>
      </div>
    </div>
  );
}

export function MessageFeed() {
  const activeRecordingReferenceId = useStore($activeRecordingReferenceId);
  const lastSwipedMessage = useStore($lastSwipedMessage);
  const messages = useStore($messages);
  const authToken = useStore($sessionToken);
  const backendUrl = useStore($backendUrl);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasScrolledInitiallyRef = useRef(false);

  useEffect(() => {
    if (messages.length === 0) return;
    bottomRef.current?.scrollIntoView({
      behavior: getMessageFeedScrollBehavior(hasScrolledInitiallyRef.current),
    });
    hasScrolledInitiallyRef.current = true;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-(--m3-on-surface-variant) text-sm">No messages yet. Start speaking.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1">
      <div className="h-[50vh]" />
      {messages.map((msg) => (
        <MessageCard
          key={msg.id}
          message={msg}
          authToken={authToken ?? ""}
          backendUrl={backendUrl}
          isActiveRecording={
            !!activeRecordingReferenceId && msg.referenceId === activeRecordingReferenceId
          }
          swipeHighlightKey={lastSwipedMessage?.messageId === msg.id ? lastSwipedMessage.key : null}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
