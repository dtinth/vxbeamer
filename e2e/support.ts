import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { PlaywrightStoryboard } from "visual-storyboard/integrations/playwright";
import { createAccessToken } from "../apps/backend/src/auth.ts";
import { OIDC_SECRET } from "./testConfig.ts";

export const storyboard = new PlaywrightStoryboard({ test }).install();

/**
 * Signs the page in as a brand-new subject that has never been used before —
 * this test's own private message log on the backend, guaranteed empty.
 *
 * The backend keeps one in-memory message log per subject for the life of
 * the whole test run (`apps/backend/src/store.ts`), with no reset between
 * tests or spec files. An earlier version of this suite had every test sign
 * in as the same fixed subject (`"e2e"`) and rely on a *relative*
 * `.message-card` count (see `startRecordingAndGetItsCard` below) to work
 * around the shared history — but the frontend's "connected" indicator
 * (`[title="connected"]`) is set on the `EventSource`'s `open` event, which
 * fires before the initial `snapshot` SSE message — the one carrying the
 * subject's whole prior history — is necessarily received and applied
 * (`apps/website/src/App.tsx`, `apps/website/src/store.ts`). A test that
 * reads its "before" card count immediately after seeing "connected" can
 * therefore read a lower count than reality, with the rest of that history
 * still about to render. That race is easy to miss on a fast local machine
 * (the snapshot usually wins) but was exactly what broke two specs on GitHub
 * Actions' runners once tests actually ran back-to-back in CI (see
 * dtinth/vxbeamer run 35265282312, `.message-card` counts observed at 3 and
 * 5 where a test expected 1).
 *
 * Minting a private, never-reused subject for every test removes the shared
 * history entirely, so there is nothing to race against: this subject's true
 * message count is always 0 before this test's own first card is created,
 * however slow the snapshot is to arrive. The token is signed directly with
 * the backend's `OIDC_SECRET`, bypassing the `/auth/token` API-key exchange
 * — that exchange is deliberately exercised end to end by its own dedicated
 * test in `recording.spec.ts` instead, which is the one test that keeps
 * using the shared `"e2e"` subject (safe, since nothing else touches it).
 */
export async function signInAsFreshSubject(page: Page, backendUrl: string): Promise<void> {
  const subject = `e2e-${randomUUID()}`;
  const accessToken = await createAccessToken({
    subject,
    secret: OIDC_SECRET,
    ttlSeconds: 900,
  });
  await page.goto("/");
  await page.evaluate(
    ({ backendUrl, accessToken }) => {
      localStorage.setItem("vxbeamer_backend_url", backendUrl);
      localStorage.setItem("vxbeamer_access_token", accessToken);
      // Dummy refresh token for testing (won't actually refresh during e2e)
      localStorage.setItem("vxbeamer_refresh_token", "dummy-refresh-token");
    },
    { backendUrl, accessToken },
  );
  await page.reload();
  await expect(page.locator('[title="connected"]')).toBeVisible({ timeout: 10_000 });
}

/**
 * Starts a fresh recording and returns a locator scoped to *its own* card, by
 * the bubble's own `data-message-id` rather than DOM position.
 *
 * Every caller signs in via `signInAsFreshSubject` (or, for the one test that
 * deliberately doesn't, a subject nothing else touches), so `before` is
 * always the true pre-existing count for this test's own private history —
 * not a positional guess. That still matters even with an empty history: a
 * position-based `.last()` right after triggering a recording could
 * otherwise match a not-yet-unmounted stale element before the new card has
 * mounted, and `.last()` stays positional for every assertion after, not
 * just at start time. Pinning to the id it was assigned the moment it
 * appeared removes that ambiguity for the rest of the test.
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
