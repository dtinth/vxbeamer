/**
 * Realtime microphone transcription
 * Usage: vp exec tsx src/transcribe.ts <provider> [--model <id>] [--enhance]
 *
 * Requires: rec (sox)
 * Env vars: DASHSCOPE_API_KEY (qwen), BYTEPLUS_API_KEY (byteplus)
 */

import { spawn } from "child_process";
import { createDefaultProviderRegistry } from "./providers/builtin.ts";
import { withGroqEnhancement } from "./providers/groq-enhancement.ts";
import type { ASRProvider } from "./asr.ts";

const registry = createDefaultProviderRegistry();
const providerName = process.argv[2];
const modelFlagIndex = process.argv.indexOf("--model");
const model = modelFlagIndex === -1 ? undefined : process.argv[modelFlagIndex + 1];

if (!providerName || !registry.get(providerName)) {
  console.error(`Usage: transcribe.ts <${registry.ids.join("|")}> [--model <id>] [--enhance]`);
  process.exit(1);
}

const resolution = registry.resolve(process.env, { provider: providerName, model });
if (!resolution.ok) {
  const missing = resolution.error.missing ?? [];
  console.error(
    missing.length > 0
      ? `Error: ${missing.join(", ")} is not set.`
      : `Error: ${resolution.error.message}`,
  );
  process.exit(1);
}

let provider: ASRProvider = resolution.provider;

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
  `[Session] Using ${providerName} (${resolution.model})${process.argv.includes("--enhance") ? " + groq" : ""}. Speak — Ctrl+C to stop.\n\n`,
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
