import type { ASRProvider, ASRSession, ASRSessionCallbacks } from "../asr.ts";

const MOCK_TRANSCRIPT =
  "Good morning everyone. Today we'll be discussing the quarterly results and our plans for the next quarter.";

const MOCK_PARTIALS = [
  "Good morning",
  "Good morning everyone.",
  "Good morning everyone. Today we'll be",
  "Good morning everyone. Today we'll be discussing the quarterly",
  "Good morning everyone. Today we'll be discussing the quarterly results and our plans",
];

export function createMockProvider(): ASRProvider {
  return {
    createSession(callbacks: ASRSessionCallbacks): ASRSession {
      let chunkCount = 0;

      return {
        sendAudio(_chunk: Buffer): void {
          const partial = MOCK_PARTIALS[Math.min(chunkCount, MOCK_PARTIALS.length - 1)];
          chunkCount++;
          callbacks.onPartial?.(partial!);
        },
        finish(): void {
          callbacks.onFinal?.(MOCK_TRANSCRIPT);
          callbacks.onEnd?.();
        },
      };
    },
  };
}
