import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { transcribeAudioPackets } from "@vxbeamer/transcription";
import { createAccessToken, verifyAccessToken, verifyIdToken } from "./auth.ts";

const oidcDiscoveryUrl = process.env.OIDC_DISCOVERY_URL ?? "";
const oidcClientId = process.env.OIDC_CLIENT_ID ?? "vxbeamer-mobile";
const oidcAudience = process.env.OIDC_AUDIENCE ?? oidcClientId;
const authSecret = process.env.OIDC_SECRET ?? "local-dev-secret";
const port = Number(process.env.PORT ?? "8787");
const ACCESS_TOKEN_TTL_SECONDS = 600;
const DISCOVERY_CACHE_TTL_MS = 3_600_000;

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: { value: OidcDiscovery; expiresAt: number } | null = null;

async function fetchDiscovery(): Promise<OidcDiscovery> {
  const now = Date.now();
  if (discoveryCache && discoveryCache.expiresAt > now) {
    return discoveryCache.value;
  }
  if (!oidcDiscoveryUrl) {
    throw new Error("OIDC_DISCOVERY_URL not configured");
  }
  const res = await fetch(oidcDiscoveryUrl);
  if (!res.ok) {
    throw new Error("Failed to fetch OIDC discovery document");
  }
  const value = (await res.json()) as OidcDiscovery;
  discoveryCache = { value, expiresAt: now + DISCOVERY_CACHE_TTL_MS };
  return value;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (request, response) => {
  if (!request.url || !request.method) {
    json(response, 400, { error: "Invalid request" });
    return;
  }

  if (request.method === "OPTIONS") {
    json(response, 200, { ok: true });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "GET" && url.pathname === "/healthz") {
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/auth/config") {
    if (!oidcDiscoveryUrl) {
      json(response, 503, { error: "OIDC_DISCOVERY_URL not configured" });
      return;
    }
    let discovery: OidcDiscovery;
    try {
      discovery = await fetchDiscovery();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to fetch OIDC config";
      json(response, 502, { error: message });
      return;
    }
    json(response, 200, {
      clientId: oidcClientId,
      authorizationEndpoint: discovery.authorization_endpoint,
      tokenEndpoint: discovery.token_endpoint,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/auth/session") {
    if (!oidcDiscoveryUrl) {
      json(response, 503, { error: "OIDC_DISCOVERY_URL not configured" });
      return;
    }

    let body: { id_token?: string };
    try {
      body = JSON.parse(await readBody(request)) as typeof body;
    } catch {
      json(response, 400, { error: "Invalid request body" });
      return;
    }

    if (!body.id_token) {
      json(response, 400, { error: "Missing id_token" });
      return;
    }

    let subject: string;
    try {
      const discovery = await fetchDiscovery();
      const claims = await verifyIdToken(
        body.id_token,
        discovery.issuer,
        discovery.jwks_uri,
        oidcAudience,
      );
      subject = claims.sub;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid id_token";
      json(response, 401, { error: message });
      return;
    }

    const accessToken = createAccessToken(subject, authSecret, ACCESS_TOKEN_TTL_SECONDS);
    json(response, 200, {
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    });
    return;
  }

  json(response, 404, { error: "Not found" });
});

const websocketServer = new WebSocketServer({ noServer: true });

function sendMessage(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

websocketServer.on("connection", (socket: WebSocket) => {
  const packets: Uint8Array[] = [];
  let recording = false;

  sendMessage(socket, { type: "connected" });

  socket.on("message", async (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (recording) {
        packets.push(new Uint8Array(data as Buffer));
      }
      return;
    }

    const text = data.toString("utf8");
    let message: { type?: string } | null = null;

    try {
      message = JSON.parse(text) as { type?: string };
    } catch {
      sendMessage(socket, { type: "error", message: "Invalid message" });
      return;
    }

    if (message.type === "start") {
      packets.length = 0;
      recording = true;
      sendMessage(socket, { type: "recording" });
      return;
    }

    if (message.type === "stop") {
      recording = false;
      try {
        const result = await transcribeAudioPackets(packets);
        sendMessage(socket, { type: "transcription", text: result.text, bytes: result.bytes });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "Unable to transcribe";
        sendMessage(socket, { type: "error", message: messageText });
      }
      return;
    }

    sendMessage(socket, { type: "error", message: "Unsupported message type" });
  });
});

server.on("upgrade", (request, socket, head) => {
  if (!request.url) {
    socket.destroy();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get("access_token");
  if (!token || !verifyAccessToken(token, authSecret)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  websocketServer.handleUpgrade(request, socket, head, (ws: WebSocket) => {
    websocketServer.emit("connection", ws, request);
  });
});

server.listen(port, () => {
  console.log(`vxbeamer backend listening on http://localhost:${port}`);
});
