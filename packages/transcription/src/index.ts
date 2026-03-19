import { createQwenProvider } from "vxasr";

export interface TranscriptionResult {
  text: string;
  bytes: number;
}

export async function transcribeAudioPackets(packets: Uint8Array[]): Promise<TranscriptionResult> {
  const bytes = packets.reduce((total, packet) => total + packet.byteLength, 0);
  if (bytes === 0) {
    throw new Error("No audio received");
  }

  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error("DASHSCOPE_API_KEY not configured");
  }

  const provider = createQwenProvider({ apiKey });

  return new Promise((resolve, reject) => {
    let finalText = "";

    const session = provider.createSession({
      onFinal(text) {
        finalText = text;
      },
      onEnd() {
        resolve({ text: finalText, bytes });
      },
      onError(err) {
        reject(err);
      },
    });

    for (const packet of packets) {
      session.sendAudio(Buffer.from(packet));
    }
    session.finish();
  });
}
