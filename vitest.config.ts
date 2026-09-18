import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live in test/ and import the TS sources directly. Each test
    // isolates its own QP_CONFIG_DIR, so run them in a single fork to keep the
    // process-env / filesystem manipulation deterministic.
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
