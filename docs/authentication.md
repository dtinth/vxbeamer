# Authentication

vxbeamer comes with two authentication methods:

- **User authentication** via OIDC, for interactive use from the frontend.
- **API keys** (via `API_KEYS`), for integration with scripts.

## User authentication

The OIDC provider must support:

1. **PKCE flow** — the frontend performs the authorization code flow with PKCE and exchanges the resulting ID token for a session with the backend.
2. **Discovery document** — the provider must expose its configuration at the standard `/.well-known/openid-configuration` path.
3. **CORS** — cross-origin requests must be allowed, since the frontend will contact the provider directly from the browser.
4. **Restricted token issuance** — the provider must only issue ID tokens to authorized users. There is no built-in user whitelist in vxbeamer itself, so access control must be enforced at the provider level.

[Authentik](https://goauthentik.io) is a self-hosted, open-source identity provider that meets all of these requirements.

(pairing-a-client)=

## Pairing a client

Clients that cannot easily sign in themselves (a PWA on iOS, the Android app, anything on a different machine from the browser you are signed in on) pair instead. Open `/pair` on your backend, sign in, and it shows a one-time pairing link and QR code. Open the link in the client, scan the QR code, or paste the link into its pairing box. The link carries the backend's address and a 12-character code; the client redeems the code at `POST /auth/pair` for its own session.

Codes are valid for two minutes and work once. They are kept in memory, so a backend running several instances would need to share them.

The `/pair` page runs the OIDC code flow itself, so the provider must allow `https://<your-backend>/pair` as a redirect URI. Register it as an exact match, not a wildcard. Set `PUBLIC_URL` if the backend sits behind a proxy and the link should not use the address it sees.

## API keys (personal access tokens)

Set the `API_KEYS` environment variable in the format `<sub>:<key>`. In case of multiple keys, separate by commas:

```
API_KEYS=your-sub-claim:my-secret-key,your-sub-claim:another-secret
```

To find your `sub` claim:

1. Pair the web app with your backend (see {ref}`pairing-a-client`)
2. Open Settings (⚙️ icon)
3. Copy your `sub` from the "Signed in" section

The `<sub>` must match the `sub` claim of your OIDC user. You can have multiple keys for the same user (useful for key rotation or different integrations).

API keys are not used directly for authenticated requests. Instead, scripts exchange them for short-lived access tokens via `POST /auth/token`. This keeps all authentication consistent: protected endpoints only accept session tokens, regardless of whether they came from OIDC or API key exchange.

## Access tokens

All protected endpoints require an access token. Pass it as:

- `Authorization: Bearer <token>` header, or
- `?access_token=<token>` query parameter

### Token flow

**For OIDC users (interactive frontend):**

1. Exchange OIDC id_token for access & refresh tokens: `POST /auth/session` with `id_token`
2. Access token (15 min TTL) is used for protected endpoints
3. When access token < 10 minutes remaining, refresh both tokens: `POST /auth/refresh` with `refresh_token`
4. Refresh token is valid for 3 days from the last refresh

**For API keys (scripts/integrations):**

1. Exchange API key for access token: `POST /auth/token` with `api_key`
2. Access token (15 min TTL) is used for protected endpoints
3. No refresh token is issued; obtain a new access token by exchanging the API key again
