// Shared between `playwright.config.ts` (which passes this to the backend's
// `webServer` as `OIDC_SECRET`) and `e2e/support.ts` (which uses it to mint
// per-test access tokens directly with `createAccessToken`, bypassing the
// `/auth/token` API-key exchange for every test except the one that
// deliberately exercises that exchange end to end). Kept as one shared
// constant, rather than a hardcoded string in each file, so the two never
// drift out of sync.
export const OIDC_SECRET = "e2e-test-secret";
