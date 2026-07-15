import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { sourcemap: true, minify: false },
  server: {
    port: 20470,
  },
  run: {
    // `evalUpload.ts` imports `vxasr/audio` for `writeWav`, so these need
    // vxasr's dist — without this a stale dist surfaces as a module-resolution
    // error rather than as "build the package first".
    tasks: {
      // The deploy runs `pnpm run build` directly, so it never walks this task
      // graph — the dependency has to hang off the script the deploy actually
      // invokes, or vxasr's dist is simply absent and `tsc` fails with TS2307.
      "build:app": {
        command: "tsc && vp build",
        dependsOn: ["vxasr#build"],
      },
      "check:types": {
        command: "vp check",
        dependsOn: ["vxasr#build"],
      },
      "test:unit": {
        command: "vp test",
        dependsOn: ["vxasr#build"],
      },
    },
  },
});
