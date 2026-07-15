import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  test: {
    // `.claude/**` holds agent worktrees — full checkouts of this repo nested
    // inside it. Without excluding them the runner collects every worktree's
    // copy of every test, so a local run reports hundreds of failures from
    // other branches' stale trees while CI, checking out clean, stays green.
    exclude: ["e2e/**", "**/node_modules/**", "**/.claude/**"],
  },
});
