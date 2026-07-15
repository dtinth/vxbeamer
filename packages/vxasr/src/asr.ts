export interface UsageRecord {
  sku: string;
  unitPrice: number;
  quantity: number;
}

export interface ASRSessionCallbacks {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
  onUsage?: (records: UsageRecord[]) => void;
}

export interface ASRSession {
  /**
   * Feed PCM (16 kHz, 16-bit signed, mono) **at roughly realtime pace**.
   *
   * These are realtime vendors, and pushing audio faster than it was recorded
   * is not a free speed-up: Qwen returns a different transcript, and BytePlus
   * hangs outright. A live microphone paces itself, but anything replaying
   * buffered audio — an eval run comparing configurations, say — must throttle
   * to about 1x. Billing is per audio-second, so pacing costs nothing.
   */
  sendAudio(chunk: Buffer): void;
  finish(): void;
}

export interface ASRProvider {
  createSession(callbacks: ASRSessionCallbacks): ASRSession;
}
