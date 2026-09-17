import { test, expect, type Page } from "@playwright/test";
import { PlaywrightStoryboard } from "visual-storyboard/integrations/playwright";

export const storyboard = new PlaywrightStoryboard({ test }).install();

/**
 * Starts a fresh recording and returns a locator scoped to *its own* card, by
 * the bubble's own `data-message-id` rather than DOM position.
 *
 * The backend keeps one in-memory message log per subject
 * (`apps/backend/src/store.ts`), and every e2e test across every spec file
 * signs in as the same one — so an earlier test's already-finished card,
 * whose permanent text is the same canned "Good morning…" transcript, can
 * still be on screen (the SSE snapshot a fresh page loads on connect replays
 * the whole subject's history, not just this test's slice of it). A
 * position-based `.last()` right after triggering a recording can match
 * *that* old card instead of the new one, since the new one may not have
 * mounted yet — waiting for the card count to grow fixes that at start time,
 * but `.last()` stays positional for every assertion after, including ones
 * evaluated well after the new card exists. Pinning to the id it was
 * assigned the moment it appeared removes that ambiguity for the rest of the
 * test, however many cards end up on screen.
 *
 * `trigger` is whatever action starts the recording (click the button, press
 * `r`, hold Space, …) — the scoping logic is the same regardless.
 */
export async function startRecordingAndGetItsCard(page: Page, trigger: () => Promise<void>) {
  const before = await page.locator(".message-card").count();
  await trigger();
  await expect(page.locator(".message-card")).toHaveCount(before + 1, { timeout: 10_000 });
  const messageId = await page.locator("[data-message-id]").last().getAttribute("data-message-id");
  return page.locator(`[data-message-id="${messageId}"]`);
}
