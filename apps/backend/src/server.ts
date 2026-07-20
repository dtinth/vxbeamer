import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext, WSMessageReceive } from "hono/ws";
import type { ASRSession } from "vxasr";
import { createConfigurationSelector } from "./asr.ts";
import { createIdleWatchdog, type IdleWatchdog } from "./idleWatchdog.ts";
import { isStopMessage, readAudioFrame } from "./wsFrame.ts";
import {
  type AccessTokenPayload,
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  verifyIdToken,
} from "./auth.ts";
import { createSwipedEvent } from "./events.ts";
import { createEvalSocketHandler } from "./evalSocket.ts";
import { createEvalStorage, type EvalUploadTargets } from "./evalStorage.ts";
import { createSubjectStore, type Message } from "./store.ts";
import { normalizeTranscriptText } from "./transcript.ts";
import { applyWinner } from "./winner.ts";

// --- Config ---
const oidcDiscoveryUrl = process.env.OIDC_DISCOVERY_URL ?? "";
const oidcClientId = process.env.OIDC_CLIENT_ID ?? "vxbeamer-mobile";
const oidcAudience = process.env.OIDC_AUDIENCE ?? oidcClientId;
const authSecret = process.env.OIDC_SECRET ?? "local-dev-secret";
const port = Number(process.env.PORT ?? "8787");
const apiKeys = new Map(
  (process.env.API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1)
        throw new Error(`Invalid API_KEYS entry (expected sub:secret): ${entry}`);
      return [entry.slice(colonIdx + 1), entry.slice(0, colonIdx)] as const;
    }),
);
const webhookUrl = process.env.WEBHOOK_URL ?? "";
// How long a recording socket may go without audio before it is kicked and its
// upstream vendor connection reclaimed. Vendor connections are capped per
// account, so an abandoned session that never sends `stop` must not pin one
// open forever. `0` (or any non-positive value) disables idle-kicking.
const wsIdleTimeoutMs = Number(process.env.WS_IDLE_TIMEOUT_MS ?? "60000");
// Throws on an unknown ASR_CONFIGURATION/ASR_PROVIDER/ASR_CONFIGURATIONS, so a
// typo fails the boot rather than silently transcribing with the wrong model.
const configurationSelector = createConfigurationSelector(process.env);
// `null` when no bucket is configured: eval storage is optional, and a server
// without it still records, transcribes, and applies eval winners.
const evalStorage = createEvalStorage(process.env);
const ACCESS_TOKEN_TTL_SECONDS = 900; // 15 minutes
const REFRESH_TOKEN_TTL_SECONDS = 259200; // 3 days
const DISCOVERY_CACHE_TTL_MS = 3_600_000;

// --- OIDC Discovery ---
interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: { value: OidcDiscovery; expiresAt: number } | null = null;

async function fetchDiscovery(): Promise<OidcDiscovery> {
  const now = Date.now();
  if (discoveryCache && discoveryCache.expiresAt > now) return discoveryCache.value;
  if (!oidcDiscoveryUrl) throw new Error("OIDC_DISCOVERY_URL not configured");
  const res = await fetch(oidcDiscoveryUrl);
  if (!res.ok) throw new Error("Failed to fetch OIDC discovery document");
  const value = (await res.json()) as OidcDiscovery;
  discoveryCache = { value, expiresAt: now + DISCOVERY_CACHE_TTL_MS };
  return value;
}

// --- Message Store ---
const store = createSubjectStore();

// --- Webhook ---
async function sendWebhook(message: Message): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "message.updated", message }),
    });
  } catch {
    // webhook failures are non-fatal
  }
}

// --- Auth ---
async function authenticate(token: string): Promise<AccessTokenPayload | null> {
  return await verifyAccessToken(token, authSecret);
}

function extractToken(
  authHeader: string | undefined,
  queryToken: string | undefined,
): string | null {
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return queryToken ?? null;
}

/** `?configuration=` with no value means "not specified", not "the empty id". */
function nonEmptyQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// --- Hono App ---
const app = new Hono<{ Variables: { auth: AccessTokenPayload } }>();
const nodeWs = createNodeWebSocket({ app });
const { upgradeWebSocket } = nodeWs;

app.use("*", cors({ origin: "*" }));

