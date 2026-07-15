import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // `src/audio.ts` is its own entry so a browser can import `vxasr/audio` for
    // `writeWav` without dragging in the providers — and therefore `ws` and
    // `groq-sdk`, which do not belong in a frontend bundle.
    entry: ["src/index.ts", "src/cli.ts", "src/audio.ts"],
    dts: {
      tsgo: true,
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
