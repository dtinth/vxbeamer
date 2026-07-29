import { afterEach } from "vite-plus/test";
import type { ASRProvider, UsageRecord } from "../src/index.ts";

/**
 * Shared by every streaming-provider test file (qwen-omni, openai, ...): each
 * has its own `FakeVendor` encoding a different wire protocol, but driving a
 * session to completion and cleaning up the fake server afterwards is the
 * same shape everywhere. Duplicating it per file was the second copy — see
 * dtinth/vxbeamer#86.
 */

export interface RunOutcome {
  text: string;
  partials: string[];
  usage: UsageRecord[];
  error?: Error;
}

/** Drives one session to completion, as the CLI and the eval do. */
export function run(provider: ASRProvider, audio: Buffer): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const partials: string[] = [];
    let usage: UsageRecord[] = [];
    let text = "";
    const session = provider.createSession({
      onPartial: (partial) => partials.push(partial),
      onFinal: (final) => (text = final),
      onUsage: (records) => (usage = [...usage, ...records]),
      onEnd: () => resolve({ text, partials, usage }),
      onError: (error) => resolve({ text, partials, usage, error }),
    });
    for (let offset = 0; offset < audio.length; offset += 3200) {
      session.sendAudio(audio.subarray(offset, offset + 3200));
    }
    session.finish();
  });
}

/**
 * Tracks fake-vendor servers started during a test file's run and closes them
 * all in `afterEach`, so a test that forgets to close its own server does not
 * leak a listening socket into the next one. Call once per test file, at
 * module scope.
 */
export function trackVendors<T extends { close(): Promise<void> }>(): {
  withVendor(start: () => Promise<T>): Promise<T>;
} {
  const vendors: T[] = [];

  afterEach(async () => {
    await Promise.all(vendors.splice(0).map((vendor) => vendor.close()));
  });

  return {
    async withVendor(start) {
      const vendor = await start();
      vendors.push(vendor);
      return vendor;
    },
  };
}
