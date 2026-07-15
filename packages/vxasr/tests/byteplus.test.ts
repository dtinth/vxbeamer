import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, expect, test } from "vite-plus/test";
import { createBytePlusProvider, createDefaultProviderRegistry } from "../src/index.ts";

/**
 * A local stand-in for the vendor. It speaks just enough of the BytePlus frame
 * format to let a session complete, and records what the adapter sent it — the
 * endpoint path and the full-client-request payload are the whole subject here,
 * and neither can be observed without a server on the other end. No network.
 */
interface FakeVendor {
  readonly baseUrl: string;
  /** Path the adapter connected to, e.g. `/bigmodel_nostream`. */
  readonly path: () => string | undefined;
  /** The decoded full-client-request payload. */
  readonly handshake: () => Promise<Record<string, any>>;
  close(): Promise<void>;
}

function buildServerResponse(payload: object, isLast: boolean): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  // Header(4) | Sequence(4) | PayloadSize(4) | Payload
  const header = Buffer.from([0x11, isLast ? 0x92 : 0x90, 0x10, 0x00]);
  const sequence = Buffer.alloc(4);
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, sequence, size, json]);
}

async function startFakeVendor(options: { text?: string } = {}): Promise<FakeVendor> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server });

  let path: string | undefined;
  let resolveHandshake: (payload: Record<string, any>) => void;
  const handshake = new Promise<Record<string, any>>((resolve) => {
    resolveHandshake = resolve;
  });

  wss.on("connection", (ws: WebSocket, request) => {
    path = request.url;
    ws.on("message", (data: Buffer) => {
      const msgType = (data[1]! >> 4) & 0xf;
      if (msgType === 0b0001) {
        // Full client request: decode the JSON that follows the 4-byte header
        // and 4-byte size.
        const size = data.readUInt32BE(4);
        resolveHandshake(JSON.parse(data.subarray(8, 8 + size).toString("utf8")));
        return;
      }
      // Audio packet. Reply with a final only once the last one lands, which is
      // what `bigmodel_nostream` does for a clip under 15 s: no partials.
      const isLastAudio = (data[1]! & 0xf) === 0b0010;
      if (isLastAudio) {
        ws.send(
          buildServerResponse(
            { result: { text: options.text ?? "สวัสดี" }, is_last_package: true },
            true,
          ),
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `ws://127.0.0.1:${port}`,
    path: () => path,
    handshake: () => handshake,
    async close() {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const vendors: FakeVendor[] = [];

afterEach(async () => {
  await Promise.all(vendors.splice(0).map((vendor) => vendor.close()));
});

async function withVendor(options: { text?: string } = {}): Promise<FakeVendor> {
  const vendor = await startFakeVendor(options);
  vendors.push(vendor);
  return vendor;
}

/** Runs one short clip through a session and resolves when it ends. */
function transcribe(
  provider: ReturnType<typeof createBytePlusProvider>,
): Promise<{ final: string; partials: string[] }> {
  return new Promise((resolve, reject) => {
    const partials: string[] = [];
    let final = "";
    const session = provider.createSession({
      onPartial: (text) => partials.push(text),
      onFinal: (text) => {
        final = text;
      },
      onEnd: () => resolve({ final, partials }),
      onError: reject,
    });
    session.sendAudio(Buffer.alloc(3200));
    session.finish();
  });
}

test("the mode selects the endpoint path", async () => {
  const vendor = await withVendor();

  await transcribe(
    createBytePlusProvider({ apiKey: "k", model: "bigmodel", baseUrl: vendor.baseUrl }),
  );

  expect(vendor.path()).toBe("/bigmodel");
});

test("bigmodel_nostream is the default mode", async () => {
  const vendor = await withVendor();

  await transcribe(createBytePlusProvider({ apiKey: "k", baseUrl: vendor.baseUrl }));

  expect(vendor.path()).toBe("/bigmodel_nostream");
});

test("the language is sent in the audio object on bigmodel_nostream", async () => {
  const vendor = await withVendor();

  const provider = createBytePlusProvider({
    apiKey: "k",
    model: "bigmodel_nostream",
    language: "th-TH",
    baseUrl: vendor.baseUrl,
  });
  await transcribe(provider);
  const payload = await vendor.handshake();

  // Not in `request` — the vendor reads it off the audio object.
  expect(payload.audio.language).toBe("th-TH");
  expect(payload.request.language).toBeUndefined();
});

test("the language is withheld from bigmodel, which does not accept it", async () => {
  const vendor = await withVendor();

  const provider = createBytePlusProvider({
    apiKey: "k",
    model: "bigmodel",
    language: "th-TH",
    baseUrl: vendor.baseUrl,
  });
  await transcribe(provider);
  const payload = await vendor.handshake();

  expect(payload.audio.language).toBeUndefined();
});

test("both modes are the same model on the wire", async () => {
  const vendor = await withVendor();

  await transcribe(
    createBytePlusProvider({ apiKey: "k", model: "bigmodel_nostream", baseUrl: vendor.baseUrl }),
  );
  const payload = await vendor.handshake();

  // The mode lives in the path; `model_name` names the model, which is the same
  // one either way.
  expect(payload.request.model_name).toBe("bigmodel");
});

test("no language is sent when none is configured", async () => {
  const vendor = await withVendor();

  await transcribe(createBytePlusProvider({ apiKey: "k", baseUrl: vendor.baseUrl }));
  const payload = await vendor.handshake();

  expect("language" in payload.audio).toBe(false);
});

test("a session reports the final transcript and its usage", async () => {
  const vendor = await withVendor({ text: "สวัสดีครับ" });

  const provider = createBytePlusProvider({ apiKey: "k", baseUrl: vendor.baseUrl });
  const usage: unknown[] = [];
  const result = await new Promise<string>((resolve, reject) => {
    let final = "";
    const session = provider.createSession({
      onFinal: (text) => {
        final = text;
      },
      onUsage: (records) => usage.push(...records),
      onEnd: () => resolve(final),
      onError: reject,
    });
    session.sendAudio(Buffer.alloc(32000)); // 1 second
    session.finish();
  });

  expect(result).toBe("สวัสดีครับ");
  expect(usage).toEqual([{ sku: "byteplus:seedasr:seconds", unitPrice: 0.15 / 3600, quantity: 1 }]);
});

test("a clip that finishes before the socket opens still completes", async () => {
  const vendor = await withVendor({ text: "สั้น" });

  // `finish()` normally lands well after the handshake, but a short clip sent
  // fast can beat the connection. The last packet has to wait for the socket
  // rather than be dropped, or the turn never ends.
  const provider = createBytePlusProvider({ apiKey: "k", baseUrl: vendor.baseUrl });
  const result = await transcribe(provider);

  expect(result.final).toBe("สั้น");
});

test("an unknown mode is a programming error, not a request failure", () => {
  expect(() => createBytePlusProvider({ apiKey: "k", model: "bigmodel_async" })).toThrow(
    /Unknown BytePlus mode/,
  );
});

test("the language reaches the adapter from BYTEPLUS_LANGUAGE", async () => {
  const vendor = await withVendor();
  const registry = createDefaultProviderRegistry();

  const resolution = registry.resolve(
    { BYTEPLUS_API_KEY: "k", BYTEPLUS_LANGUAGE: "th-TH", BYTEPLUS_BASE_URL: vendor.baseUrl },
    { provider: "byteplus" },
  );

  expect(resolution.ok).toBe(true);
  if (!resolution.ok) throw new Error("unreachable");
  await transcribe(resolution.provider);
  const payload = await vendor.handshake();

  expect(payload.audio.language).toBe("th-TH");
});
