import { test, expect, type Page } from "@playwright/test";

const BACKEND_URL = "http://localhost:8788";
const E2E_API_KEY = "e2e-test-api-key";

test.beforeEach(async ({ page }) => {
  // Same fake getUserMedia as recording.spec.ts, so a keyboard-triggered
  // start actually produces audio chunks for the mock ASR to transcribe.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext({ sampleRate: 16000 });
      const oscillator = ctx.createOscillator();
      oscillator.frequency.value = 440;
      const dest = ctx.createMediaStreamDestination();
      oscillator.connect(dest);
      oscillator.start();
      await ctx.resume();
      return dest.stream;
    };
  });

  const tokenRes = await page.request.post(`${BACKEND_URL}/auth/token`, {
    data: { api_key: E2E_API_KEY },
  });
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

  await page.goto("/");
  await page.evaluate(
    ({ backendUrl, token }) => {
      localStorage.setItem("vxbeamer_backend_url", backendUrl);
      localStorage.setItem("vxbeamer_access_token", token);
      localStorage.setItem("vxbeamer_refresh_token", "dummy-refresh-token");
    },
    { backendUrl: BACKEND_URL, token: accessToken },
  );
  await page.reload();
  await expect(page.locator('[title="connected"]')).toBeVisible({ timeout: 10_000 });
});

/**
 * Starts a fresh recording via `r` and returns a locator scoped to *its own*
 * card, by the bubble's own `data-message-id` rather than DOM position.
 *
 * The backend keeps one in-memory log per subject, and every test here signs
 * in as the same one (like recording.spec.ts) — so an earlier test's already-
 * finished card, whose permanent text is the same canned "Good morning…"
 * transcript, can still be on screen. A position-based `.last()` right after
 * pressing `r` can match *that* old card instead of the new recording, since
 * the new one may not have mounted yet — waiting for the card count to grow
 * fixes that at start time, but `.last()` stays positional for every
 * assertion after, including ones evaluated well after the new card exists.
 * Pinning to the id it was assigned the moment it appeared removes that
 * ambiguity for the rest of the test, however many cards end up on screen.
 */
async function startRecordingAndGetItsCard(page: Page) {
  const before = await page.locator(".message-card").count();
  await page.keyboard.press("r");
  await expect(page.locator(".message-card")).toHaveCount(before + 1, { timeout: 10_000 });
  const messageId = await page.locator("[data-message-id]").last().getAttribute("data-message-id");
  return page.locator(`[data-message-id="${messageId}"]`);
}

test("`r` toggles recording the same as clicking the button", async ({ page }) => {
  const card = await startRecordingAndGetItsCard(page);
  await expect(page.getByLabel("Stop recording")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText("Good morning")).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("r");
  await expect(page.getByLabel("Start recording")).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText("quarterly results and our plans for the next quarter")).toBeVisible({
    timeout: 10_000,
  });
});

test("`c` copies the latest finished transcript, same as clicking its bubble", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const card = await startRecordingAndGetItsCard(page);
  await expect(card.getByText("Good morning")).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("r");
  await expect(card.getByText("quarterly results and our plans for the next quarter")).toBeVisible({
    timeout: 10_000,
  });

  await page.keyboard.press("c");
  await expect(card.getByText("Copied")).toBeVisible({ timeout: 5_000 });

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain("quarterly results and our plans for the next quarter");
});

test("holding Space is push-to-talk: starts on press, stops and auto-copies on release", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const before = await page.locator(".message-card").count();
  await page.keyboard.down("Space");
  await expect(page.getByLabel("Stop recording")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".message-card")).toHaveCount(before + 1, { timeout: 10_000 });
  // Pinned by id, not DOM position — see startRecordingAndGetItsCard's doc.
  const messageId = await page.locator("[data-message-id]").last().getAttribute("data-message-id");
  const card = page.locator(`[data-message-id="${messageId}"]`);
  await expect(card.getByText("Good morning")).toBeVisible({ timeout: 10_000 });

  await page.keyboard.up("Space");
  await expect(page.getByLabel("Start recording")).toBeVisible({ timeout: 10_000 });

  // No `c` press here — the copy is meant to happen on its own once the
  // transcript finalizes.
  await expect(card.getByText("Copied")).toBeVisible({ timeout: 10_000 });
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain("quarterly results and our plans for the next quarter");
});

test("shortcuts are suppressed while typing in a text field", async ({ page }) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const backendUrlInput = page.getByRole("textbox");
  await backendUrlInput.fill("r c");

  // `r`/`c` typed into the field must not have toggled recording or copied
  // anything — they should have landed as plain text instead.
  await expect(page.getByLabel("Stop recording")).not.toBeVisible();
  await expect(backendUrlInput).toHaveValue("r c");
});
