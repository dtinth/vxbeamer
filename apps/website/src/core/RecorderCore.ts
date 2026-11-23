import { atom, type ReadableAtom } from "nanostores";

/**
 * The recording state of the web client, with nothing in it that touches the
 * browser. Everything outside the core (the microphone, the backend, the
 * in-memory audio store, the screen wake lock) is handed in as {@link RecorderPorts},
 * so the whole recording lifecycle can be driven and asserted in a plain unit
 * test, and a view only has to subscribe to the stores below.
 *
 * ## The switch
 *
 * The record button is a physical switch: `active` is the *desired* state and
 * flips the instant {@link RecorderCore.setActive} is called, with no lag. What
 * the system is really doing (`status`) catches up to it: the microphone may
 * take a while to open, but a tap never waits for that, and a tap that arrives
 * while it is still opening is just a change of mind about the switch. After
 * every change, {@link RecorderCore} reconciles the actual state toward the
 * desired one, so there is no pair of "start" and "stop" commands that can
 * cross each other.
 *
 * ## Transcription is independent of capture
 *
 * Audio goes to the retained recording and to the transcription as it is
 * captured. Nothing in here waits for the network: a slow or failing `/ws` can
 * never delay the microphone starting or the recording running.
 */

export interface RecorderAudioSource {
  /** Start capturing; `onChunk` is called with PCM as it arrives. */
  start(onChunk: (chunk: ArrayBuffer) => void): Promise<void>;
  /** Stop capturing and release the device. Only called once `start` has settled. */
  stop(): void;
  /** Frequency data for a visualizer, or null when there is none yet. */
  getFrequencyData(): Uint8Array<ArrayBuffer> | null;
}

export interface RecorderRetainer {
  append(chunk: ArrayBuffer): void;
  /** The recording is complete and worth keeping. */
  commit(): void;
  /** Nothing worth keeping. */
  discard(): void;
}

export interface RecorderPorts {
  createAudioSource(): RecorderAudioSource;
  newReferenceId(): string;
  retain(referenceId: string): RecorderRetainer;
  /** Open the transcription for a recording. Never awaited: audio sent before it is ready is the port's to hold. */
  beginTranscription(referenceId: string): void;
  sendAudio(referenceId: string, chunk: ArrayBuffer): void;
  /** The recording is over; finish the transcription. */
  endTranscription(referenceId: string): void;
  /** Keep the screen awake while recording. Resolves to the function that lets go. Optional. */
  acquireWakeLock?(): Promise<() => void>;
}

export type RecorderStatus = "idle" | "starting" | "recording";

interface Session {
  referenceId: string;
  source: RecorderAudioSource;
  retainer: RecorderRetainer;
  /** Whether the microphone has finished starting. */
  live: boolean;
  transcribing: boolean;
  capturedBytes: number;
  releaseWakeLock: (() => void) | null;
}

export class RecorderCore {
  private readonly ports: RecorderPorts;
  private session: Session | null = null;

  private readonly wanted = atom(false);
  private readonly sessionStatus = atom<RecorderStatus>("idle");
  private readonly activeId = atom<string | null>(null);
  private readonly lastError = atom<string | null>(null);

  /** The switch: whether a recording is wanted. Changes the moment it is toggled. */
  readonly active: ReadableAtom<boolean> = this.wanted;
  /** What the system is actually doing, which can trail {@link active} while the microphone opens. */
  readonly status: ReadableAtom<RecorderStatus> = this.sessionStatus;
  /** Reference id of the recording that is live, or null. Set once capture is running, cleared when it stops. */
  readonly activeReferenceId: ReadableAtom<string | null> = this.activeId;
  /** Why the last start failed, cleared by the next attempt. */
  readonly error: ReadableAtom<string | null> = this.lastError;

  constructor(ports: RecorderPorts) {
    this.ports = ports;
  }

  /** Flip the switch to the opposite position. */
  toggle(): void {
    this.setActive(!this.wanted.get());
  }

  setActive(active: boolean): void {
    if (this.wanted.get() === active) return;
    this.wanted.set(active);
    if (active) this.lastError.set(null);
    this.reconcile();
  }

  getFrequencyData(): Uint8Array<ArrayBuffer> | null {
    return this.session?.live ? this.session.source.getFrequencyData() : null;
  }

  /** Switch off. A microphone that is still opening is let go of as soon as it has. */
  dispose(): void {
    this.setActive(false);
  }

  private reconcile(): void {
    const session = this.session;
    if (this.wanted.get()) {
      if (!session) this.beginSession();
    } else if (session?.live) {
      this.endSession(session);
    }
    // Wanted off while the microphone is still opening: nothing can be done to
    // a device that has not finished starting. `beginSession` reconciles again
    // once it has, and by then the switch may be back on.
  }

  private beginSession(): void {
    const referenceId = this.ports.newReferenceId();
    const session: Session = {
      referenceId,
      source: this.ports.createAudioSource(),
      retainer: this.ports.retain(referenceId),
      live: false,
      transcribing: false,
      capturedBytes: 0,
      releaseWakeLock: null,
    };
    this.session = session;
    this.sessionStatus.set("starting");

    const onChunk = (chunk: ArrayBuffer): void => {
      if (this.session !== session) return;
      session.capturedBytes += chunk.byteLength;
      session.retainer.append(chunk);
      this.startTranscribing(session);
      this.ports.sendAudio(referenceId, chunk);
    };

    session.source.start(onChunk).then(
      () => {
        session.live = true;
        if (this.wanted.get()) {
          this.startTranscribing(session);
          this.sessionStatus.set("recording");
          this.activeId.set(referenceId);
          this.holdWakeLock(session);
        }
        this.reconcile();
      },
      (err: unknown) => {
        // The microphone never started: nothing to keep, nothing to finish.
        session.retainer.discard();
        this.session = null;
        this.sessionStatus.set("idle");
        this.lastError.set(err instanceof Error ? err.message : "Failed to start");
        this.wanted.set(false);
      },
    );
  }

  /** Open the transcription the first time there is audio (or the recording is confirmed live) — once. */
  private startTranscribing(session: Session): void {
    if (session.transcribing) return;
    session.transcribing = true;
    this.ports.beginTranscription(session.referenceId);
  }

  private holdWakeLock(session: Session): void {
    const acquire = this.ports.acquireWakeLock;
    if (!acquire) return;
    // Best effort: a wake lock that is denied, or that arrives after the
    // recording has already ended, is not worth interrupting anything for.
    acquire.call(this.ports).then(
      (release) => {
        if (this.session === session) session.releaseWakeLock = release;
        else release();
      },
      () => undefined,
    );
  }

  private endSession(session: Session): void {
    this.session = null;
    this.sessionStatus.set("idle");
    this.activeId.set(null);

    session.source.stop();
    session.releaseWakeLock?.();
    if (session.transcribing) this.ports.endTranscription(session.referenceId);
    // A recording that never heard anything and never opened a transcription
    // (cancelled before the microphone was ready) leaves nothing behind.
    if (session.capturedBytes > 0 || session.transcribing) session.retainer.commit();
    else session.retainer.discard();
  }
}
