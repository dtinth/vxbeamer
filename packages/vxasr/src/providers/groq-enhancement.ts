import Groq from "groq-sdk";
import type { ASRProvider, ASRSession, ASRSessionCallbacks } from "../asr.ts";

export interface GroqEnhancementConfig {
  apiKey?: string;
  model?: string;
}

const PROMPT = (raw: string) =>
  `Format the following transcription given in <vx-raw-transcription></vx-raw-transcription> tags. ` +
  `Remove disfluencies like "um", "uh", "er", "ah", etc., unless they are important for meaning. ` +
  `Add new lines to separate paragraphs or speakers where appropriate. ` +
  `Use numbered lists as appropriate (if the speech explicitly indicates them).\n\n` +
  `<vx-raw-transcription>\n${raw}\n</vx-raw-transcription>\n\n` +
  `Present the result in <vx-transcription></vx-transcription> tags.`;

// Extract content inside <vx-transcription> from a partial or complete streamed string.
// Returns null if the opening tag hasn't arrived yet.
function extractTagContent(text: string): string | null {
  const open = "<vx-transcription>";
  const close = "</vx-transcription>";
  const start = text.indexOf(open);
  if (start === -1) return null;
  const contentStart = start + open.length;
  const end = text.indexOf(close, contentStart);
  return end === -1 ? text.slice(contentStart) : text.slice(contentStart, end);
}

export function withGroqEnhancement(
  provider: ASRProvider,
  config: GroqEnhancementConfig = {},
): ASRProvider {
  const groq = new Groq({ apiKey: config.apiKey });

  return {
    createSession(callbacks: ASRSessionCallbacks): ASRSession {
      // Queue ensures multiple finals are processed in order
      let queue = Promise.resolve();

      async function enhance(rawText: string) {
        // Immediately show raw text while Groq processes
        callbacks.onPartial?.(rawText);

        const stream = (await (groq.chat.completions.create as Function)({
          model: config.model ?? "openai/gpt-oss-120b",
          messages: [{ role: "user", content: PROMPT(rawText) }],
          temperature: 1,
          max_completion_tokens: 8192,
          reasoning_effort: "medium",
          stream: true,
        })) as AsyncIterable<{ choices: { delta: { content?: string } }[] }>;

        let accumulated = "";
        for await (const chunk of stream) {
          accumulated += chunk.choices[0]?.delta?.content ?? "";
          const content = extractTagContent(accumulated);
          if (content !== null) callbacks.onPartial?.(content.trim());
        }

        const final = (extractTagContent(accumulated) ?? rawText).trim();
        callbacks.onFinal?.(final);
      }

      const session = provider.createSession({
        onPartial: callbacks.onPartial,
        onFinal(text) {
          queue = queue.then(() => enhance(text)).catch((err) => callbacks.onError?.(err));
        },
        onEnd() {
          // Wait for all enhancements to finish before signalling end
          void queue.finally(() => callbacks.onEnd?.());
        },
        onError: callbacks.onError,
      });

      return session;
    },
  };
}
