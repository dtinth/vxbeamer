import { defineConfig, devices } from "@playwright/test";
import { OIDC_SECRET } from "./e2e/testConfig.ts";

const backendPort = 8788;
const frontendPort = 5174;

// API_KEYS in sub:secret format - matches E2E_API_KEY in e2e/recording.spec.ts.
// This pair is deliberately used by exactly one test ("records audio and
// displays transcript from mock ASR" in e2e/recording.spec.ts), which is the
// one that exercises the real `/auth/token` API-key exchange end to end.
// Every other test mints its own access token directly (see
// `signInAsFreshSubject` in e2e/support.ts) rather than going through this
// pair, so this subject is never shared.
const apiKeyPair = "e2e:e2e-test-api-key";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  // The backend is one long-lived process (see the single `webServer` entry
  // below, not one per worker), with no reset between tests or spec files
  // (`apps/backend/src/store.ts` keeps one in-memory message log per subject
  // for the life of the process). Two tests running concurrently that shared
  // a subject would see each other's messages appear on their own pages
  // mid-test, corrupting card counts and producing duplicate-text elements
  // (dtinth/vxbeamer, recording.spec.ts "records audio and displays
  // transcript from mock ASR" failing with a strict-mode violation on two
  // identical "Good morning…" cards). Every test besides that one now signs
  // in as its own private, never-reused subject (see `signInAsFreshSubject`
  // in e2e/support.ts), which removes that cross-test bleed at its source —
  // but workers stay pinned to 1 anyway, since a single shared frontend/
  // backend dev-server pair per run isn't necessarily safe under concurrent
  // browser contexts beyond just message isolation.
  workers: 1,
  use: {
    baseURL: `http://localhost:${frontendPort}`,
    headless: true,
  },
  projects: [
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: [
    {
      command: "node --experimental-strip-types apps/backend/src/server.ts",
      port: backendPort,
      env: {
        PORT: String(backendPort),
        ASR_PROVIDER: "mock",
        // An eval set worth looking at, without a credential in sight: mock is
        // the only configured one, so the eval dialog shows one row that really
        // streams alongside the "not set up" rows an under-credentialled server
        // is meant to surface rather than hide. No vendor is ever called.
        ASR_CONFIGURATIONS: [
          "qwen/qwen3-asr-flash-realtime-2025-10-27",
          "qwen/qwen3-asr-flash-realtime-2025-10-27+groq",
          "byteplus/bigmodel_nostream",
          "mock/mock",
        ].join(","),
        // Eval storage, with credentials that are deliberately fake and an
        // endpoint nothing ever contacts. Presigning is an HMAC over a URL — it
        // makes no network call — so this exercises the real signing path and
        // the real `{ ok, upload }` response while the browser intercepts the
        // PUTs. No bucket, no vendor, no bytes off this machine.
        EVAL_STORAGE_BUCKET: "e2e-eval",
        EVAL_STORAGE_ACCESS_KEY_ID: "e2e-fake-access-key",
        EVAL_STORAGE_SECRET_ACCESS_KEY: "e2e-fake-secret-key",
        EVAL_STORAGE_ENDPOINT: "http://127.0.0.1:9999",
        EVAL_STORAGE_FORCE_PATH_STYLE: "true",
        API_KEYS: apiKeyPair,
        OIDC_DISCOVERY_URL: "https://mockapis.onrender.com/oauth/.well-known/openid-configuration",
        OIDC_SECRET,
      },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `vp dev --port ${frontendPort} --strictPort`,
      port: frontendPort,
      cwd: "./apps/website",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
