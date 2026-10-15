import { join } from "node:path";
import { expect, test } from "vitest";
import { desktopEnvironment } from "../../../tests/helpers/desktop-isolation.ts";

test("desktop environment retains only OS essentials and replaces all user locations", () => {
  const inherited = {
    PATH: "/bin",
    DISPLAY: ":99",
    HOME: "/real",
    ZPI_DATA_DIR: "/real/data",
    ZPI_TEST_SHOW_WINDOW: "1",
    ZPI_TEST_INTERACTIVE: "1",
    ZPI_DEV_URL: "http://localhost",
    OPENAI_API_KEY: "private",
    HTTPS_PROXY: "private-proxy",
    BASH_ENV: "/profile",
    ENV: "/profile",
    NODE_OPTIONS: "--inspect",
    ELECTRON_RUN_AS_NODE: "1",
    SHELL: "/custom-shell",
  };
  const env = desktopEnvironment({ dir: "/tmp/test", url: "" }, inherited);
  expect(env).toMatchObject({
    PATH: "/bin",
    DISPLAY: ":99",
    HOME: "/tmp/test",
    ZPI_TEST_INTERACTIVE: "0",
    ZPI_TEST_DATA_DIR: "/tmp/test",
    ZDOTDIR: "/tmp/test",
    TMPDIR: "/tmp/test",
    APPDATA: join("/tmp/test", "AppData/Roaming"),
  });
  for (const key of [
    "ZPI_DATA_DIR",
    "ZPI_TEST_SHOW_WINDOW",
    "ZPI_DEV_URL",
    "OPENAI_API_KEY",
    "HTTPS_PROXY",
    "BASH_ENV",
    "ENV",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
  ])
    expect(env).not.toHaveProperty(key);
  expect(env.SHELL).not.toBe(inherited.SHELL);
});

test("fixtures and interactive intent must be supplied explicitly", () => {
  expect(
    desktopEnvironment(
      {
        dir: "/tmp/test",
        url: "http://127.0.0.1:1234",
        project: "/tmp/project",
        images: ["/tmp/a.png"],
        interactive: true,
      },
      {},
    ),
  ).toMatchObject({
    ZPI_TEST_INTERACTIVE: "1",
    ZPI_TEST_AUTO_SELECTION: "1",
    ZPI_TEST_BASE_URL: "http://127.0.0.1:1234",
    ZPI_TEST_PROJECT_DIR: "/tmp/project",
    ZPI_TEST_IMAGE_FILES: '["/tmp/a.png"]',
  });
});
