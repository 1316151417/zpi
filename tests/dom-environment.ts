import { builtinEnvironments, type Environment } from "vitest/runtime";
import { isolateUnitEnvironment } from "./helpers/unit-environment.ts";

// Real React DOM events and effects, with no browser process, network resources, or OS input.
export default {
  name: "isolated-dom",
  viteEnvironment: "ssr",
  async setup(global, options) {
    const dom = await builtinEnvironments["happy-dom"].setup(global, {
      ...options,
      happyDOM: {
        settings: {
          enableJavaScriptEvaluation: false,
          disableJavaScriptFileLoading: true,
          enableCSSFileLoading: false,
          enableImageFileLoading: false,
          enableIframePageLoading: false,
          fetch: {
            interceptor: {
              beforeAsyncRequest: async () => {
                throw new Error("DOM test network access is disabled");
              },
              beforeSyncRequest: () => {
                throw new Error("DOM test network access is disabled");
              },
            },
          },
        },
      },
    });
    const document = global.document as Document;
    document.write("<!doctype html><html><head></head><body></body></html>");
    document.close();
    const environment = isolateUnitEnvironment();
    return {
      async teardown() {
        try {
          await environment.close();
        } finally {
          await dom.teardown(global);
        }
      },
    };
  },
} satisfies Environment;
