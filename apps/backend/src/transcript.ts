import { normalizeThaiText } from "@thai/text-cleaner";

/**
 * Tidy a transcript before it reaches a client, whatever produced it.
 *
 * Applied unconditionally, to partials and finals alike, on every path that
 * hands a transcript out (live messages, the eval socket, a chosen eval
 * winner). `normalizeThaiText` fixes Thai Unicode encoding mistakes (a doubled
 * `เ` for `แ`, tone marks typed before the vowel) and touches only runs of Thai
 * script, so it is safe over mixed-language text and over a transcript in any
 * other language.
 */
export function normalizeTranscriptText(text: string): string {
  return normalizeThaiText(text)
    .replace(/[^\S\r\n]+$/gmu, "")
    .replace(/\s+$/u, "");
}
