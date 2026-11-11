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
    const breadcrumb = page.getByRole("navigation", { name: "命令导航", exact: true });
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText("新建命令");
    await breadcrumb.getByRole("button", { name: "返回命令列表", exact: true }).click();
    await expect(breadcrumb).toHaveCount(0);
    await page.getByRole("button", { name: "新建", exact: true }).first().click();
    await page.getByLabel("名称", { exact: true }).fill("review");
    await page.getByLabel("描述（可选）", { exact: true }).fill("Review selected files");
    await page.getByLabel("参数提示（可选）", { exact: true }).fill("<file>");
    await page.getByRole("textbox", { name: "提示词", exact: true }).fill("Review $ARGUMENTS");
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
    await row.getByRole("checkbox").click();
    await expect(row.getByRole("checkbox")).not.toBeChecked();
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
    await page.getByRole("textbox", { name: "提示词", exact: true }).fill("STALE SAVE");
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
    await page.getByRole("button", { name: "收起项目 project", exact: true }).hover();
    await page.getByRole("button", { name: "新建任务 project", exact: true }).click();
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
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const projectId = await page.evaluate(async () => {
      const result = await window.zpi.listProjects();
      if (!result.ok) throw new Error(result.error.message);
      return result.value[0].id;
    });
    await writeFile(
      join(project, ".zpi", "commands", "review.md"),
      "---\ndescription: Updated project review\n---\nLATEST REVIEW $ARGUMENTS",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await editor.fill("/rev");
    await expect(page.getByRole("option").filter({ hasText: "/review" })).toContainText(
      "Updated project review",
    );
    await editor.fill("/review changed.ts");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(JSON.stringify(server.requests[1].messages)).toContain("LATEST REVIEW changed.ts");
    for (const enabled of [false, true]) {
      await page.evaluate(
        async ({ projectId, enabled }) => {
          const result = await window.zpi.setCustomCommandEnabled({ id: "review.md", enabled }, projectId);
          if (!result.ok) throw new Error(result.error.message);
          window.dispatchEvent(new Event("zpi:commands-changed"));
        },
        { projectId, enabled },
      );
      await editor.fill("/rev");
      await expect(page.getByRole("option").filter({ hasText: "/review" })).toHaveCount(enabled ? 1 : 0);
    }
    await page.evaluate(async (projectId) => {
      const catalog = await window.zpi.getCustomCommands(projectId);
      if (!catalog.ok) throw new Error(catalog.error.message);
      const review = catalog.value.commands.find((command) => command.id === "review.md");
      if (!review) throw new Error("Missing review command");
      const deleted = await window.zpi.deleteCustomCommand(
        { id: review.id, expectedRevision: review.revision },
        projectId,
      );
      if (!deleted.ok) throw new Error(deleted.error.message);
      const created = await window.zpi.createCustomCommand(
        { name: "late", prompt: "NEW COMMAND $ARGUMENTS" },
        projectId,
      );
      if (!created.ok) throw new Error(created.error.message);
      window.dispatchEvent(new Event("zpi:commands-changed"));
    }, projectId);
    await expect(page.getByRole("option").filter({ hasText: "/review" })).toHaveCount(0);
    await editor.fill("/late");
    await expect(page.getByRole("option").filter({ hasText: "/late" })).toBeVisible();
    await editor.fill("/late current.ts");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(3);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(JSON.stringify(server.requests[2].messages)).toContain("NEW COMMAND current.ts");
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
      const enabled = await window.zpi.setPluginEnabled("zpi.collaboration", true);
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
    // Built-in agents can still match the query through their fuzzy description search.
    await expect(slash).toBeVisible();
    await expect(option).toHaveCount(0);
    expect(server.requests).toHaveLength(0);
    await editor.fill("Capture type descriptions with this profile disabled");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    for (const enabled of [true, false, true]) {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "子智能体", exact: true }).click();
      const toggle = page.getByRole("checkbox", { name: "切换 Fixture-reviewer", exact: true });
      await toggle.click();
      await expect(toggle).toBeChecked({ checked: enabled });
      await page.getByLabel("关闭设置").click();
      await editor.fill("@Fixture");
      await expect(page.locator(".subagent-option").filter({ hasText: "Fixture-reviewer" })).toHaveCount(
        enabled ? 1 : 0,
      );
    }
    expect(server.requests).toHaveLength(1);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
