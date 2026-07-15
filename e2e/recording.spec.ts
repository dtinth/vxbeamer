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
      await ctx.resume();
      // Heads-up for anyone asserting on clip length: this fake yields audio far
      // slower than realtime. Measured in headless Chrome, a running context
      // delivers ~0.1 s of samples per 2 s of wall clock, so a recording held
      // open for 3 s retains ~0.15 s of PCM and the eval dialog reports a
      // fraction-of-a-second clip. It is a limit of a MediaStream with no audio
      // device behind it, not of retention — the same chunks feed the live
      // socket. Assert on behaviour here and leave the arithmetic to
      // `evalRun.test.ts`, which paces frames against a fake clock.
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

test("evaluates a finished recording against the configured model set", async ({ page }) => {
  // Catch the presigned PUTs in the browser: the signing is real, the bucket is
  // not, and nothing leaves this machine.
  const uploads: { key: string; body: unknown }[] = [];
  await page.route("**/e2e-eval/**", async (route) => {
    const request = route.request();
    uploads.push({
      key: new URL(request.url()).pathname,
      body: JSON.parse(request.postData() ?? "null") as unknown,
    });
    await route.fulfill({ status: 200, body: "" });
  });

  // --- Sign in and record, so there is a retained clip to replay ---
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

  // The backend keeps one in-memory log per subject and both tests sign in as
  // the same one, so an earlier test's message may still be on screen. Work
  // against the newest card rather than the whole feed — page-wide text is
  // ambiguous the moment a second card carries the same mock transcript.
  const card = page.locator(".message-card").last();

  await page.getByLabel("Start recording").click();
  await expect(card.getByText("Good morning")).toBeVisible({ timeout: 10_000 });
  // Hold the recording open long enough to retain a clip worth replaying: the
  // eval replays at 1x, so the clip's length is the run's length, and a
  // 40-millisecond clip would never show the progress bar moving.
  await page.waitForTimeout(3000);
  await page.getByLabel("Stop recording").click();

  await expect(card.getByText("quarterly results and our plans")).toBeVisible({ timeout: 10_000 });

  // --- Eval is offered only where the audio is still in memory ---
  const evalButton = card.getByRole("button", {
    name: "Eval this recording against other configurations",
  });
  await expect(evalButton).toBeVisible();
  await storyboard.capture("Eval offered on a finished message", evalButton);
  await evalButton.click();

  const dialog = page.getByRole("dialog", { name: "Eval" });
  await expect(dialog).toBeVisible();

  // The clip replays at 1x, so this is the clip's own length however many rows
  // there are — the bar tracks the audio, not the models.
  await expect(dialog.getByRole("progressbar")).toBeVisible();
  await storyboard.capture("Replaying the clip against every configuration", dialog);

  // The rows do not behave alike, and all of it must be legible at once: mock
  // streams, and the uncredentialled configurations say so rather than hiding.
  await expect(dialog.getByText("Not set up").first()).toBeVisible();
  await expect(dialog.getByText("BytePlus Seed-ASR (raw)")).toBeVisible();

  const winnerRow = dialog.getByRole("button", { name: /Mock/ });
  await expect(winnerRow).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText("Pick the transcript you like")).toBeVisible();
  await storyboard.capture("Eval results, ready to pick a winner", dialog);

  // Offered before the pick, because the pick is what commits it.
  const saveForEval = dialog.getByRole("checkbox", { name: /Save this clip for eval/ });
  await saveForEval.check();
  await storyboard.capture("Save-for-eval ticked, before choosing a winner", saveForEval);

  await winnerRow.click();

  // The winner replaces the message's answer, and the dialog gets out of the way.
  await expect(dialog).not.toBeVisible({ timeout: 10_000 });
  await expect(card.getByText("quarterly results and our plans")).toBeVisible();
  await storyboard.capture("Winner applied to the message", page);

  // --- The pick reaches storage ---
  await expect.poll(() => uploads.length, { timeout: 10_000 }).toBe(2);

  // The vote goes out on every pick and carries the whole ballot, so a win can
  // be read as a rate rather than a bare count. It must carry no transcript.
  const vote = uploads.find((u) => u.key.includes("vote"))!.body as {
    type: string;
    winner: { configurationId: string };
    candidates: { configurationId: string; transcript?: string }[];
    savedForEval: boolean;
  };
  expect(vote.type).toBe("vote");
  expect(vote.winner.configurationId).toBe("mock/mock");
  expect(vote.savedForEval).toBe(true);
  // Every configuration on the ballot, not just the winner — including one
  // that never ran, so a win is a rate rather than a count.
  expect(vote.candidates.map((c) => c.configurationId)).toContain("byteplus/bigmodel_nostream");
  expect(vote.candidates.some((c) => c.transcript !== undefined)).toBe(false);

  // The eval-set went only because save-for-eval was ticked, and it is the one
  // that carries the audio and the transcripts.
  const evalSet = uploads.find((u) => u.key.includes("eval-set"))!.body as {
    type: string;
    audio: { data: string; encoding: string };
    candidates: { transcript?: string }[];
  };
  expect(evalSet.type).toBe("eval-set");
  expect(evalSet.audio.encoding).toBe("wav");
  expect(evalSet.audio.data.length).toBeGreaterThan(0);
  expect(evalSet.candidates.some((c) => c.transcript?.includes("quarterly results"))).toBe(true);
});
