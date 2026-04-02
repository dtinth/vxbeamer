import { defineConfig, devices } from "@playwright/test";

const backendPort = 8788;
const frontendPort = 5174;

// This token must match E2E_TOKEN in e2e/recording.spec.ts.
// Format: base64url({"alg":"HS256","typ":"JWT"}).base64url({"sub":"e2e","exp":4102444800}).e2e
// The backend accepts it as a raw API key; the frontend parses it as a valid session token.
const e2eToken = (() => {
  const header = JSON.stringify({ alg: "HS256", typ: "JWT" });
  const payload = JSON.stringify({ sub: "e2e", exp: 4102444800 });
  const encodedHeader = Buffer.from(header).toString("base64url");
  const encodedPayload = Buffer.from(payload).toString("base64url");
  return `${encodedHeader}.${encodedPayload}.e2e`;
})();

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
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
        API_KEYS: e2eToken,
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
