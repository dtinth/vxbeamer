export interface UsageRecord {
  sku: string;
  unitPrice: number;
  quantity: number;
}

export interface ASRSessionCallbacks {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
  onUsage?: (records: UsageRecord[]) => void;
}

/**
 * Extends {@link ASRSessionCallbacks} rather than replacing it, so existing
 * code that builds a plain callbacks object keeps type-checking unchanged —
 * `clientId` is optional, and a provider that does not understand it just
 * behaves as it always has.
 */
export interface ASRCreateSessionOptions extends ASRSessionCallbacks {
  /**
   * An opaque key identifying which caller this session belongs to, scoped by
   * the caller (e.g. a backend combines its own subject with a client-supplied
   * id so two different accounts can never collide). A provider with no notion
   * of session reuse ignores this entirely. One that supports it (currently
   * only `qwen-omni`) may keep its vendor connection open after a turn ends and
   * hand the *same* connection back to a later `createSession` call carrying
   * the same `clientId`, so the vendor keeps the prior turn's context.
   */
  clientId?: string;
}

export interface ASRSession {
  /**
   * Feed PCM (16 kHz, 16-bit signed, mono) **at roughly realtime pace**.
   *
   * These are realtime vendors, and pushing audio faster than it was recorded
   * is not a free speed-up: Qwen returns a different transcript, and BytePlus
   * hangs outright. A live microphone paces itself, but anything replaying
   * buffered audio — an eval run comparing configurations, say — must throttle
   * to about 1x. Billing is per audio-second, so pacing costs nothing.
   */
  sendAudio(chunk: Buffer): void;
  finish(): void;
  /**
   * Hang up the vendor connection immediately, without waiting for a final
   * transcript. Idempotent, and safe to call in any state.
   *
   * Unlike {@link finish}, this makes no attempt to end the turn gracefully: it
   * exists so an abandoned or idle session can be reclaimed even when the vendor
   * would never send its terminal event. These are metered, capped connections
   * (the vendors reject new sockets past a per-account limit), so a session that
   * can no longer produce a transcript must release its socket rather than hold
   * it until the vendor's own session cap reaps it. After `close()`, the session
   * emits no further callbacks — the caller asked for the teardown and owns it.
   */
  close(): void;
}

export interface ASRProvider {
  createSession(options: ASRCreateSessionOptions): ASRSession;
}
