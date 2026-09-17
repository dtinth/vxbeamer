import { test, expect } from "@playwright/test";
import { signInAsFreshSubject, startRecordingAndGetItsCard } from "./support.ts";

const BACKEND_URL = "http://localhost:8788";

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

  // Each test signs in as its own private, never-reused subject (see
  // signInAsFreshSubject's doc in support.ts) rather than sharing one across
  // every test in this file, so no test ever inherits another's leftover
  // message-cards regardless of run order.
  await signInAsFreshSubject(page, BACKEND_URL);
});

test("`r` toggles recording the same as clicking the button", async ({ page }) => {
  const card = await startRecordingAndGetItsCard(page, () => page.keyboard.press("r"));
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

  const card = await startRecordingAndGetItsCard(page, () => page.keyboard.press("r"));
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

  const card = await startRecordingAndGetItsCard(page, () => page.keyboard.down("Space"));
  await expect(page.getByLabel("Stop recording")).toBeVisible({ timeout: 10_000 });
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
