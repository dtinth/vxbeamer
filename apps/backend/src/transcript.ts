export function normalizeTranscriptText(text: string): string {
  return text.replace(/[^\S\r\n]+$/gmu, "").replace(/\s+$/u, "");
}
