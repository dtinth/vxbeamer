import { $activeRecordingReferenceId, $visibleMessages } from "./store.ts";
import { copyWhenFinalized } from "./autoCopy.ts";
import { selectLatestCopyableMessageId } from "./components/messageFeedScroll.ts";

/**
 * How long a guarded record-button click is given to actually change
 * `$activeRecordingReferenceId` before giving up on it. Covers two failure
 * shapes: a denied/failed mic permission (a start click that never takes
 * effect), and a click landing while the store is momentarily out of sync
 * with a just-issued click's own effect. Without this, either would leave
 * every future `r`/Space press silently ignored forever.
 */
const RECORD_TOGGLE_SETTLE_TIMEOUT_MS = 5000;

export interface ShortcutKeyEvent {
  repeat: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
}

// `EventTarget` itself carries no `tagName`/`isContentEditable` — every real
// element does, so this is a safe duck-typed read, not an unsound cast.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * A shortcut only ever fires on the initial press (not on key-repeat while
 * held), with no modifier held (so it never shadows a browser/OS shortcut
 * sharing the same letter, e.g. Cmd+C), and never while the user is typing
 * somewhere else on the page.
 */
export function isShortcutEligible(event: ShortcutKeyEvent): boolean {
  if (event.repeat) return false;
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  return !isEditableTarget(event.target);
}

function isSpaceKey(event: KeyboardEvent): boolean {
  return event.key === " " || event.code === "Space";
}

function clickElement(selector: string): void {
  document.querySelector<HTMLElement>(selector)?.click();
}

function clickMessageBubble(messageId: string): void {
  clickElement(`[data-message-id="${messageId}"]`);
}

/**
 * Wires up `c` (copy the latest finished transcript), `r` (toggle
 * recording), and hold-Space (push-to-talk — start on press, stop and
 * auto-copy on release), by simulating clicks on the same button and
 * bubbles a person would tap. That gets the shortcuts exactly the behaviour
 * a real click gets (the copy bounce, the "Copied" flash, connect retries)
 * with no second copy of that logic to keep in sync (dtinth/vxbeamer#86).
 */
export function attachKeyboardShortcuts(): () => void {
  type PushToTalkState =
    | { phase: "idle" }
    | { phase: "starting"; stopRequested: boolean }
    | { phase: "active"; referenceId: string };

  let state: PushToTalkState = { phase: "idle" };
  let cancelPendingToggle: (() => void) | null = null;

  /**
   * Clicks the record button, then waits for `$activeRecordingReferenceId`
   * — a plain nanostore atom, updated the instant a recording truly starts
   * or stops, independent of React's own render timing — to actually
   * change before allowing another guarded click. `r` and Space share this
   * one guard, so neither can start a second recording while the other's
   * click is still taking effect: a fast enough repeat press otherwise
   * lands before the first click's effect is visible anywhere else, and
   * would toggle the button a second time instead of being a no-op.
   */
  const clickRecordButtonGuarded = (onSettled: (newValue: string | null) => void) => {
    if (cancelPendingToggle) return;
    const before = $activeRecordingReferenceId.get();
    const finish = (value: string | null) => {
      cancelPendingToggle = null;
      clearTimeout(timeout);
      unwatch();
      onSettled(value);
    };
    const unwatch = $activeRecordingReferenceId.subscribe((value) => {
      if (value === before) return;
      finish(value);
    });
    const timeout = setTimeout(() => finish(before), RECORD_TOGGLE_SETTLE_TIMEOUT_MS);
    cancelPendingToggle = () => {
      clearTimeout(timeout);
      unwatch();
      cancelPendingToggle = null;
    };
    clickElement('[data-shortcut="record-toggle"]');
  };

  const beginPushToTalk = () => {
    if (state.phase !== "idle" || $activeRecordingReferenceId.get() !== null) return;
    state = { phase: "starting", stopRequested: false };
    clickRecordButtonGuarded((newValue) => {
      if (state.phase !== "starting") return;
      const stopRequested = state.stopRequested;
      if (newValue === null) {
        // The start never actually took effect (denied/failed mic
        // permission) — give up so a later press can try again.
        state = { phase: "idle" };
        return;
      }
      state = { phase: "active", referenceId: newValue };
      if (stopRequested) endPushToTalk();
    });
  };

  const endPushToTalk = () => {
    if (state.phase === "idle") return;
    if (state.phase === "starting") {
      state = { ...state, stopRequested: true };
      return;
    }
    const { referenceId } = state;
    state = { phase: "idle" };
    // The recording may already have been stopped some other way (`r`, a
    // manual click) while Space was still held — only click stop if this
    // push-to-talk session is still the one actually recording, so
    // releasing Space late never starts a fresh recording by mistake.
    if ($activeRecordingReferenceId.get() === referenceId) {
      clickRecordButtonGuarded(() => undefined);
    }
    // Push-to-talk copies on release whatever the auto-copy setting says —
    // that is the gesture's whole point. `copyWhenFinalized` is idempotent,
    // so when the setting is also on, the two do not race to copy twice.
    copyWhenFinalized(referenceId);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const isSpace = isSpaceKey(event);
    if (
      isSpace &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !isEditableTarget(event.target)
    ) {
      // Suppress the page's own space-scrolls-the-page action for as long as
      // this shortcut owns Space — on every repeat too, not just the first
      // press, or the browser resumes scrolling once the key auto-repeats.
      event.preventDefault();
    }
    if (!isShortcutEligible(event)) return;

    if (event.key === "c") {
      const id = selectLatestCopyableMessageId($visibleMessages.get().values());
      if (id) clickMessageBubble(id);
    } else if (event.key === "r") {
      clickRecordButtonGuarded(() => undefined);
    } else if (isSpace) {
      beginPushToTalk();
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (isSpaceKey(event)) endPushToTalk();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    cancelPendingToggle?.();
  };
}
