import { expect, test } from "vite-plus/test";
import { transcribeAudioPackets } from "../src/index";

test("transcribeAudioPackets returns a transcript summary", async () => {
  const result = await transcribeAudioPackets([new Uint8Array(16_000)]);
  expect(result.text).toContain("Transcription ready");
  expect(result.bytes).toBe(16_000);
});

test("transcribeAudioPackets rejects empty input", async () => {
  await expect(transcribeAudioPackets([])).rejects.toThrow("No audio received");
});
