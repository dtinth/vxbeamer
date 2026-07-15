import { expect, test } from "vite-plus/test";
import { createQwenProvider } from "../src/index.ts";

test("createQwenProvider returns a provider", () => {
  const provider = createQwenProvider({ apiKey: "test" });
  expect(typeof provider.createSession).toBe("function");
});
