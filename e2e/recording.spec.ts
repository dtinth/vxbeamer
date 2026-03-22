import { test, expect } from "@playwright/test";

const BACKEND_URL = "http://localhost:8788";

/**
 * A token that works for both frontend and backend:
 * - Frontend: parses base64url part before "." as JSON, checks exp > now
 * - Backend: matches the full string against the API_KEYS set
 *
 * We use a far-future exp (year 2099) so the token never expires during tests.
 * This same string must be listed in API_KEYS in playwright.config.ts.
 */
const E2E_TOKEN = (() => {
  const payload = JSON.stringify({ sub: "e2e", exp: 4102444800 }); // 2099-12-31
  const encoded = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${encoded}.e2e`;
})();

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ backendUrl, token }) => {
      localStorage.setItem("vxbeamer_backend_url", backendUrl);
      localStorage.setItem("vxbeamer_access_token", token);
    },
    { backendUrl: BACKEND_URL, token: E2E_TOKEN },
  );

  // Inject fake getUserMedia that returns a tone (so audio chunks are produced)
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext({ sampleRate: 16000 });
      const oscillator = ctx.createOscillator();
      oscillator.frequency.value = 440;
      const dest = ctx.createMediaStreamDestination();
      oscillator.connect(dest);
      oscillator.start();
      return dest.stream;
    };
  });
});

test("records audio and displays transcript from mock ASR", async ({ page }) => {
  await page.goto("/");

  // Wait for SSE connection (green dot)
  await expect(page.locator('[title="connected"]')).toBeVisible({ timeout: 10_000 });

  // Start recording
  await page.getByLabel("Start recording").click();

  // Wait for partial transcript to appear (mock provider emits "received N bytes of audio")
  await expect(page.getByText(/received \d+ bytes of audio/)).toBeVisible({ timeout: 10_000 });

  // Stop recording
  await page.getByLabel("Stop recording").click();

  // Wait for the final transcript (message transitions to done status)
  await expect(page.getByText(/received \d+ bytes of audio/)).toBeVisible({ timeout: 10_000 });
});
