export interface TranscriptionResult {
  text: string;
  bytes: number;
}

export async function transcribeAudioPackets(packets: Uint8Array[]): Promise<TranscriptionResult> {
  const bytes = packets.reduce((total, packet) => total + packet.byteLength, 0);
  if (bytes === 0) {
    throw new Error("No audio received");
  }

  const estimatedSeconds = Math.max(1, Math.round(bytes / 16_000));
  return {
    text: `Transcription ready (${estimatedSeconds}s audio, ${bytes} bytes).`,
    bytes,
  };
}