const authMiddleware = createMiddleware(async (c, next) => {
  const token = extractToken(c.req.header("Authorization"), c.req.query("access_token"));
  const auth = token ? await authenticate(token) : null;
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  c.set("auth", auth);
  await next();
});

app.get("/healthz", (c) => c.json({ ok: true }));

app.get("/auth/config", async (c) => {
  if (!oidcDiscoveryUrl) return c.json({ error: "OIDC_DISCOVERY_URL not configured" }, 503);
  try {
    const discovery = await fetchDiscovery();
    return c.json({
      clientId: oidcClientId,
      authorizationEndpoint: discovery.authorization_endpoint,
      tokenEndpoint: discovery.token_endpoint,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch OIDC config";
    return c.json({ error: message }, 502);
  }
});

app.post("/auth/session", async (c) => {
  if (!oidcDiscoveryUrl) return c.json({ error: "OIDC_DISCOVERY_URL not configured" }, 503);
  let body: { id_token?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  if (!body.id_token) return c.json({ error: "Missing id_token" }, 400);
  try {
    const discovery = await fetchDiscovery();
    const claims = await verifyIdToken(
      body.id_token,
      discovery.issuer,
      discovery.jwks_uri,
      oidcAudience,
    );
    const sid = crypto.randomUUID();
    const accessToken = await createAccessToken({
      subject: claims.sub,
      secret: authSecret,
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      sid,
      name: claims.name,
    });
    const refreshToken = await createRefreshToken({
      subject: claims.sub,
      secret: authSecret,
      ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
      sid,
      name: claims.name,
    });
    return c.json({
      token_type: "Bearer",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid id_token";
    return c.json({ error: message }, 401);
  }
});

app.post("/auth/token", async (c) => {
  let body: { api_key?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  if (!body.api_key) return c.json({ error: "Missing api_key" }, 400);
  const sub = apiKeys.get(body.api_key);
  if (!sub) return c.json({ error: "Invalid API key" }, 401);
  const accessToken = await createAccessToken({
    subject: sub,
    secret: authSecret,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
  });
  return c.json({
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
  });
});

app.post("/auth/refresh", async (c) => {
  let body: { refresh_token?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
  if (!body.refresh_token) return c.json({ error: "Missing refresh_token" }, 400);
  const refreshPayload = await verifyRefreshToken(body.refresh_token, authSecret);
  if (!refreshPayload) return c.json({ error: "Invalid refresh_token" }, 401);

  const accessToken = await createAccessToken({
    subject: refreshPayload.sub,
    secret: authSecret,
    ttlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    sid: refreshPayload.sid,
    name: refreshPayload.name,
  });
  const refreshToken = await createRefreshToken({
    subject: refreshPayload.sub,
    secret: authSecret,
    ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
    sid: refreshPayload.sid,
    name: refreshPayload.name,
  });
  return c.json({
    token_type: "Bearer",
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
  });
});

app.get("/sse", authMiddleware, (c) => {
  const subject = c.get("auth").sub;
  const eventsParam = c.req.query("events");
  const filter = eventsParam ? new Set(eventsParam.split(",").map((e) => e.trim())) : null;

  return streamSSE(c, async (stream) => {
    if (!filter) {
      await stream.writeSSE({
        data: JSON.stringify({ type: "snapshot", messages: store.listMessages(subject) }),
      });
    }

    const send = (data: string) => {
      if (filter) {
        try {
          const event = JSON.parse(data) as { type?: string };
          if (!event.type || !filter.has(event.type)) return;
        } catch {
          return;
        }
      }
      void stream.writeSSE({ data });
    };
    const unsubscribe = store.subscribe(subject, send);

    const heartbeat = setInterval(() => {
      void stream.write(": keepalive\n\n");
    }, 15000);

    await new Promise<void>((resolve) => {
      stream.onAbort(resolve);
    });

    clearInterval(heartbeat);
    unsubscribe();
  });
});

/**
 * What a client may transcribe with — and therefore what an eval fans out to.
 *
 * There is no separate eval set. An eval opens one `/ws` per configuration, so
 * any eval-only list could only ever be a subset of what `/ws` accepts; a
 * second env var could only disagree with the first, and disagreeing would mean
 * either advertising configurations that `/ws` rejects or hiding ones it
 * serves. The selectable set already *is* the answer.
 *
 * Unlike the routes below, this is not subject-scoped: the catalogue is a
 * property of the server, identical for every subject. It is still behind auth,
 * because it describes how the server is set up.
 */
app.get("/asr/configurations", authMiddleware, (c) => {
  return c.json({
    // The primary is itself an eval candidate, and appears in the list like any
    // other. It is named separately so the dialog can mark it and know which
    // result the winner would replace — as an id rather than a per-entry flag,
    // so there is one source of truth for "which one is primary".
    primaryConfigurationId: configurationSelector.defaultConfigurationId,
    configurations: configurationSelector.listConfigurations(),
  });
});

app.get("/messages", authMiddleware, (c) => {
  return c.json({ messages: store.listMessages(c.get("auth").sub) });
});

app.get("/messages/:id", authMiddleware, (c) => {
  const msg = store.findMessage(c.get("auth").sub, c.req.param("id"));
  if (!msg) return c.json({ error: "Not found" }, 404);
  return c.json(msg);
});

app.delete("/messages/:id", authMiddleware, (c) => {
  const subject = c.get("auth").sub;
  const id = c.req.param("id");
  if (!store.deleteMessage(subject, id)) return c.json({ error: "Not found" }, 404);
  store.broadcast(subject, { type: "deleted", messageId: id });
  return c.json({ ok: true });
});

app.post("/messages/:id/swipe", authMiddleware, (c) => {
  const subject = c.get("auth").sub;
  const msg = store.findMessage(subject, c.req.param("id"));
  if (!msg) return c.json({ error: "Not found" }, 404);
  store.broadcast(subject, createSwipedEvent(msg));
  return c.json({ ok: true });
});

/**
 * The user picked an eval winner: its transcript becomes this message's answer.
 *
 * Eval runs create no message of their own, so there is nothing to merge — this
 * is an update to the existing message, propagated exactly as the live
 * transcription path propagates one. The webhook re-fires because downstream
 * was already told the primary's answer when the recording finished, and this
 * is the correction; `message.updated` already names what a second update is.
 *
 * The response carries the presigned upload URLs for this pick's vote and
 * eval-set, rather than a separate `POST /eval/upload-url` endpoint minting
 * them. Three reasons:
 *
 *  1. **A vote fires on every winner pick** — there is no pick without one. Two
 *     endpoints always called together, in fixed order, with the second's
 *     arguments being exactly the first's input, are one operation wearing two
 *     hats.
 *  2. **The `configurationId` is validated here and nowhere else.** A separate
 *     endpoint would either re-run `isEnabled` (two places to keep honest) or
 *     mint a URL for an unvalidated id — and an id the server does not serve is
 *     precisely the noise the vote stream cannot afford, since configuration
 *     ids *are* the dataset.
 *  3. **Signing is offline HMAC**, so returning both URLs costs microseconds and
 *     saves the client a round-trip on the one action a user is waiting on.
 *
 * `upload` is `null` when no bucket is configured, and also when signing throws.
 * Storage is bookkeeping; replacing the answer is the user-visible act, and it
 * has already happened by the time this line runs. A vote is worth having, not
 * worth failing a pick over.
 */
app.post("/messages/:id/winner", authMiddleware, async (c) => {
  const subject = c.get("auth").sub;
  const message = store.findMessage(subject, c.req.param("id"));
  if (!message) return c.json({ error: "Not found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const result = applyWinner(message, body, {
    isEnabledConfiguration: (id) => configurationSelector.isEnabled(id),
  });
  if (!result.ok) {
    return c.json({ error: result.message }, result.code === "not_replaceable" ? 409 : 400);
  }

  store.broadcast(subject, { type: "updated", message });
  void sendWebhook(message);

  let upload: EvalUploadTargets | null = null;
  if (evalStorage) {
    try {
      upload = await evalStorage.createUploadTargets({ messageId: message.id, at: Date.now() });
    } catch (error) {
      // The winner is already applied and broadcast above; losing a vote is the
      // whole cost of this branch.
      console.error("Failed to sign eval upload URLs", error);
    }
  }

  return c.json({ ok: true, upload });
});

app.get(
  "/ws",
  authMiddleware,
  upgradeWebSocket((c) => {
    const subject = c.get("auth").sub;
    let asrSession: ASRSession | null = null;
    let message: Message | null = null;
    let finished = false;
    // Guards the message's terminal transition so the socket settles once,
    // whichever of end / error / idle-timeout gets there first.
    let settled = false;
    let idle: IdleWatchdog | null = null;
    const referenceId = c.req.query("reference_id");
    const configurationParam = nonEmptyQuery(c.req.query("configuration"));

    return {
      onOpen(_evt: Event, ws: WSContext) {
        const result = configurationSelector.select({ configuration: configurationParam });
        if (!result.ok) {
          // 1011 for a server-side misconfiguration, 1008 for a request naming
          // a provider/model the server will not serve. Either way the socket
          // closes before any message is stored.
          ws.close(result.code === "not_configured" ? 1011 : 1008, result.message);
          return;
        }
        const { provider, configurationId } = result.selection;

        message = {
          id: crypto.randomUUID(),
          referenceId,
          status: "recording",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          configurationId,
        };
        store.addMessage(subject, message);
        store.broadcast(subject, { type: "created", message });
        asrSession = provider.createSession({
          onUsage(records) {
            if (!message) return;
            message.usage = [...(message.usage ?? []), ...records];
          },
          onPartial(text) {
            if (!message) return;
            message.partial = normalizeTranscriptText(text);
            message.updatedAt = Date.now();
            store.broadcast(subject, { type: "updated", message });
          },
          onFinal(text) {
            if (!message) return;
            message.final = normalizeTranscriptText(text);
            message.partial = undefined;
            message.updatedAt = Date.now();
            store.broadcast(subject, { type: "updated", message });
          },
          onEnd() {
            if (!message || settled) return;
            settled = true;
            idle?.stop();
            message.status = "done";
            message.updatedAt = Date.now();
            store.broadcast(subject, { type: "updated", message });
            void sendWebhook(message);
            ws.close(1000, "done");
          },
          onError(err) {
            if (!message || settled) return;
            settled = true;
            idle?.stop();
            message.status = "error";
            message.error = err instanceof Error ? err.message : String(err);
            message.updatedAt = Date.now();
            store.broadcast(subject, { type: "updated", message });
            void sendWebhook(message);
            ws.close(1011, "ASR error");
          },
        });

        // From here a vendor connection is open. Kick the session if it falls
        // silent, so an abandoned recording releases that connection rather than
        // holding one of the vendor's capped slots until it reaps the session
        // itself. `close()` aborts the vendor socket outright — the graceful
        // `finish()` waits for a terminal event silence will never produce.
        idle = createIdleWatchdog(wsIdleTimeoutMs, () => {
          if (settled) return;
          settled = true;
          finished = true;
          asrSession?.close();
          if (message) {
            message.status = "error";
            message.error = `Idle timeout: no audio received for ${Math.round(
              wsIdleTimeoutMs / 1000,
            )}s`;
            message.updatedAt = Date.now();
            store.broadcast(subject, { type: "updated", message });
            void sendWebhook(message);
          }
          ws.close(1008, "idle timeout");
        });
      },

      onMessage(evt: MessageEvent<WSMessageReceive>) {
        const audio = readAudioFrame(evt.data);
        if (audio !== null) {
          idle?.poke();
          asrSession?.sendAudio(audio);
        } else if (isStopMessage(evt.data) && !finished) {
          finished = true;
          // The client is done sending; the vendor now owns the clock while it
          // finalises, so stop watching for client silence.
          idle?.stop();
          asrSession?.finish();
        }
      },

      onClose() {
        idle?.stop();
        if (!finished) {
          finished = true;
          asrSession?.finish();
        }
      },
    };
  }),
);

/**
 * Eval replay: transcribe without touching the message log.
 *
 * The dialog opens one of these per configuration and replays the retained PCM
 * through each in parallel, so the fan-out lives entirely in the frontend and
 * this server stays as stateless for an eval as it is for a recording. See
 * `./evalSocket.ts` for why this is a route rather than a `?eval=1` on `/ws`.
 */
app.get(
  "/asr/eval",
  authMiddleware,
  upgradeWebSocket((c) =>
    createEvalSocketHandler({
      selector: configurationSelector,
      configuration: nonEmptyQuery(c.req.query("configuration")),
      idleTimeoutMs: wsIdleTimeoutMs,
    }),
  ),
);

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`vxbeamer backend listening on http://localhost:${port}`);
});

nodeWs.injectWebSocket(server);
