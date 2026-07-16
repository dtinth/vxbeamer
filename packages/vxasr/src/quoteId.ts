/**
 * Ids reach us from untrusted query params, and the errors quoting them end up
 * in places with hard length limits (a websocket close reason caps at 123
 * bytes). Keep the echo short so an absurd id cannot burst the frame.
 *
 * Shared by the provider registry and the configuration catalogue: both quote
 * client-supplied ids into errors that become close reasons, so the length they
 * clamp to is one decision, not two that happen to agree today.
 *
 * Deliberately *not* shared with `apps/backend`'s look-alike. That one quotes
 * ids into an HTTP body and clamps for its own reasons; it is the same nine
 * characters for a different purpose, and coupling them would tie a JSON error
 * message to a websocket frame limit.
 */
export function quoteId(id: string): string {
  return JSON.stringify(id.length > 32 ? `${id.slice(0, 32)}…` : id);
}
