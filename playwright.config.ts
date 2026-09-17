import { defineConfig, devices } from "@playwright/test";

const backendPort = 8788;
const frontendPort = 5174;

// API_KEYS in sub:secret format - matches E2E_API_KEY in e2e/recording.spec.ts
const apiKeyPair = "e2e:e2e-test-api-key";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  // The backend is one long-lived process (see the single `webServer` entry
  // below, not one per worker) and every e2e test signs in as the same
  // `e2e` subject (see `apiKeyPair`). The backend keeps one in-memory
  // message log per subject and broadcasts every update over SSE to every
  // client subscribed to that subject (`apps/backend/src/store.ts`) — so two
  // tests running concurrently in different workers are not isolated from
  // each other: each sees the other's messages appear on its own page mid-
  // test, corrupting card counts and producing duplicate-text elements
  // (dtinth/vxbeamer, recording.spec.ts "records audio and displays
  // transcript from mock ASR" failing with a strict-mode violation on two
  // identical "Good morning…" cards). Forcing a single worker makes tests
  // run strictly one at a time against that shared subject, which is what
  // every spec here already assumes.
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
        OIDC_SECRET: "e2e-test-secret",
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
