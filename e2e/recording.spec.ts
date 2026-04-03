import { test, expect } from "@playwright/test";
import { storyboard } from "./support.ts";

const BACKEND_URL = "http://localhost:8788";
const E2E_API_KEY = "e2e-test-api-key";

test.beforeEach(async ({ page }) => {
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
  // --- Signed-out state ---
  await page.goto("/");

  const settingsButton = page.getByRole("button", { name: "Settings", exact: true });
  await settingsButton.click();

  // Fill in the backend URL so it matches the signed-in state
  const backendUrlInput = page.getByRole("textbox");
  await backendUrlInput.fill(BACKEND_URL);

  const signInButton = page.getByRole("button", { name: "Sign in with OIDC" });
  await expect(signInButton).toBeVisible();
  await storyboard.capture("Settings - signed out", signInButton);

  // Close settings
  await page.locator(".fixed.inset-0").click({ position: { x: 0, y: 0 } });

  // --- Exchange API key for access token ---
  const tokenRes = await page.request.post(`${BACKEND_URL}/auth/token`, {
    data: { api_key: E2E_API_KEY },
  });
  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
  };

  // --- Inject tokens and reload to signed-in state ---
  await page.evaluate(
    ({ backendUrl, accessToken }) => {
      localStorage.setItem("vxbeamer_backend_url", backendUrl);
      localStorage.setItem("vxbeamer_access_token", accessToken);
      // Dummy refresh token for testing (won't actually refresh during e2e)
      localStorage.setItem("vxbeamer_refresh_token", "dummy-refresh-token");
    },
    { backendUrl: BACKEND_URL, accessToken: tokenData.access_token },
  );
  await page.reload();

  // Wait for SSE connection (green dot)
  const connectedDot = page.locator('[title="connected"]');
  await expect(connectedDot).toBeVisible({ timeout: 10_000 });

  // Show settings again to see signed-in state
  await settingsButton.click();
  const signOutButton = page.getByRole("button", { name: "Sign out" });
  await expect(signOutButton).toBeVisible();
  await storyboard.capture("Settings - signed in", signOutButton);

  // Close settings
  await page.locator(".fixed.inset-0").click({ position: { x: 0, y: 0 } });
  await expect(signOutButton).not.toBeVisible();

  await storyboard.capture("Connected to backend", connectedDot);

  // Start recording
  const recordButton = page.getByLabel("Start recording");
  await storyboard.capture("Ready to record", recordButton);
  await recordButton.click();

  // Wait for partial transcript to appear
  const partialText = page.getByText("Good morning");
  await expect(partialText).toBeVisible({ timeout: 10_000 });
  await storyboard.capture("Receiving transcript", partialText);

  // Stop recording
  const stopButton = page.getByLabel("Stop recording");
  await storyboard.capture("About to stop recording", stopButton);
  await stopButton.click();

  // Wait for the final transcript (message transitions to done status)
  const finalText = page.getByText("quarterly results and our plans for the next quarter");
  await expect(finalText).toBeVisible({ timeout: 10_000 });
  await storyboard.capture("Final transcript displayed", finalText);
});
