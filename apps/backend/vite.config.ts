import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/server.ts"],
    format: "esm",
    sourcemap: true,
    dts: false,
  },
});
