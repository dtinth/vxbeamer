import { createMiddleware } from "hono/factory";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext, WSMessageReceive } from "hono/ws";
import { createQwenProvider, withGroqEnhancement } from "vxasr";
import type { ASRSession } from "vxasr";
import { createAccessToken, verifyAccessToken, verifyIdToken } from "./auth.ts";

// --- Config ---
const oidcDiscoveryUrl = process.env.OIDC_DISCOVERY_URL ?? "";
const oidcClientId = process.env.OIDC_CLIENT_ID ?? "vxbeamer-mobile";
const oidcAudience = process.env.OIDC_AUDIENCE ?? oidcClientId;
const authSecret = process.env.OIDC_SECRET ?? "local-dev-secret";
const port = Number(process.env.PORT ?? "8787");
const apiKeys = new Set(
  (process.env.API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
);
const webhookUrl = process.env.WEBHOOK_URL ?? "";
const ACCESS_TOKEN_TTL_SECONDS = 259200; // 3 days
const DISCOVERY_CACHE_TTL_MS = 3_600_000;
const ONE_DAY_MS = 86_400_000;

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
export interface Message {
  id: string;
  status: "recording" | "done" | "error";
  partial?: string;
  final?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const messages: Message[] = [];

function pruneMessages(): void {
  const cutoff = Date.now() - ONE_DAY_MS;
  let i = 0;
  while (i < messages.length && messages[i]!.updatedAt < cutoff) i++;
  if (i > 0) messages.splice(0, i);
}

// --- SSE Broadcast ---
type SseSend = (data: string) => void;
const sseClients = new Set<SseSend>();

function broadcast(payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const send of sseClients) send(data);
}

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
function authenticate(token: string): boolean {
  if (apiKeys.has(token)) return true;
  return verifyAccessToken(token, authSecret) !== null;
}

function extractToken(
  authHeader: string | undefined,
  queryToken: string | undefined,
): string | null {
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return queryToken ?? null;
}

// --- Hono App ---
const app = new Hono();
const nodeWs = createNodeWebSocket({ app });
const { upgradeWebSocket } = nodeWs;

app.use("*", cors({ origin: "*" }));

const authMiddleware = createMiddleware(async (c, next) => {
  const token = extractToken(c.req.header("Authorization"), c.req.query("access_token"));
  if (!token || !authenticate(token)) return c.json({ error: "Unauthorized" }, 401);
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
    const accessToken = createAccessToken(claims.sub, authSecret, ACCESS_TOKEN_TTL_SECONDS);
    return c.json({
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid id_token";
    return c.json({ error: message }, 401);
  }
});

app.post("/auth/refresh", authMiddleware, (c) => {
  const token = extractToken(c.req.header("Authorization"), c.req.query("access_token"));
  const payload = token ? verifyAccessToken(token, authSecret) : null;
  if (!payload) return c.json({ error: "Invalid token" }, 401);
  const accessToken = createAccessToken(payload.sub, authSecret, ACCESS_TOKEN_TTL_SECONDS);
  return c.json({
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
  });
});

app.get("/sse", authMiddleware, (c) => {
  return streamSSE(c, async (stream) => {
    pruneMessages();
    await stream.writeSSE({
      data: JSON.stringify({ type: "snapshot", messages }),
    });

    const send: SseSend = (data) => {
      void stream.writeSSE({ data });
    };
    sseClients.add(send);

    await new Promise<void>((resolve) => {
      stream.onAbort(resolve);
    });

    sseClients.delete(send);
  });
});

app.get("/messages", authMiddleware, (c) => {
  pruneMessages();
  return c.json({ messages });
});

app.get("/messages/:id", authMiddleware, (c) => {
  const msg = messages.find((m) => m.id === c.req.param("id"));
  if (!msg) return c.json({ error: "Not found" }, 404);
  return c.json(msg);
});

app.delete("/messages/:id", authMiddleware, (c) => {
  const id = c.req.param("id");
  const idx = messages.findIndex((m) => m.id === id);
  if (idx === -1) return c.json({ error: "Not found" }, 404);
  messages.splice(idx, 1);
  broadcast({ type: "deleted", messageId: id });
  return c.json({ ok: true });
});

app.post("/messages/:id/swipe", authMiddleware, (c) => {
  const msg = messages.find((m) => m.id === c.req.param("id"));
  if (!msg) return c.json({ error: "Not found" }, 404);
  broadcast({ type: "swiped", message: msg });
  return c.json({ ok: true });
});

app.get(
  "/ws",
  authMiddleware,
  upgradeWebSocket(() => {
    let asrSession: ASRSession | null = null;
    let message: Message | null = null;
    let finished = false;

    return {
      onOpen(_evt: Event, ws: WSContext) {
        const apiKey = process.env.DASHSCOPE_API_KEY;
        if (!apiKey) {
          ws.close(1011, "DASHSCOPE_API_KEY not configured");
          return;
        }

        message = {
          id: crypto.randomUUID(),
          status: "recording",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        messages.push(message);
        broadcast({ type: "created", message });

        const groqApiKey = process.env.GROQ_API_KEY;
        const qwen = createQwenProvider({ apiKey });
        const provider = groqApiKey ? withGroqEnhancement(qwen, { apiKey: groqApiKey }) : qwen;
        asrSession = provider.createSession({
          onPartial(text) {
            if (!message) return;
            message.partial = text;
            message.updatedAt = Date.now();
            broadcast({ type: "updated", message });
          },
          onFinal(text) {
            if (!message) return;
            message.final = text;
            message.partial = undefined;
            message.updatedAt = Date.now();
            broadcast({ type: "updated", message });
          },
          onEnd() {
            if (!message) return;
            message.status = "done";
            message.updatedAt = Date.now();
            broadcast({ type: "updated", message });
            void sendWebhook(message);
            ws.close(1000, "done");
          },
          onError(err) {
            if (!message) return;
            message.status = "error";
            message.error = err instanceof Error ? err.message : String(err);
            message.updatedAt = Date.now();
            broadcast({ type: "updated", message });
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
