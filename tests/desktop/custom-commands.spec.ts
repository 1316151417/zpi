import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("commands settings create, search, persist switches, edit conflicts, and confirm deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-commands-settings-"));
  const project = join(dir, "project");
  await mkdir(project);
  const server = await fakeServer((_, response) => done(response));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "命令", exact: true }).click();
    await page.getByRole("button", { name: "新建", exact: true }).first().click();
    await page.getByLabel("名称", { exact: true }).fill("review");
    await page.getByLabel("描述（可选）", { exact: true }).fill("Review selected files");
    await page.getByLabel("参数提示（可选）", { exact: true }).fill("<file>");
    await page.getByLabel("提示词", { exact: true }).fill("Review $ARGUMENTS");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const row = page.locator(".command-row").filter({ hasText: "/review" });
    await expect(row).toBeVisible();
    expect(
      await row.locator(".command-avatar").evaluate((element) => element.getBoundingClientRect().width),
    ).toBe(36);
    await page.getByLabel("搜索命令", { exact: true }).fill("selected");
    await expect(row).toBeVisible();
    await page.getByLabel("搜索命令", { exact: true }).fill("missing");
    await expect(page.getByText("没有匹配的命令", { exact: true })).toBeVisible();
    await page.getByLabel("搜索命令", { exact: true }).fill("");
    await row.getByRole("checkbox").uncheck();
    await page.getByRole("button", { name: "刷新命令", exact: true }).click();
    await expect(row.getByRole("checkbox")).not.toBeChecked();
    await row.getByRole("button", { name: "编辑命令 /review", exact: true }).click();
    await expect(page.getByLabel("名称", { exact: true })).toBeDisabled();
    const filePath = await page.evaluate(async () => {
      const result = await window.zpi.getCustomCommands();
      if (!result.ok) throw new Error(result.error.message);
      return result.value.commands[0].filePath;
    });
    await writeFile(filePath, "EXTERNAL EDIT");
    await page.getByLabel("提示词", { exact: true }).fill("STALE SAVE");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await readFile(filePath, "utf8")).toBe("EXTERNAL EDIT");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "刷新命令", exact: true }).click();
    await row.getByRole("button", { name: "编辑命令 /review", exact: true }).click();
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await page
      .getByRole("dialog", { name: "删除命令", exact: true })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    expect(await readFile(filePath, "utf8")).toBe("EXTERNAL EDIT");
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await page
      .getByRole("dialog", { name: "删除命令", exact: true })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect(row).toHaveCount(0);
    expect(server.requests).toHaveLength(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("project commands appear in slash picker, insert without sending, and execute in their session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-commands-composer-"));
  const project = join(dir, "project");
  await mkdir(join(project, ".zpi", "commands"), { recursive: true });
  await writeFile(
    join(project, ".zpi", "commands", "review.md"),
    "---\ndescription: Review this project\nargument-hint: <file>\n---\nPROJECT REVIEW $ARGUMENTS",
  );
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "reviewed" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("/rev");
    await expect(page.getByRole("option").filter({ hasText: "/review" })).toBeVisible();
    await editor.press("Tab");
    await expect(editor.locator(".inline-mention.command")).toHaveText("review");
    await expect(editor.locator(".inline-mention.command")).toHaveAttribute("data-markdown", "/review");
    expect(server.requests).toHaveLength(0);
    await editor.pressSequentially("file.ts");
    await editor.press("Enter");
    await expect.poll(() => server.requests.length).toBe(1);
    expect(JSON.stringify(server.requests[0].messages)).toContain("PROJECT REVIEW file.ts");
    await expect(page.getByText("reviewed", { exact: true })).toBeVisible();
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("subagent slash selection inserts a canonical chip without sending or spawning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-command-subagents-"));
  const project = join(dir, "project");
  await mkdir(project);
  const server = await fakeServer((_, response) => done(response));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const profileId = await page.evaluate(async () => {
      const enabled = await window.zpi.setCapabilityEnabled("subagents", true);
      if (!enabled.ok) throw new Error(enabled.error.message);
      const result = await window.zpi.saveSubagent({
        sessionId: null,
        scope: "user",
        config: {
          name: "Fixture-reviewer",
          description: "Temporary slash picker reviewer",
          systemPrompt: "Review the task supplied by the parent.",
          color: "blue",
          injectAgentsMd: false,
          tools: ["read"],
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      const profile = result.value.agents.find((agent) => agent.name === "Fixture-reviewer");
      if (!profile) throw new Error("Missing fixture profile");
      return profile.id;
    });
    await page.reload();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("/Fixture");
    const slash = page.getByRole("listbox", { name: "指令", exact: true });
    await expect(slash.locator(".command-section-title")).toHaveText(["指令", "技能", "子智能体"]);
    const option = slash.getByRole("option", { name: /^Fixture-reviewer/ });
    await expect(option).toBeVisible();
    await expect(option).toHaveAttribute("aria-selected", "true");
    expect(server.requests).toHaveLength(0);
    await editor.press("Tab");
    await expect(slash).toBeHidden();
    await expect(editor.locator(".inline-mention.subagent")).toHaveText("Fixture-reviewer");
    await expect(editor.locator(".inline-mention.subagent")).toHaveAttribute(
      "data-markdown",
      "@Fixture-reviewer",
    );
    await expect(editor.locator(".inline-mention.file")).toHaveCount(0);
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const id = localStorage.getItem("zpi.selectedSession");
          if (!id) throw new Error("Missing draft session");
          const draft = await window.zpi.getDraft(id);
          if (!draft.ok) throw new Error(draft.error.message);
          return { text: draft.value.text, files: draft.value.fileReferences };
        }),
      )
      .toEqual({ text: "@Fixture-reviewer ", files: [] });
    const snapshot = await page.evaluate(async () => {
      const id = localStorage.getItem("zpi.selectedSession");
      if (!id) throw new Error("Missing draft session");
      const result = await window.zpi.getSessionSnapshot(id);
      if (!result.ok) throw new Error(result.error.message);
      return { runs: result.value.view.runs.length, subagents: result.value.view.subagents ?? [] };
    });
    expect(snapshot).toEqual({ runs: 0, subagents: [] });
    expect(server.requests).toHaveLength(0);

    // A disabled profile must disappear, even when its @mention remains in a saved draft.
    await page.evaluate(async (id) => {
      const result = await window.zpi.setSubagentEnabled(id, false, null);
      if (!result.ok) throw new Error(result.error.message);
    }, profileId);
    await page.reload();
    await expect(editor).toContainText("@Fixture-reviewer");
    await expect(editor.locator(".inline-mention.subagent")).toHaveCount(0);
    await editor.fill("/Fixture");
    await expect(option).toHaveCount(0);
    await expect(slash.getByText("暂无匹配子智能体", { exact: true })).toBeVisible();
    expect(server.requests).toHaveLength(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
