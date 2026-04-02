import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
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
