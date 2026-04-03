import { expect, test, vi } from "vite-plus/test";
import { transcribeAudioPackets } from "../src/index";

vi.mock("vxasr", () => ({
  createQwenProvider: () => ({
    createSession: ({
      onFinal,
      onEnd,
    }: {
      onFinal?: (text: string) => void;
      onEnd?: () => void;
    }) => ({
      sendAudio() {},
      finish() {
        onFinal?.("Transcription ready");
        onEnd?.();
      },
    }),
  }),
}));

test("transcribeAudioPackets returns a transcript summary", async () => {
  process.env.DASHSCOPE_API_KEY = "test-key";
  const result = await transcribeAudioPackets([new Uint8Array(16_000)]);
  expect(result.text).toContain("Transcription ready");
  expect(result.bytes).toBe(16_000);
});

test("transcribeAudioPackets rejects empty input", async () => {
  await expect(transcribeAudioPackets([])).rejects.toThrow("No audio received");
});
