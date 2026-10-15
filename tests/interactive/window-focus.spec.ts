import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("interactive: native window activation and focus after hiding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-visible-"));
  const app = await launchDesktop({ dir, url: "" });
  await app.firstWindow();
  await app.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].hide();
    app.emit("activate", {}, false);
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return window.isVisible() && window.isFocused();
      }),
    )
    .toBe(true);
});
