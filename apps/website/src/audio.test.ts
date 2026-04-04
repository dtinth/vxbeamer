import { expect, test } from "vite-plus/test";
import { getMicrophoneAudioConstraints } from "./audio.ts";

test("enables standard WebRTC audio processing when audio processing is on", () => {
  expect(getMicrophoneAudioConstraints("on")).toEqual({
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  });
});

test("disables WebRTC audio processing when audio processing is off", () => {
  expect(getMicrophoneAudioConstraints("off")).toEqual({
    noiseSuppression: false,
    echoCancellation: false,
    autoGainControl: false,
  });
});
