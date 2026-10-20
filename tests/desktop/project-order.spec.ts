import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { StateStore } from "../../packages/desktop/src/main/state-store.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { testStorageDirectory } from "../helpers/storage.ts";
import { expect, test } from "../helpers/test.ts";

test("project title drag and keyboard sorting retain order through reload, reopen and restart", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-project-order-")));
  const projects = ["a", "b", "c"].map((id) => ({ id, name: id, path: join(dir, id), updatedAt: 1 }));
  await Promise.all(projects.map((project) => mkdir(project.path)));
  const state = new StateStore(join(testStorageDirectory(dir), "state.sqlite"));
  state.setProjects(projects);
  state.close();
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project: projects[1].path, url: "" });
    let page = await app.firstWindow();
    const ids = () =>
      page
        .locator(".projects > .project")
        .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-project-id")));
    await expect.poll(ids).toEqual(["a", "b", "c"]);
    const first = page.getByRole("button", { name: "收起项目 a", exact: true });
    await first.focus();
    await first.press("Space");
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await first.press("ArrowDown");
    await expect(page.getByTestId("project-drop-indicator")).toHaveAttribute("data-drop-position", "after");
    await first.press("Space");
    await expect.poll(ids).toEqual(["b", "a", "c"]);
    await page.reload();
    await expect.poll(ids).toEqual(["b", "a", "c"]);
    const a = await page.getByRole("button", { name: "收起项目 a", exact: true }).boundingBox();
    const c = await page.getByRole("button", { name: "收起项目 c", exact: true }).boundingBox();
    if (!a || !c) throw new Error("Missing project title bounds");
    await page.mouse.move(a.x + 40, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(c.x + 40, c.y + c.height / 2, { steps: 15 });
    await expect(page.getByTestId("project-drop-indicator")).toBeVisible();
    await page.mouse.up();
    await expect.poll(ids).toEqual(["b", "c", "a"]);
    await page.getByLabel("添加项目", { exact: true }).click();
    await expect.poll(ids).toEqual(["b", "c", "a"]);
    await page.screenshot({ path: test.info().outputPath("projects-reordered.png") });
    await app.close();
    app = await launchDesktop({ dir, url: "" });
    page = await app.firstWindow();
    await expect.poll(ids).toEqual(["b", "c", "a"]);
    const result = await page.evaluate(async () => {
      const result = await window.zpi.reorderProjects(["b", "b", "a"]);
      return result.ok;
    });
    expect(result).toBe(false);
    await page.reload();
    await expect.poll(ids).toEqual(["b", "c", "a"]);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
