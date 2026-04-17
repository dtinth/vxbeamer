import { useEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import {
  $activeRecordingReferenceId,
  $backendUrl,
  $lastSwipedMessage,
  $messages,
  $sessionToken,
  markPendingLocalSwipe,
  type Message,
} from "../store.ts";
import {
  getMessageCardInitialScrollLeft,
  getMessageCardSnapAction,
  getMessageFeedScrollBehavior,
  MESSAGE_CARD_ACTION_WIDTH,
  MESSAGE_CARD_SNAP_TOLERANCE,
} from "./messageFeedScroll.ts";

const SWIPE_GLOW_DURATION_MS = 900;
const DRAG_CLICK_SUPPRESSION_MS = 250;
const DRAG_FREEZE_DELAY_MS = 50;

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
  const [swipeGlowing, setSwipeGlowing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ignoreScrollEndRef = useRef(false);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<number | null>(null);
  const dragFreezeTimeoutRef = useRef<number | null>(null);
  const swipeableRef = useRef(message.status !== "recording");

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

  const scheduleClickSuppression = () => {
    suppressClickRef.current = true;
    if (suppressClickTimeoutRef.current !== null) {
      window.clearTimeout(suppressClickTimeoutRef.current);
    }
    suppressClickTimeoutRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      suppressClickTimeoutRef.current = null;
    }, DRAG_CLICK_SUPPRESSION_MS);
  };

  const resetScrollPosition = (behavior: ScrollBehavior = "auto") => {
    const node = scrollRef.current;
    if (!node) return;
    ignoreScrollEndRef.current = true;
    node.scrollTo({
      left: getMessageCardInitialScrollLeft(),
      behavior,
    });
  };

  const triggerBeam = () => {
    markPendingLocalSwipe(message.id);
    void fetch(new URL(`/messages/${message.id}/swipe`, backendUrl).toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    resetScrollPosition("smooth");
  };

  const triggerDelete = () => {
    void fetch(new URL(`/messages/${message.id}`, backendUrl).toString(), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    resetScrollPosition("smooth");
  };

  const handleSwipeAction = (
    action: Exclude<ReturnType<typeof getMessageCardSnapAction>, null>,
  ) => {
    if (action === "swipe-left") {
      setShowDeleteConfirm(true);
    } else {
      triggerBeam();
    }
  };

  const handleSwipeRelease = () => {
    if (!swipeableRef.current) return;
    const node = scrollRef.current;
    if (!node) return;

    const scrollLeft = node.scrollLeft;

    if (scrollLeft <= MESSAGE_CARD_SNAP_TOLERANCE) {
      triggerBeam();
      ignoreScrollEndRef.current = true;
      return;
    }

    if (scrollLeft >= MESSAGE_CARD_ACTION_WIDTH * 2 - MESSAGE_CARD_SNAP_TOLERANCE) {
      setShowDeleteConfirm(true);
      ignoreScrollEndRef.current = true;
      return;
    }

    setShowDeleteConfirm(false);
  };

  const handleScrollEnd = () => {
    if (!swipeableRef.current || ignoreScrollEndRef.current) {
      ignoreScrollEndRef.current = false;
      return;
    }
    const node = scrollRef.current;
    if (!node) return;
    const action = getMessageCardSnapAction(node.scrollLeft);
    if (action) {
      handleSwipeAction(action);
    }
  };

  const handleClick = () => {
    if (suppressClickRef.current) return;
    if (!copyable) return;
    if (showDeleteConfirm) {
      triggerDelete();
      setShowDeleteConfirm(false);
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    if (!copyable) {
      event.preventDefault();
      return;
    }
    scheduleClickSuppression();
    if (dragFreezeTimeoutRef.current !== null) {
      window.clearTimeout(dragFreezeTimeoutRef.current);
    }
    dragFreezeTimeoutRef.current = window.setTimeout(() => {
      document.body.setAttribute("data-dragging-message", "true");
      dragFreezeTimeoutRef.current = null;
    }, DRAG_FREEZE_DELAY_MS);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("text/plain", text);
  };

  const handleDragEnd = () => {
    scheduleClickSuppression();
    if (dragFreezeTimeoutRef.current !== null) {
      window.clearTimeout(dragFreezeTimeoutRef.current);
      dragFreezeTimeoutRef.current = null;
    }
    document.body.removeAttribute("data-dragging-message");
  };

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

  useEffect(() => {
    swipeableRef.current = swipeable;
  }, [swipeable]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    resetScrollPosition();
    node.addEventListener("scrollend", handleScrollEnd);
    node.addEventListener("pointerup", handleSwipeRelease);

    return () => {
      node.removeEventListener("scrollend", handleScrollEnd);
      node.removeEventListener("pointerup", handleSwipeRelease);
      if (suppressClickTimeoutRef.current !== null) {
        window.clearTimeout(suppressClickTimeoutRef.current);
      }
      if (dragFreezeTimeoutRef.current !== null) {
        window.clearTimeout(dragFreezeTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      className={[
        "message-card relative mx-3 my-2 overflow-hidden rounded-2xl transition-shadow duration-200",
        swipeGlowing ? "message-card-swipe-glow" : "",
      ].join(" ")}
    >
      {isActiveRecording && (
        <div
          className="pointer-events-none absolute inset-0 rounded-2xl"
          style={{ boxShadow: "inset 0 0 0 2px rgb(239 68 68 / 1)" }}
        />
      )}
      <div
        ref={scrollRef}
        className={[
          "message-card-snap-scroll flex overflow-y-hidden overscroll-x-contain select-none",
          swipeable ? "overflow-x-auto snap-x snap-mandatory" : "overflow-x-hidden",
        ].join(" ")}
      >
        <div
          className="flex-none snap-start bg-(--m3-tertiary-container) text-(--m3-on-tertiary-container)"
          style={{ width: `${MESSAGE_CARD_ACTION_WIDTH}px` }}
        >
          <div className="flex h-full items-center justify-center px-5">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </div>
        </div>
        <div
          draggable={copyable}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onClick={handleClick}
          className={[
            "snap-center flex-none bg-(--m3-surface-container-high) px-4 py-3",
            copyable ? "cursor-pointer active:bg-(--m3-surface-container-highest)" : "",
          ].join(" ")}
          style={{ width: "100%" }}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="text-xs text-(--m3-on-surface-variant)">{time}</span>
            {message.status === "recording" && (
              <span className="flex items-center gap-1 text-xs text-(--m3-error)">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
                Recording
              </span>
            )}
            {message.status === "error" && <span className="text-xs text-(--m3-error)">Error</span>}
            {copied && <span className="ml-auto text-xs text-green-400">Copied</span>}
          </div>
          <p
            className={`text-sm whitespace-pre-wrap leading-relaxed ${message.final ? "text-(--m3-on-surface)" : "text-(--m3-on-surface-variant)"}`}
          >
            {text}
          </p>
        </div>
        <div
          className={[
            "flex-none snap-end text-(--m3-on-error-container)",
            showDeleteConfirm ? "cursor-pointer bg-(--m3-error)" : "bg-(--m3-error-container)",
          ].join(" ")}
          style={{ width: `${MESSAGE_CARD_ACTION_WIDTH}px` }}
          onClick={() => {
            if (showDeleteConfirm) {
              triggerDelete();
              setShowDeleteConfirm(false);
            }
          }}
        >
          <div className="flex h-full items-center justify-center px-5">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v6M14 11v6" />
              <path d="M9 6V4h6v2" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface MessageFeedProps {
  onOpenSettings?: () => void;
}

export function MessageFeed({ onOpenSettings }: MessageFeedProps = {}) {
  const activeRecordingReferenceId = useStore($activeRecordingReferenceId);
  const lastSwipedMessage = useStore($lastSwipedMessage);
  const messagesMap = useStore($messages);
  const authToken = useStore($sessionToken);
  const backendUrl = useStore($backendUrl);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasScrolledInitiallyRef = useRef(false);

  const messages = Array.from(messagesMap.values()).sort((a, b) => a.createdAt - b.createdAt);

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
        <div className="flex flex-col items-center gap-3 px-6 text-center">
          <p className="text-(--m3-on-surface-variant) text-sm">
            {authToken
              ? "No messages yet. Start speaking."
              : "No messages yet. Sign in first to start speaking."}
          </p>
          {!authToken && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-full bg-(--m3-secondary-container) px-4 py-2 text-sm font-medium text-(--m3-on-secondary-container) transition-colors hover:brightness-105"
            >
              Open Settings
            </button>
          )}
        </div>
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
