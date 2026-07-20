/**
 * A resettable deadline that fires when a socket has gone quiet for too long.
 *
 * Every `/ws` (and `/asr/eval`) connection holds one upstream vendor socket
 * open, and those are metered and capped — the vendors reject new connections
 * past a per-account limit ("connections too much max_connections 100"). A
 * client that opens a socket and then stops sending audio without ever sending
 * `stop` — a backgrounded app, a dropped network, a leaked tab — pins its vendor
 * connection open indefinitely, because the graceful `finish()` path waits for a
 * terminal event the vendor will never send for silence. Enough of those and the
 * pool is exhausted for everyone.
 *
 * This is the reclaim: arm a deadline when the session opens, {@link poke} it
 * forward on every audio frame, and when it elapses the caller tears the session
 * down. It watches *audio*, not liveness — a client can hold the socket open and
 * still be kicked, which is exactly the case a WebSocket ping/pong would miss.
 */
export interface IdleWatchdog {
  /** Defer the deadline by one full timeout. Call on each audio frame. */
  poke(): void;
  /** Cancel the deadline. Idempotent; call whenever the socket settles. */
  stop(): void;
}

/**
 * Creates a watchdog that calls {@link onIdle} once, `timeoutMs` after the most
 * recent {@link IdleWatchdog.poke} (or after creation, since a client that
 * connects and sends nothing at all is the worst offender to reclaim).
 *
 * A non-positive `timeoutMs` disables the watchdog entirely — the returned
 * handle is inert — so an operator can turn idle-kicking off with
 * `WS_IDLE_TIMEOUT_MS=0` without the call sites growing a branch.
 *
 * `onIdle` fires at most once: after it fires the watchdog is spent, and a
 * `poke` arriving later (a frame racing the teardown) does not re-arm it.
 */
export function createIdleWatchdog(timeoutMs: number, onIdle: () => void): IdleWatchdog {
  if (!(timeoutMs > 0)) {
    return { poke() {}, stop() {} };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  const arm = () => {
    if (done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      done = true;
      onIdle();
    }, timeoutMs);
  };

  arm();

  return {
    poke: arm,
    stop() {
      done = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
