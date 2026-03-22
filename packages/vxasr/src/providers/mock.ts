import type { ASRProvider, ASRSession, ASRSessionCallbacks } from "../asr.ts";

export function createMockProvider(): ASRProvider {
  return {
    createSession(callbacks: ASRSessionCallbacks): ASRSession {
      let totalBytes = 0;

      return {
        sendAudio(chunk: Buffer): void {
          totalBytes += chunk.byteLength;
          callbacks.onPartial?.(`received ${totalBytes} bytes of audio`);
        },
        finish(): void {
          callbacks.onFinal?.(`received ${totalBytes} bytes of audio`);
          callbacks.onEnd?.();
        },
      };
    },
  };
}
