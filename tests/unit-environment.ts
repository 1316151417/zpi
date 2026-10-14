import { builtinEnvironments, type Environment } from "vitest/runtime";
import { isolateUnitEnvironment } from "./helpers/unit-environment.ts";

export default {
  name: "isolated-node",
  viteEnvironment: "ssr",
  async setup(global, options) {
    const node = await builtinEnvironments.node.setup(global, options);
    const environment = isolateUnitEnvironment();
    return {
      async teardown() {
        try {
          await environment.close();
        } finally {
          await node.teardown(global);
        }
      },
    };
  },
} satisfies Environment;
