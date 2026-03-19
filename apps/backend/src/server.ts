import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { transcribeAudioPackets } from "@vxbeamer/transcription";
import {
  createAccessToken,
  createAuthorizationCode,
  type AuthorizationCode,
  verifyAccessToken,
  verifyPkce,
} from "./auth.ts";

const oidcClientId = process.env.OIDC_CLIENT_ID ?? "vxbeamer-mobile";
const authSecret = process.env.OIDC_SECRET ?? "local-dev-secret";
const port = Number(process.env.PORT ?? "8787");

const authorizationCodes = new Map<string, AuthorizationCode>();

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

  if (request.method === "GET" && url.pathname === "/oidc/authorize") {
    const clientId = url.searchParams.get("client_id");
    const challenge = url.searchParams.get("code_challenge");
    const challengeMethod = url.searchParams.get("code_challenge_method");
    const state = url.searchParams.get("state") ?? "";

    if (clientId !== oidcClientId || !challenge || challengeMethod !== "S256") {
      json(response, 400, { error: "Invalid authorize request" });
      return;
    }

    const code = createAuthorizationCode();
    authorizationCodes.set(code, {
      challenge,
      expiresAt: Date.now() + 60_000,
      subject: randomUUID(),
    });

    json(response, 200, { code, state });
    return;
  }

  if (request.method === "POST" && url.pathname === "/oidc/token") {
    const body = await readBody(request);
    const params = new URLSearchParams(body);
    const code = params.get("code");
    const codeVerifier = params.get("code_verifier");
    const clientId = params.get("client_id");

    if (!code || !codeVerifier || clientId !== oidcClientId) {
      json(response, 400, { error: "Invalid token request" });
      return;
    }

    const grant = authorizationCodes.get(code);
    if (!grant || grant.expiresAt < Date.now()) {
      json(response, 400, { error: "Authorization code expired" });
      return;
    }

    if (!verifyPkce(codeVerifier, grant.challenge)) {
      json(response, 401, { error: "PKCE verification failed" });
      return;
    }

    authorizationCodes.delete(code);
    const accessToken = createAccessToken(grant.subject, authSecret);
    json(response, 200, {
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: 600,
    });
    return;
  }

  json(response, 404, { error: "Not found" });
});

const websocketServer = new WebSocketServer({ noServer: true });

function sendMessage(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
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
