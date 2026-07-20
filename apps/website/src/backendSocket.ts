/**
 * Builds a `ws(s)://` URL to a backend socket route from the `http(s)` backend
 * base. Both audio sockets — the recording `/ws` and each eval `/asr/eval` —
 * derive their URL the same way: swap the scheme to WebSocket, set the path,
 * drop any inherited query, and attach params.
 *
 * `searchParams.set` is not a convenience here, it is the requirement: a
 * configuration id may contain `+` (`qwen/qwen3-asr-flash-realtime+groq`), and a
 * hand-built query string would send that `+` literally, which the server
 * decodes back as a space and then fails to recognise. `set` percent-encodes it.
 */
export function buildBackendSocketUrl(
  backendUrl: string,
  pathname: string,
  params: Record<string, string>,
): string {
  const url = new URL(backendUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
