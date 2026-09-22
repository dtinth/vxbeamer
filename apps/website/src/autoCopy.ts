import { $activeRecordingReferenceId, $autoCopy, $visibleMessages } from "./store.ts";
import { isMessageCopyable } from "./components/messageFeedScroll.ts";

/**
 * Copying a transcript to the clipboard once it finishes, for recordings
 * made on this client.
 *
 * Push-to-talk has always done this on release; the auto-copy setting
 * extends the same behaviour to every way of stopping — the record button,
 * the `r` shortcut, or releasing Space. Both go through {@link
 * copyWhenFinalized} rather than each growing a copy of the waiting logic
 * (dtinth/vxbeamer#86).
 *
 * **Only this client's own recordings.** The feed is shared across every
 * signed-in device, so a transcript can finish at any moment that nobody
 * here asked for. Watching is therefore keyed to a `referenceId` this
 * client minted when *it* started recording, never to "whatever finished
 * most recently".
 */

/** Reference ids currently being waited on, so two callers cannot both copy the same one. */
const watching = new Map<string, () => void>();

/**
 * Clicks the message's own bubble, which is what actually writes to the
 * clipboard — reusing the feed's click-to-copy rather than a second
 * clipboard path that could drift from it.
 *
 * Deferred a tick because this runs from a store notification, which fires
 * before React has rendered the bubble that notification will produce.
 */
function copyMessageAfterRender(messageId: string): void {
  setTimeout(() => {
    document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.click();
  }, 0);
}

/**
 * Waits for the recording behind [referenceId] to produce something
 * copyable, then copies it. Idempotent: a second call for the same
 * recording joins the first rather than arranging a second copy.
 */
export function copyWhenFinalized(referenceId: string): void {
  if (watching.has(referenceId)) return;

  const stop = () => {
    watching.get(referenceId)?.();
    watching.delete(referenceId);
  };

  const unsubscribe = $visibleMessages.subscribe((messages) => {
    const target = Array.from(messages.values()).find((m) => m.referenceId === referenceId);
    if (!target || !isMessageCopyable(target)) return;
    stop();
    copyMessageAfterRender(target.id);
  });

  watching.set(referenceId, unsubscribe);
}

/**
 * Abandons every copy still being waited on.
 *
 * For teardown: a watch outliving the page that started it would click a
 * bubble nobody is looking at any more.
 */
export function cancelPendingCopies(): void {
  for (const unsubscribe of watching.values()) unsubscribe();
  watching.clear();
}

/**
 * Watches for this client's recordings ending, and copies them when the
 * setting is on.
 *
 * The trigger is `$activeRecordingReferenceId` falling back to null, which
 * is the one signal every stop path shares — so the button, `r` and Space
 * all behave identically without each having to remember to ask.
 *
 * The setting is read at the moment a recording *stops*, not when its
 * transcript arrives: turning auto-copy off should not cancel a copy for a
 * recording that was already finished with, and turning it on should not
 * capture one that was already in flight.
 */
export function attachAutoCopy(): () => void {
  let previous = $activeRecordingReferenceId.get();

  const unsubscribe = $activeRecordingReferenceId.subscribe((current) => {
    const justStopped = previous !== null && current === null ? previous : null;
    previous = current;
    if (justStopped === null) return;
    if (!$autoCopy.get()) return;
    copyWhenFinalized(justStopped);
  });

  return () => {
    unsubscribe();
    cancelPendingCopies();
  };
}
