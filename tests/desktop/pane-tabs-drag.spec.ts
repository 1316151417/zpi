import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("pane tabs preview sorting below the strip with a ZCode overlay and commit or cancel cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-pane-tabs-drag-"));
  const project = join(dir, "project");
  await mkdir(project);
  const names = ["first.txt", "second.txt", "third-with-a-long-title-to-fade.txt"];
  for (const name of names) await writeFile(join(project, name), name);
  const server = await fakeServer((_, response) => {
    send(
      response,
      chunk({ content: names.map((name) => `[${name}](<${join(project, name)}>)`).join("\n\n") }),
    );
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByLabel("添加项目", { exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("Open these files");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    for (const name of names)
      await page.locator(".answer").getByRole("button", { name, exact: true }).click();
    const strip = page.getByRole("tablist", { name: "侧栏标签" });
    const tabs = strip.getByRole("tab");
    const first = strip.getByRole("tab", { name: names[0], exact: true });
    const last = strip.getByRole("tab", { name: names[2], exact: true });
    const overlay = page.locator(".pane-tab-drag-overlay");
    await expect(tabs).toHaveCount(3);
    await expect(strip.locator("[draggable=true]")).toHaveCount(0);

    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // Full view and a compressed sidebar must use the same gesture and fixed-size overlay.
      if (scheme === "dark") await page.getByLabel("进入完整视图", { exact: true }).click();
      const source = await last.boundingBox();
      const target = await first.boundingBox();
      if (!source || !target) throw Error("Missing tab bounds");
      const x = source.x + source.width / 2;
      const y = source.y + source.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 2, y);
      await expect(overlay).toHaveCount(0);
      await page.mouse.move(x - 6, y);
      await expect(overlay).toBeVisible();
      await page.mouse.move(target.x + target.width / 2, y + 100, { steps: 12 });
      await expect(overlay).toHaveCSS("width", "156px");
      await expect(overlay).toHaveCSS("height", "28px");
      await expect(overlay).toHaveCSS("border-radius", "8px");
      await expect(overlay).toHaveCSS("cursor", "grabbing");
      await expect(overlay.locator("button")).toHaveCount(0);
      await expect(overlay.locator(".pane-tab-content")).toHaveCSS("--tab-fade-offset", "0px");
      expect((await overlay.boundingBox())?.y).toBeGreaterThan(y + 50);
      // Before mouse-up the neighboring tab has already moved, while DOM order is unchanged.
      await expect
        .poll(async () => (await first.boundingBox())?.x ?? 0)
        .toBeCloseTo(target.x + source.width + 4, 0);
      await expect(tabs.filter({ hasNot: page.locator(".pane-conversation-title") })).toHaveText(names);
      await page.screenshot({ path: `test-results/pane-tabs-drag-${scheme}.png` });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(overlay).toHaveCount(0);
      await expect.poll(async () => (await first.boundingBox())?.x ?? 0).toBeCloseTo(target.x, 0);
      await expect(last).toHaveAttribute("aria-selected", "true");
    }

    // Drag an inactive tab below the strip; dropping commits order without activating it.
    const source = await first.boundingBox();
    const target = await last.boundingBox();
    if (!source || !target) throw Error("Missing tab bounds");
    await page.mouse.move(source.x + source.width / 2, source.y + 14);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2 + 6, source.y + 14);
    await page.mouse.move(target.x + target.width / 2, source.y + 114, { steps: 12 });
    await page.mouse.up();
    await expect(overlay).toHaveCount(0);
    await expect(tabs.filter({ hasNot: page.locator(".pane-conversation-title") })).toHaveText([
      names[1],
      names[2],
      names[0],
    ]);
    await expect(last).toHaveAttribute("aria-selected", "true");
    // dnd-kit retains its click guard for 50ms after release; use a deliberate subsequent click.
    await first.click({ delay: 80 });
    await expect(first).toHaveAttribute("aria-selected", "true");
    await first.press("ArrowLeft");
    await expect(last).toHaveAttribute("aria-selected", "true");
    await first.click({ button: "middle" });
    await expect(first).toHaveCount(0);
    await expect(last).toHaveAttribute("aria-selected", "true");
    await last.click({ button: "right" });
    await page.getByRole("menuitem", { name: "关闭其他标签", exact: true }).click();
    await expect(tabs).toHaveCount(2); // Conversation tab stays pinned in full view.
    await last.getByLabel(`关闭标签 ${names[2]}`, { exact: true }).click();
    await expect(last).toHaveCount(0);
    await expect(overlay).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
