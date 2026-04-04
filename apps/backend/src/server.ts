import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext, WSMessageReceive } from "hono/ws";
import { createQwenProvider, createMockProvider, withGroqEnhancement } from "vxasr";
import type { ASRProvider, ASRSession } from "vxasr";
import {
  type AccessTokenPayload,
  createAccessToken,
  createRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  verifyIdToken,
} from "./auth.ts";
import { createSwipedEvent } from "./events.ts";
import { createSubjectStore, type Message } from "./store.ts";
import { normalizeTranscriptText } from "./transcript.ts";

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

app.get(
  "/ws",
  authMiddleware,
  upgradeWebSocket((c) => {
    const subject = c.get("auth").sub;
    let asrSession: ASRSession | null = null;
    let message: Message | null = null;
    let finished = false;
    const referenceId = c.req.query("reference_id");

    return {
      onOpen(_evt: Event, ws: WSContext) {
        let provider: ASRProvider;
        if (process.env.ASR_PROVIDER === "mock") {
          provider = createMockProvider();
        } else {
          const apiKey = process.env.DASHSCOPE_API_KEY;
          if (!apiKey) {
            ws.close(1011, "DASHSCOPE_API_KEY not configured");
            return;
          }
          const groqApiKey = process.env.GROQ_API_KEY;
          const qwen = createQwenProvider({ apiKey });
          provider = groqApiKey ? withGroqEnhancement(qwen, { apiKey: groqApiKey }) : qwen;
        }

        message = {
          id: crypto.randomUUID(),
          referenceId,
          status: "recording",
          createdAt: Date.now(),
          updatedAt: Date.now(),
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
            if (!message) return;
            message.status = "done";
            message.updatedAt = Date.now();
            store.broadcast(subject, { type: "updated", message });
            void sendWebhook(message);
            ws.close(1000, "done");
          },
          onError(err) {
            if (!message) return;
            message.status = "error";
            message.error = err instanceof Error ? err.message : String(err);
            message.updatedAt = Date.now();
            store.broadcast(subject, { type: "updated", message });
            void sendWebhook(message);
            ws.close(1011, "ASR error");
          },
        });
      },

      onMessage(evt: MessageEvent<WSMessageReceive>) {
        const { data } = evt;
        if (data instanceof ArrayBuffer) {
          asrSession?.sendAudio(Buffer.from(data));
        } else if (ArrayBuffer.isView(data)) {
          asrSession?.sendAudio(
            Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
          );
        } else if (typeof data === "string") {
          try {
            const msg = JSON.parse(data) as { type?: string };
            if (msg.type === "stop" && !finished) {
              finished = true;
              asrSession?.finish();
            }
          } catch {
            // ignore invalid messages
          }
        }
      },

      onClose() {
        if (!finished) {
          finished = true;
          asrSession?.finish();
        }
      },
    };
  }),
);

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`vxbeamer backend listening on http://localhost:${port}`);
});

nodeWs.injectWebSocket(server);
