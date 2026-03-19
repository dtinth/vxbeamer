/**
 * Realtime microphone transcription
 * Usage: vp exec tsx src/transcribe.ts <qwen|byteplus>
 *
 * Requires: rec (sox)
 * Env vars: DASHSCOPE_API_KEY (qwen), BYTEPLUS_API_KEY (byteplus)
 */

import { spawn } from "child_process";
import { createQwenProvider } from "./providers/qwen.ts";
import { createBytePlusProvider } from "./providers/byteplus.ts";
import { withGroqEnhancement } from "./providers/groq-enhancement.ts";
import type { ASRProvider } from "./asr.ts";

const providerName = process.argv[2];

let provider: ASRProvider;
if (providerName === "qwen") {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    console.error("Error: DASHSCOPE_API_KEY is not set.");
    process.exit(1);
  }
  provider = createQwenProvider({ apiKey });
} else if (providerName === "byteplus") {
  const apiKey = process.env.BYTEPLUS_API_KEY;
  if (!apiKey) {
    console.error("Error: BYTEPLUS_API_KEY is not set.");
    process.exit(1);
  }
  provider = createBytePlusProvider({ apiKey });
} else {
  console.error("Usage: transcribe.ts <qwen|byteplus> [--enhance]");
  process.exit(1);
}

if (process.argv.includes("--enhance")) {
  if (!process.env.GROQ_API_KEY) {
    console.error("Error: GROQ_API_KEY is not set.");
    process.exit(1);
  }
  provider = withGroqEnhancement(provider, { apiKey: process.env.GROQ_API_KEY });
}

// ===== Display =====
// Keep finalized lines and re-render from top on every update,
// so multi-line partial text doesn't leave stale lines behind.

const finalLines: string[] = [];
let partialText = "";

function render() {
  process.stdout.write("\x1b[H\x1b[J"); // cursor home + erase to end of screen
  for (const line of finalLines) process.stdout.write(line + "\n");
  if (partialText) process.stdout.write(partialText);
}

// Clear screen on start
process.stdout.write("\x1b[2J\x1b[H");
process.stdout.write(
  `[Session] Using ${providerName}${process.argv.includes("--enhance") ? " + groq" : ""}. Speak — Ctrl+C to stop.\n\n`,
);

const session = provider.createSession({
  onPartial(text) {
    partialText = text;
    render();
  },
  onFinal(text) {
    partialText = "";
    if (text.trim()) finalLines.push(text);
    render();
  },
  onEnd() {
    partialText = "";
    render();
    process.stdout.write("\n[Session] Finished.\n");
    process.exit(0);
  },
  onError(err) {
    partialText = "";
    render();
    process.stderr.write(`\n[Error] ${err.message}\n`);
    process.exit(1);
  },
});

const rec = spawn("rec", [
  "-b",
  "16",
  "-c",
  "1",
  "-t",
  "raw",
  "-e",
  "signed-integer",
  "-",
  "rate",
  "16000",
]);
rec.stderr?.on("data", () => {});
rec.stdout?.on("data", (chunk: Buffer) => session.sendAudio(chunk));
rec.on("error", (err) => {
  console.error("[rec error]", err.message);
  process.exit(1);
});

function finish() {
  rec.kill();
  session.finish();
}

process.on("SIGINT", finish);
process.on("SIGTERM", finish);
