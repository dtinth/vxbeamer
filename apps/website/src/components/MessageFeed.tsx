import { useEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import {
  $activeRecordingReferenceId,
  $backendUrl,
  $lastSwipedMessage,
  $messages,
  $sessionToken,
  $transcriptListMode,
  markPendingLocalSwipe,
  TRANSCRIPT_LIST_LIMIT,
  type Message,
} from "../store.ts";
import { $retainedRecordings } from "../recordedAudio.ts";
import { forgetRecordingConnection, retryRecordingConnection } from "../recordingConnection.ts";
import { EvalDialog } from "./EvalDialog.tsx";
import {
  canEvalMessage,
  getMessageCardInitialScrollLeft,
  getMessageCardSnapAction,
  getMessageFeedScrollBehavior,
  MESSAGE_CARD_ACTION_WIDTH,
  MESSAGE_CARD_SNAP_TOLERANCE,
  MESSAGE_FEED_PRUNE_FALLBACK_MS,
  selectVisibleMessages,
} from "./messageFeedScroll.ts";

const SWIPE_GLOW_DURATION_MS = 900;
const COPY_BOUNCE_DURATION_MS = 300;
const DRAG_CLICK_SUPPRESSION_MS = 250;
const DRAG_FREEZE_DELAY_MS = 50;
/** How long the charge tint takes to fill — sized to the OS long-press lift the
 *  drag rides (measured ~590–654ms across iPad/Android), rounded up so the fill
 *  is still travelling when the lift lands rather than sitting full and idle. */
const DRAG_CHARGE_MS = 700;
/** Finger travel that means "I'm swiping/scrolling", not holding to lift — abort
 *  the charge. The card is a horizontal swipe surface, so movement is common. */
const DRAG_CHARGE_ABORT_PX = 12;

function MessageCard({
  message,
  authToken,
  backendUrl,
  isActiveRecording,
  swipeHighlightKey,
  canEval,
  onEval,
}: {
  message: Message;
  authToken: string;
  backendUrl: string;
  isActiveRecording: boolean;
  swipeHighlightKey: number | null;
  /** This message's PCM is still in memory, so there is something to replay. */
  canEval: boolean;
  onEval: () => void;
}) {
  // Only ever true alongside a referenceId — see `setLocalConnectionError`.
  const canRetryConnection = !!message.connectionError;
  const [copied, setCopied] = useState(false);
  const [copyBouncing, setCopyBouncing] = useState(false);
  const copyBounceResetRef = useRef<number | null>(null);
  const copyBounceFrameRef = useRef<number | null>(null);
  const [swipeGlowing, setSwipeGlowing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ignoreScrollEndRef = useRef(false);
  const suppressClickRef = useRef(false);
  const suppressClickTimeoutRef = useRef<number | null>(null);
  const dragFreezeTimeoutRef = useRef<number | null>(null);
  const swipeableRef = useRef(message.status !== "recording");
  const sweepRef = useRef<HTMLDivElement>(null);
  const chargingRef = useRef(false);
  const chargeStartRef = useRef<{ x: number; y: number } | null>(null);
  const sweepResetTimeoutRef = useRef<number | null>(null);
  const dragImageRef = useRef<HTMLElement | null>(null);

  const text =
    message.final ??
    message.partial ??
    (message.status === "recording" ? "…" : (message.error ?? ""));

  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  // A connect-error placeholder has an error string, not a transcript — swipe
  // (to delete the placeholder) still works, but there's nothing to copy.
  const copyable = message.status !== "recording" && !message.connectionError && !!text;
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
    // A local placeholder has no server-side counterpart to beam.
    if (message.connectionError) return;
    markPendingLocalSwipe(message.id);
    void fetch(new URL(`/messages/${message.id}/swipe`, backendUrl).toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    resetScrollPosition("smooth");
  };

  const triggerDelete = () => {
    if (canRetryConnection) {
      // A local placeholder bubble — nothing server-side to delete. Drop the
      // buffered audio and connection state along with it.
      forgetRecordingConnection(message.referenceId!);
      return;
    }
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

  // Restart the bounce even on rapid repeat taps: drop the class, then re-add
  // it a frame later so the browser sees a fresh animation rather than a no-op
  // re-application of a class it already had.
  const triggerCopyBounce = () => {
    setCopyBouncing(false);
    if (copyBounceFrameRef.current !== null)
      window.cancelAnimationFrame(copyBounceFrameRef.current);
    copyBounceFrameRef.current = window.requestAnimationFrame(() => {
      setCopyBouncing(true);
      copyBounceFrameRef.current = null;
    });
    if (copyBounceResetRef.current !== null) window.clearTimeout(copyBounceResetRef.current);
    copyBounceResetRef.current = window.setTimeout(() => {
      setCopyBouncing(false);
      copyBounceResetRef.current = null;
    }, COPY_BOUNCE_DURATION_MS);
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
      triggerCopyBounce();
    });
  };

  // --- Drag-charge feedback (touch only) ---------------------------------
  //
  // Dragging a message out to another app rides the OS long-press lift, which
  // takes ~0.7s and is not web-adjustable. The tint sweeps left→right over that
  // window so the wait is legible; dragstart rushes it home, a swipe/scroll/tap
  // slides it back. Driven imperatively (like the swipe gestures here) to keep
  // per-frame touch work off React's render path.
  const clearSweepReset = () => {
    if (sweepResetTimeoutRef.current !== null) {
      window.clearTimeout(sweepResetTimeoutRef.current);
      sweepResetTimeoutRef.current = null;
    }
  };

  const restSweep = () => {
    const el = sweepRef.current;
    if (!el) return;
    el.style.transition = "none";
    el.style.transform = "scaleX(0)";
    el.style.opacity = "0";
  };

  const startCharge = (x: number, y: number) => {
    const el = sweepRef.current;
    if (!el || !copyable) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    clearSweepReset();
    chargingRef.current = true;
    chargeStartRef.current = { x, y };
    // Snap to empty-but-visible, commit it, then fill over the hold window.
    el.style.transition = "none";
    el.style.transform = "scaleX(0)";
    el.style.opacity = "1";
    void el.offsetWidth;
    el.style.transition = `transform ${DRAG_CHARGE_MS}ms linear, opacity 120ms ease-out`;
    el.style.transform = "scaleX(1)";
  };

  // Called from dragstart. A no-op unless a touch charge is live, which is what
  // keeps this touch-only: a mouse drag never armed one.
  const completeCharge = () => {
    const el = sweepRef.current;
    if (!el || !chargingRef.current) return;
    chargingRef.current = false;
    chargeStartRef.current = null;
    clearSweepReset();
    el.style.transition = "transform 130ms ease-out, opacity 240ms ease-out";
    el.style.transform = "scaleX(1)";
    el.style.opacity = "0";
    sweepResetTimeoutRef.current = window.setTimeout(restSweep, 260);
  };

  // Swipe, scroll, or tap-release before the lift: reverse to the left and fade
  // at once, so it does not linger as a half-full bar.
  const abortCharge = () => {
    const el = sweepRef.current;
    if (!el || !chargingRef.current) return;
    chargingRef.current = false;
    chargeStartRef.current = null;
    clearSweepReset();
    el.style.transition = "transform 200ms ease-in, opacity 200ms ease-in";
    el.style.transform = "scaleX(0)";
    el.style.opacity = "0";
    sweepResetTimeoutRef.current = window.setTimeout(restSweep, 220);
  };

  const handleChargeTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (touch) startCharge(touch.clientX, touch.clientY);
  };

  const handleChargeTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = chargeStartRef.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > DRAG_CHARGE_ABORT_PX) {
      abortCharge();
    }
  };

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
    if (!copyable) {
      event.preventDefault();
      return;
    }
    completeCharge();
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
    applyCustomDragImage(event.currentTarget, event);
  };

  // The browser's default drag image is a screenshot of the bubble, which drags
  // its rounded corners as opaque rectangle corners and — on touch — freezes the
  // charge sweep mid-fill. Replace it with a squared-off clone of the bubble.
  // An off-screen clone is what survives here: verified on iPadOS Safari and
  // Android Chrome, where staging it on-screen-but-hidden instead snapshots as
  // an empty black rectangle.
  const applyCustomDragImage = (bubble: HTMLElement, event: React.DragEvent<HTMLDivElement>) => {
    const rect = bubble.getBoundingClientRect();
    const clone = bubble.cloneNode(true) as HTMLElement;
    // Bake the sweep into the clone at a flat, full fill — drop the live
    // element's imperative transform/opacity so the `--baked` class takes over.
    const clonedSweep = clone.querySelector<HTMLElement>(".charge-sweep");
    if (clonedSweep) {
      clonedSweep.removeAttribute("style");
      clonedSweep.classList.add("charge-sweep--baked");
    }
    // Pin the width: the bubble is width:100% of the scroll viewport, and a clone
    // appended to <body> would otherwise re-resolve that to the full page width.
    clone.style.width = `${rect.width}px`;
    clone.style.margin = "0";
    clone.style.borderRadius = "0";
    clone.style.position = "absolute";
    clone.style.top = "-9999px";
    clone.style.left = "0";
    clone.style.pointerEvents = "none";
    document.body.appendChild(clone);
    dragImageRef.current = clone;
    // Keep the grab point under the finger: prefer the held touch point, fall
    // back to the drag event's own coordinates for a mouse.
    const point = chargeStartRef.current ?? { x: event.clientX, y: event.clientY };
    const offsetX = Math.max(0, Math.min(rect.width, point.x - rect.left));
    const offsetY = Math.max(0, Math.min(rect.height, point.y - rect.top));
    event.dataTransfer.setDragImage(clone, offsetX, offsetY);
  };

  const removeDragImage = () => {
    dragImageRef.current?.remove();
    dragImageRef.current = null;
  };

  const handleDragEnd = () => {
    scheduleClickSuppression();
    if (dragFreezeTimeoutRef.current !== null) {
      window.clearTimeout(dragFreezeTimeoutRef.current);
      dragFreezeTimeoutRef.current = null;
    }
    document.body.removeAttribute("data-dragging-message");
    removeDragImage();
  };

  useEffect(() => {
    return () => {
      if (sweepResetTimeoutRef.current !== null) {
        window.clearTimeout(sweepResetTimeoutRef.current);
      }
      if (copyBounceResetRef.current !== null) {
        window.clearTimeout(copyBounceResetRef.current);
      }
      if (copyBounceFrameRef.current !== null) {
        window.cancelAnimationFrame(copyBounceFrameRef.current);
      }
      // If the component unmounts mid-drag, dragend never fires to clean up.
      dragImageRef.current?.remove();
    };
  }, []);

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
          onTouchStart={handleChargeTouchStart}
          onTouchMove={handleChargeTouchMove}
          onTouchEnd={abortCharge}
          onTouchCancel={abortCharge}
          className={[
            "relative snap-center flex-none bg-(--m3-surface-container-high) px-4 py-3",
            copyable ? "cursor-pointer active:bg-(--m3-surface-container-highest)" : "",
            copyBouncing ? "message-bubble-copy-bounce" : "",
          ].join(" ")}
          style={{ width: "100%" }}
        >
          {copyable && <div ref={sweepRef} aria-hidden="true" className="charge-sweep" />}
          <div className="relative z-10 mb-1 flex items-center gap-2">
            <span className="text-xs text-(--m3-on-surface-variant)">{time}</span>
            {message.status === "recording" && (
              <span className="flex items-center gap-1 text-xs text-(--m3-error)">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
                Recording
              </span>
            )}
            {message.status === "error" && <span className="text-xs text-(--m3-error)">Error</span>}
            <span className="ml-auto flex items-center gap-3">
              {copied && <span className="text-xs text-green-400">Copied</span>}
              {/* Only the recording's own connect ever failed — the buffered
                  audio is still sitting in recordingConnection.ts waiting for
                  another attempt. */}
              {canRetryConnection && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    retryRecordingConnection(message.referenceId!);
                  }}
                  className="-my-1 rounded-full p-1 text-(--m3-error) transition-colors hover:bg-(--m3-surface-container-highest)"
                  aria-label="Retry connecting this recording"
                  title="Retry"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 12a9 9 0 1 0 3-6.7" />
                    <path d="M3 4v5h5" />
                  </svg>
                </button>
              )}
              {/* Eval is opt-in per message (privacy), and only offered where it
                  is possible at all: the audio outlives its message only in this
                  tab's memory, and the size cap may already have let it go. */}
              {canEval && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEval();
                  }}
                  className="-my-1 rounded-full p-1 text-(--m3-on-surface-variant) transition-colors hover:bg-(--m3-surface-container-highest) hover:text-(--m3-on-surface)"
                  aria-label="Eval this recording against other configurations"
                  title="Eval"
                >
                  {/* Scales: this weighs configurations against each other and
                      picks a winner. Judging, not experimenting. */}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
                    <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
                    <path d="M7 21h10" />
                    <path d="M12 3v18" />
                    <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
                  </svg>
                </button>
              )}
            </span>
          </div>
          <p
            className={`relative z-10 text-sm whitespace-pre-wrap leading-relaxed ${message.final ? "text-(--m3-on-surface)" : "text-(--m3-on-surface-variant)"}`}
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
  const retainedRecordings = useStore($retainedRecordings);
  const authToken = useStore($sessionToken);
  const backendUrl = useStore($backendUrl);
  const transcriptListMode = useStore($transcriptListMode);
  const [evalMessageId, setEvalMessageId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasScrolledInitiallyRef = useRef(false);
  // Ids committed to the DOM on the previous render, and a mirror of the ids
  // we are currently keeping mounted past the trim — both read from effects.
  const prevDisplayedRef = useRef<string[]>([]);
  const retainedIdsRef = useRef<string[]>([]);

  const sorted = Array.from(messagesMap.values()).sort((a, b) => a.createdAt - b.createdAt);
  const limit = transcriptListMode === "latest" ? TRANSCRIPT_LIST_LIMIT : null;
  const target = selectVisibleMessages(sorted, limit);

  // When the message set or the trim mode changes, hold onto whatever was on
  // screen a moment ago so trimmed bubbles do not pop out before we have
  // scrolled. Updating state during render keeps this flicker-free — React
  // re-renders with the retained ids before the browser paints.
  const [snapshot, setSnapshot] = useState<{
    map: Map<string, Message>;
    mode: string;
    retainedIds: string[];
  }>(() => ({ map: messagesMap, mode: transcriptListMode, retainedIds: [] }));
  if (snapshot.map !== messagesMap || snapshot.mode !== transcriptListMode) {
    setSnapshot({
      map: messagesMap,
      mode: transcriptListMode,
      retainedIds:
        limit === null ? [] : prevDisplayedRef.current.filter((id) => messagesMap.has(id)),
    });
  }

  const keptIds = new Set(target.map((m) => m.id));
  for (const id of snapshot.retainedIds) keptIds.add(id);
  const messages = limit === null ? sorted : sorted.filter((m) => keptIds.has(m.id));
  retainedIdsRef.current = messages.length > target.length ? snapshot.retainedIds : [];

  const evalMessage = evalMessageId ? messagesMap.get(evalMessageId) : undefined;

  const canEval = (message: Message): boolean =>
    canEvalMessage(
      message,
      !!message.referenceId && !!retainedRecordings.get(message.referenceId)?.chunks.length,
    );

  useEffect(() => {
    prevDisplayedRef.current = messages.map((m) => m.id);
  });

  useEffect(() => {
    if (sorted.length === 0) return;
    const behavior = getMessageFeedScrollBehavior(hasScrolledInitiallyRef.current);
    bottomRef.current?.scrollIntoView({ behavior });
    hasScrolledInitiallyRef.current = true;

    // Nothing is being held past the trim, so there is nothing to prune.
    if (retainedIdsRef.current.length === 0) return;

    // Drop the retained bubbles only once the scroll has come to rest, so they
    // leave the DOM without yanking the viewport mid-animation. `scrollend`
    // covers the smooth scroll; the timeout covers the case where the feed was
    // already at the bottom and no scroll (hence no `scrollend`) ever happens.
    const container = scrollContainerRef.current;
    let settled = false;
    const prune = () => {
      if (settled) return;
      settled = true;
      container?.removeEventListener("scrollend", prune);
      window.clearTimeout(fallback);
      setSnapshot((s) => (s.retainedIds.length === 0 ? s : { ...s, retainedIds: [] }));
    };
    const fallback = window.setTimeout(prune, MESSAGE_FEED_PRUNE_FALLBACK_MS);
    container?.addEventListener("scrollend", prune);
    return () => {
      settled = true;
      container?.removeEventListener("scrollend", prune);
      window.clearTimeout(fallback);
    };
  }, [messagesMap, transcriptListMode]);

  if (sorted.length === 0) {
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
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto py-1">
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
          canEval={canEval(msg)}
          onEval={() => setEvalMessageId(msg.id)}
        />
      ))}
      <div ref={bottomRef} />
      {evalMessage && <EvalDialog message={evalMessage} onClose={() => setEvalMessageId(null)} />}
    </div>
  );
}
