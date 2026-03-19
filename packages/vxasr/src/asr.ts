export interface ASRSessionCallbacks {
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

export interface ASRSession {
  sendAudio(chunk: Buffer): void;
  finish(): void;
}

export interface ASRProvider {
  createSession(callbacks: ASRSessionCallbacks): ASRSession;
}
