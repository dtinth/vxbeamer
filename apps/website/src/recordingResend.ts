import { createPacedFrameEmitter, toPacedFrames } from "./pacedReplay.ts";
import { getRetainedRecording } from "./recordedAudio.ts";
import {
  beginRecordingConnection,
  endRecordingConnection,
  hasRecordingConnection,
  retryRecordingConnection,
  sendRecordingAudio,
} from "./recordingConnection.ts";
import { $backendUrl, obtainSessionToken, setLocalConnectionError } from "./store.ts";

/**
 * Send a recording's saved audio to the backend again, for a recording whose
 * transcript never made it there: recorded offline, or the page was reloaded
 * before its connection opened.
 *
 * It goes through the same `/ws` path as a live recording, with the same
 * `reference_id`, so the transcript that comes back joins the memo it belongs
 * to. The audio is paced like a live capture: the ASR vendors this feeds do
 * not all cope with a clip dumped at once (`pacedReplay.ts`), so a recording of
 * five minutes takes about five minutes to come back.
 */

/** 100 ms of 16 kHz 16-bit mono PCM, the pace a live capture produces. */
const FRAME_BYTES = 3200;
const FRAME_MS = 100;

export async function resendRecording(referenceId: string): Promise<void> {
  const recording = getRetainedRecording(referenceId);
  if (!recording || recording.chunks.length === 0) return;

  // Feedback at once; the error bubble stands in until the transcript arrives.
  setLocalConnectionError(referenceId, "Sending…");
  let authToken: string;
  try {
    authToken = await obtainSessionToken();
  } catch (err) {
    setLocalConnectionError(
      referenceId,
      err instanceof Error ? err.message : "Could not refresh session",
    );
    return;
  }

  beginRecordingConnection(referenceId, authToken, $backendUrl.get());
  const emitter = createPacedFrameEmitter(
    toPacedFrames(recording.chunks, FRAME_BYTES),
    FRAME_MS,
    (frame) => sendRecordingAudio(referenceId, frame),
    () => endRecordingConnection(referenceId),
  );
  emitter.start();
}

/**
 * The retry button on a memo: re-open the connection this page still holds for
 * it, or, when there is none (the page was reloaded since), send the saved
 * audio again.
 */
export function retryMemo(referenceId: string): void {
  if (hasRecordingConnection(referenceId)) {
    retryRecordingConnection(referenceId);
  } else {
    void resendRecording(referenceId);
  }
}
