import { expect, test, vi } from "vite-plus/test";
import { withGroqEnhancement } from "../src/providers/groq-enhancement.ts";

const createCompletion = vi.fn();

vi.mock("groq-sdk", () => ({
  default: class Groq {
    chat = {
      completions: {
        create: createCompletion,
      },
    };
  },
}));

test("Groq enhancement prompt requests plain text output", async () => {
  createCompletion.mockResolvedValueOnce(
    (async function* () {
      yield {
        choices: [{ delta: { content: "<vx-transcription>Clean output</vx-transcription>" } }],
      };
    })(),
  );

  const provider = withGroqEnhancement(
    {
      createSession(callbacks) {
        return {
          sendAudio(_chunk) {},
          finish() {
            callbacks.onFinal?.("Raw transcript");
            callbacks.onEnd?.();
          },
        };
      },
    },
    { apiKey: "test" },
  );

  await new Promise<void>((resolve, reject) => {
    const session = provider.createSession({
      onEnd: resolve,
      onError: reject,
    });
    session.finish();
  });

  expect(createCompletion).toHaveBeenCalledTimes(1);
  expect(createCompletion.mock.calls[0]?.[0]).toMatchObject({
    messages: [
      {
        role: "user",
        content: expect.stringContaining("Output plain text only, not Markdown"),
      },
    ],
  });
  expect(createCompletion.mock.calls[0]?.[0]?.messages?.[0]?.content).toContain(
    "do not use double asterisks for emphasis",
  );
});
