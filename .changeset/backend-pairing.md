---
"backend": minor
---

Add pairing: a signed-in browser opens `/pair` on the backend and gets a one-time link and QR code, and any client redeems it at `POST /auth/pair` for its own session, without running the OIDC flow itself.

Codes are 12 characters, last two minutes, work once, and live in memory. Redeeming is rate limited per caller and overall. The provider must allow `<backend>/pair` as a redirect URI, since that page runs the OIDC code flow. Set `PUBLIC_URL` to change the address put in pairing links.
