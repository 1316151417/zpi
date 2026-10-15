import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop } from "../helpers/desktop.ts";
import { descendants, processSnapshot } from "../helpers/process-snapshot.ts";
import { test } from "../helpers/test.ts";

test("cleanup probe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-cleanup-probe-"));
  const app = await launchDesktop({ dir, url: "" });
  const page = await app.firstWindow();
  await page.getByLabel("新建任务", { exact: true }).first().click();
  await page.evaluate(async () => {
    const session = await window.zpi.createSession(null);
    if (!session.ok) throw new Error(session.error.message);
    const terminal = await window.zpi.createTerminal(session.value.id);
    if (!terminal.ok) throw new Error(terminal.error.message);
    await window.zpi.terminalInput(terminal.value.id, "sleep 60\n");
  });
  await writeFile(
    process.env.ZPI_CLEANUP_REPORT as string,
    JSON.stringify({
      scope: process.env.ZPI_TEST_SCOPE,
      electron: app.process().pid,
      worker: process.pid,
      descendants: [...descendants(app.process().pid as number, await processSnapshot())],
    }),
  );
  switch (process.env.ZPI_CLEANUP_PROBE) {
    case "failure":
      throw new Error("Intentional cleanup probe failure");
    case "timeout":
      test.setTimeout(1500);
      break;
    case "cancel":
      break;
    case "crash":
      break;
    default:
      return;
  }
  await new Promise(() => {});
});
