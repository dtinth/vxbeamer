/**
 * Runs one model configuration against an audio file and prints what it heard.
 *
 * The point is a fast loop for checking a newly wired adapter: no server, no
 * browser, no microphone. Configurations resolve through the catalogue, so every
 * newly declared one is testable here for free.
 */
import { readFileSync } from "node:fs";
import { BYTES_PER_SECOND, readPcm } from "./audio.ts";
import { createDefaultConfigurationCatalogue } from "./builtin.ts";
import type { UsageRecord } from "./asr.ts";

/** 100 ms of audio — the packet size vendors ask for. */
const CHUNK_SIZE = BYTES_PER_SECOND / 10;

const USAGE = `Usage: vxasr <configuration-id> <audio-file> [options]
       vxasr --list

Runs one ASR model configuration against an audio file and prints the transcript.

Audio must be a WAV or headerless raw PCM at 16 kHz / 16-bit / mono — the format
the app captures. WAV is detected by content, and its header is stripped.

Options:
  --list              List configurations and whether credentials are present
  --fast              Send audio as fast as the socket accepts it, instead of
                      pacing at realtime. NOT equivalent to a live recording:
                      BytePlus hangs outright under a fast dump, and vendors ask
                      for 100-200 ms send intervals. Billing is per audio-second,
                      so realtime costs no more. Use only to probe this.
  --quiet             Print only the final transcript
  -h, --help          Show this help

Credentials come from the environment. To use a .env file:
  node --env-file=.env ... vxasr <configuration-id> <audio-file>

Exits non-zero if the configuration is unknown, lacks credentials, or errors.`;

function listConfigurations(): number {
  const catalogue = createDefaultConfigurationCatalogue();
  for (const definition of catalogue.list()) {
    const missing = definition.missingConfig(process.env);
    const status = missing.length === 0 ? "ready" : `needs ${missing.join(", ")}`;
    console.log(`${definition.id}\n    ${definition.label}\n    ${status}`);
  }
  return 0;
}

async function transcribe(
  configurationId: string,
  audioPath: string,
  options: { fast: boolean; quiet: boolean },
): Promise<number> {
  const catalogue = createDefaultConfigurationCatalogue();
  const resolution = catalogue.resolve(process.env, configurationId);

  if (!resolution.ok) {
    console.error(`error: ${resolution.error.message}`);
    if (resolution.error.code === "unknown_configuration") {
      console.error(`\nKnown configurations:\n  ${catalogue.ids.join("\n  ")}`);
    } else if (resolution.error.missing?.length) {
      console.error(`\nSet: ${resolution.error.missing.join(", ")}`);
    }
    return 1;
  }

  let audio;
  try {
    audio = readPcm(readFileSync(audioPath));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (!options.quiet) {
    console.error(
      `${configurationId} — ${audio.seconds.toFixed(2)}s of audio (${audio.source})` +
        `, ${options.fast ? "fast dump" : "realtime"}`,
    );
  }

  const started = Date.now();
  let usage: UsageRecord[] = [];
  let partials = 0;

  const outcome = await new Promise<{ ok: true; text: string } | { ok: false; error: Error }>(
    (resolve) => {
      let text = "";
      const session = resolution.provider.createSession({
        onPartial(partial) {
          partials++;
          if (!options.quiet && process.stderr.isTTY) {
            process.stderr.write(`\r\x1b[2K… ${partial.slice(-100)}`);
          }
        },
        onFinal(final) {
          text = final;
        },
        onUsage(records) {
          // Each layer of a decorated chain reports separately: a raw provider's
          // seconds and its decorator's tokens are both real costs.
          usage = [...usage, ...records];
        },
        onEnd() {
          resolve({ ok: true, text });
        },
        onError(error) {
          resolve({ ok: false, error });
        },
      });

      void (async () => {
        for (let offset = 0; offset < audio.pcm.length; offset += CHUNK_SIZE) {
          session.sendAudio(audio.pcm.subarray(offset, offset + CHUNK_SIZE));
          if (!options.fast) await new Promise((r) => setTimeout(r, 100));
        }
        session.finish();
      })();
    },
  );

  if (!options.quiet && process.stderr.isTTY) process.stderr.write("\r\x1b[2K");

  if (!outcome.ok) {
    console.error(`error: ${outcome.error.message}`);
    return 1;
  }

  console.log(outcome.text);

  if (!options.quiet) {
    const elapsed = (Date.now() - started) / 1000;
    console.error(`\n${partials} partials in ${elapsed.toFixed(2)}s`);
    if (usage.length > 0) {
      let total = 0;
      for (const record of usage) {
        const cost = record.unitPrice * record.quantity;
        total += cost;
        console.error(
          `  ${record.sku}: ${record.quantity} × $${record.unitPrice} = $${cost.toFixed(6)}`,
        );
      }
      console.error(`  total: $${total.toFixed(6)}`);
    }
  }

  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return args.length === 0 ? 1 : 0;
  }
  if (args.includes("--list")) return listConfigurations();

  const fast = args.includes("--fast");
  const quiet = args.includes("--quiet");
  const positional = args.filter((arg) => !arg.startsWith("-"));

  if (positional.length !== 2) {
    console.error("error: expected a configuration id and an audio file\n");
    console.error(USAGE);
    return 1;
  }

  return transcribe(positional[0]!, positional[1]!, { fast, quiet });
}

process.exitCode = await main(process.argv.slice(2));
