/**
 * Realtime microphone transcription
 * Usage: vp exec tsx src/transcribe.ts <configuration>
 *
 * Requires: rec (sox)
 * Env vars: DASHSCOPE_API_KEY (qwen), BYTEPLUS_API_KEY (byteplus), GROQ_API_KEY (+groq)
 */

import { spawn } from "child_process";
import { createDefaultConfigurationCatalogue } from "./builtin.ts";

const catalogue = createDefaultConfigurationCatalogue();
const configurationId = process.argv[2];

if (!configurationId || !catalogue.get(configurationId)) {
  console.error("Usage: transcribe.ts <configuration>\n\nConfigurations:");
  for (const configuration of catalogue.list()) {
    console.error(`  ${configuration.id}\n    ${configuration.label}`);
  }
  process.exit(1);
}

const resolution = catalogue.resolve(process.env, configurationId);
if (!resolution.ok) {
  const missing = resolution.error.missing ?? [];
  console.error(
    missing.length > 0
      ? `Error: ${missing.join(", ")} is not set.`
      : `Error: ${resolution.error.message}`,
  );
  process.exit(1);
}

const provider = resolution.provider;

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
process.stdout.write(`[Session] Using ${configurationId}. Speak — Ctrl+C to stop.\n\n`);

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
