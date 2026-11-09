/**
 * Pairing: signing in with a link the backend's `/pair` page shows, instead of
 * running the OIDC flow here. The link is `<backend>/pair#<code>`, so it names
 * the backend as well as the code, and nothing about the backend is hardcoded.
 */

const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

export interface PairingLink {
  backendUrl: string;
  code: string;
}

/** Reads a pairing link as pasted or scanned. `null` when it is not one. */
export function parsePairingLink(input: string): PairingLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) return null;
  if (url.pathname.replace(/\/+$/, "") !== "/pair") return null;
  const code = url.hash.slice(1).replace(/[\s-]/g, "").toUpperCase();
  if (!CODE_PATTERN.test(code)) return null;
  return { backendUrl: url.origin, code };
}

export async function redeemPairingCode(
  backendUrl: string,
  code: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(new URL("/auth/pair", backendUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `Pairing failed (${res.status})`);
  if (!body.access_token) throw new Error("No access_token in pairing response");
  if (!body.refresh_token) throw new Error("No refresh_token in pairing response");
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

const SCANNER_ORIGIN = "https://qr.spacet.me";

/**
 * Scans a QR code in a popup of dtinth's qr.spacet.me scanner, which posts the
 * text back. Resolves with `null` if the popup is closed without a scan, or is
 * blocked.
 */
export function scanQrCode(): Promise<string | null> {
  return new Promise((resolve) => {
    const popup = window.open(
      `${SCANNER_ORIGIN}/?action=scan&fit=cover&delay=100&post=opener`,
      "_blank",
      "width=320,height=320,toolbar=no",
    );
    if (!popup) return resolve(null);

    const finish = (text: string | null) => {
      window.removeEventListener("message", onMessage);
      clearInterval(closedPoll);
      resolve(text);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup || event.origin !== SCANNER_ORIGIN) return;
      const data = event.data as { text?: unknown } | null;
      if (typeof data?.text !== "string") return;
      popup.close();
      finish(data.text);
    };
    const closedPoll = setInterval(() => {
      if (popup.closed) finish(null);
    }, 500);
    window.addEventListener("message", onMessage);
  });
}
