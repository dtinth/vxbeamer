import { afterEach, expect, test, vi } from "vite-plus/test";
import { parsePairingLink, redeemPairingCode } from "./pairing.ts";

afterEach(() => vi.unstubAllGlobals());

test("a pairing link names the backend and the code", () => {
  expect(parsePairingLink("https://vx.example.com/pair#5FSW5KA3MS7B")).toEqual({
    backendUrl: "https://vx.example.com",
    code: "5FSW5KA3MS7B",
  });
});

test("a pasted link is tolerated: spaces, a trailing slash, lowercase, dashes", () => {
  expect(parsePairingLink("  https://vx.example.com/pair/#5fsw-5ka3-ms7b \n")).toEqual({
    backendUrl: "https://vx.example.com",
    code: "5FSW5KA3MS7B",
  });
});

test("plain http is only accepted for localhost", () => {
  expect(parsePairingLink("http://localhost:8787/pair#5FSW5KA3MS7B")?.backendUrl).toBe(
    "http://localhost:8787",
  );
  expect(parsePairingLink("http://vx.example.com/pair#5FSW5KA3MS7B")).toBeNull();
});

test("anything else is not a pairing link", () => {
  expect(parsePairingLink("")).toBeNull();
  expect(parsePairingLink("5FSW5KA3MS7B")).toBeNull();
  expect(parsePairingLink("https://vx.example.com/#5FSW5KA3MS7B")).toBeNull();
  expect(parsePairingLink("https://vx.example.com/pair")).toBeNull();
  expect(parsePairingLink("https://vx.example.com/pair#TOO-SHORT")).toBeNull();
  // I, L, O and U are not in the alphabet.
  expect(parsePairingLink("https://vx.example.com/pair#ILOUILOUILOU")).toBeNull();
});

test("redeeming posts the code to the backend named by the link", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ access_token: "access", refresh_token: "refresh" }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(redeemPairingCode("https://vx.example.com", "5FSW5KA3MS7B")).resolves.toEqual({
    accessToken: "access",
    refreshToken: "refresh",
  });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://vx.example.com/auth/pair");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body as string)).toEqual({ code: "5FSW5KA3MS7B" });
});

test("a refused code reports the backend's reason", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "Invalid or expired code" }, { status: 401 })),
  );
  await expect(redeemPairingCode("https://vx.example.com", "5FSW5KA3MS7B")).rejects.toThrow(
    "Invalid or expired code",
  );
});
