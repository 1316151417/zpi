import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

async function configureModels(page: Page) {
  await page.evaluate(async () => {
    const result = await window.zpi.getSettings();
    if (!result.ok) throw Error(result.error.message);
    const p = result.value.providers[0];
    const saved = await window.zpi.saveProvider({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: "",
      models: [
        { id: "fake", input: ["text", "image"], reasoning: true, compat: { supportsReasoningEffort: true } },
        { id: "plain", input: ["text"], reasoning: false },
      ],
    });
    if (!saved.ok) throw Error(saved.error.message);
  });
}
test("read-only resource settings, skill defaults, file changes and compaction use the live runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-resource-settings-")),
    project = join(dir, "project");
  await mkdir(project);
  await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
  await writeFile(
    join(dir, ".agents", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: code review\n---\nSECRET BODY",
  );
  await writeFile(join(project, "AGENTS.md"), "PROJECT POLICY");
  await writeFile(join(project, "existing.txt"), "external old\n");
  const server = await fakeServer((body, r) => {
    const messages = body.messages as unknown as { role: string; content: unknown }[];
    if (JSON.stringify(messages).includes("Return only the summary")) {
      send(r, chunk({ content: "## Goal\nContinue file work\n## Progress\nUpdated existing.txt" }));
      done(r);
      return;
    }
    if (
      messages.at(-1)?.content === "compact check" &&
      !JSON.stringify(messages).includes("Summary of earlier conversation")
    ) {
      r.writeHead(400, { "content-type": "application/json" });
      r.end(JSON.stringify({ error: { message: "context_length_exceeded" } }));
      return;
    }
    if (!messages.some((m) => m.role === "tool")) {
      send(
        r,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "edit",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "existing.txt", content: "new result\n" }),
              },
            },
          ],
        }),
      );
      done(r, "tool_calls");
    } else {
      send(r, chunk({ content: "Finished" }));
      done(r);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    const imageFile = join(dir, "selected.png");
    await writeFile(
      imageFile,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWN415H2riONAUIBADY+B3G73tFAAAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    app = await launchDesktop({ dir, project, url: server.url, images: [imageFile] });
    const page = await app.firstWindow();
    await configureModels(page);
    await page.reload();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("initial task");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    server.requests.splice(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();

    await expect(page.locator(".settings-tabs button")).toHaveText([
      "界面设置",
      "系统提示词",
      "工具",
      "技能",
      "模型",
      "已归档任务",
    ]);
    await expect(page.locator(".settings-tabs button").first()).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "系统提示词", exact: true }).click();
    await expect(
      page.locator(".resource-settings input, .resource-settings textarea, .resource-settings select"),
    ).toHaveCount(0);
    await expect(page.locator(".resource-settings button")).toHaveCount(0);
    await expect(page.locator(".prompt-preview")).toContainText("Be concise in your responses");
    await expect(page.locator(".prompt-preview")).toContainText("Use bash for file operations");
    await expect(page.locator(".prompt-preview")).not.toContainText("PROJECT POLICY");
    await expect(page.locator(".prompt-preview")).toContainText("available_skills");
    await page.getByRole("button", { name: "技能", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "启用技能 review user" })).toBeChecked();
    await page.getByRole("checkbox", { name: "启用技能 review user" }).click();
    await expect(page.getByRole("checkbox", { name: "启用技能 review user" })).not.toBeChecked();
    await page.getByRole("button", { name: /review.*user.*code review/ }).click();
    await expect(page.getByRole("dialog").locator("pre")).toContainText("SECRET BODY");
    await page.screenshot({ path: "test-results/desktop-skill-detail.png" });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "设置", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/desktop-settings-skills.png" });
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await expect(page.locator(".tool-resource-detail")).toHaveCount(0);
    await expect(page.locator(".tool-resource-row")).toHaveCount(4);
    await page.screenshot({ path: "test-results/desktop-settings-tools-list.png" });
    await page.getByRole("button", { name: /read 已启用/ }).click();
    await expect(page.locator(".tool-resource-detail")).toContainText("Images are sent as attachments");
    await page.screenshot({ path: "test-results/desktop-settings-tool-detail.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/desktop-settings-tools-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: /read 已启用/ }).click();
    await expect(page.locator(".tool-resource-detail")).toHaveCount(0);
    await page.getByRole("button", { name: "系统提示词", exact: true }).click();
    await expect(page.locator(".prompt-preview")).not.toContainText("available_skills");

    await page.screenshot({ path: "test-results/desktop-resource-settings-prompt.png" });
    await page.getByLabel("关闭设置").click();
    await page.getByLabel("消息", { exact: true }).fill("$");
    await page.getByRole("option", { name: /\$review/ }).click();
    await expect(page.getByLabel("消息", { exact: true }).locator(".inline-mention.skill")).toHaveText(
      "review",
    );
    expect(
      await page
        .getByLabel("消息", { exact: true })
        .locator(".inline-mention.skill")
        .getAttribute("data-markdown"),
    ).toContain("[$review](");
    await page.getByRole("button", { name: "新对话 project", exact: true }).click();
    await page.getByLabel("消息", { exact: true }).fill("$");
    await expect(page.getByRole("option", { name: /\$review/ })).toHaveCount(0);
    await page.getByLabel("消息", { exact: true }).press("Escape");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.locator(".topbar-title").click();
      const border = () => page.locator(".composer").evaluate((el) => getComputedStyle(el).borderColor);
      const normal = await border();
      await page.locator(".composer").hover();
      await expect.poll(border).not.toBe(normal);
      const hover = await border();
      await page.getByLabel("消息", { exact: true }).focus();
      await expect.poll(border).not.toBe(hover);
      expect(await border()).not.toBe(normal);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await writeFile(join(project, "existing.txt"), "external old\n");
    await page.getByLabel("添加附件", { exact: true }).click();
    await page.getByRole("menuitem", { name: "添加图片…", exact: true }).click();
    await expect(page.locator(".composer .image-chip img")).toHaveCount(1);
    await page.getByRole("button", { name: "预览 selected.png" }).click();
    await expect(page.getByRole("dialog", { name: "图片预览" })).toBeVisible();
    await page.getByRole("dialog", { name: "图片预览" }).press("Escape");
    await page.getByLabel("消息", { exact: true }).fill("update file");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const wire = (server.requests[0].messages as unknown as { role: string; content: string }[]).find(
      (m) => m.role === "system",
    )?.content;
    expect(wire).toContain("Be concise in your responses");
    expect(wire).toContain("PROJECT POLICY");
    expect(wire).not.toContain("available_skills");
    expect(JSON.stringify(server.requests[0].messages)).toContain("image_url");
    await expect(page.locator(".composer .image-chip")).toHaveCount(0);
    await expect(page.locator(".user-message .image-chip img")).toHaveCount(1);
    await expect(page.locator(".changed-file-card")).toContainText("existing.txt");
    await expect(page.locator(".changed-file-counts")).toHaveText("+1−1");
    const cardBox = await page.locator(".changed-file-card").boundingBox();
    const answerBox = await page.locator(".answer").boundingBox();
    expect(cardBox?.y).toBeGreaterThan(answerBox?.y ?? 0);
    await page.screenshot({ path: "test-results/desktop-resource-settings-file-cards.png" });
    await page.getByRole("button", { name: "查看修改 existing.txt" }).click();
    await expect(page.locator(".right-pane")).toBeVisible();
    await expect(page.locator("diffs-container")).toContainText("external old");
    await expect(page.locator("diffs-container")).toContainText("new result");
    await page.emulateMedia({ colorScheme: "light" });
    const diffColor = () =>
      page.locator("diffs-container").evaluate((el) => {
        const code = el.shadowRoot?.querySelector("pre");
        return code ? getComputedStyle(code).backgroundColor : "";
      });
    await expect.poll(diffColor).not.toBe("");
    const lightDiff = await diffColor();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await page.getByLabel("关闭设置").click();
    await expect.poll(diffColor).not.toBe(lightDiff);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "浅色", exact: true }).click();
    await page.getByLabel("关闭设置").click();
    await expect.poll(diffColor).toBe(lightDiff);
    await page.screenshot({ path: "test-results/desktop-resource-settings-diff.png" });
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await page.locator(".topbar-title").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(page.locator(".right-pane")).toBeVisible();
    await expect(page.locator(".right-pane").getByRole("button", { name: /existing.txt/ })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await readFile(join(project, "existing.txt"), "utf8")).toBe("new result\n");
    await page.getByLabel("消息", { exact: true }).fill("compact check");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("run").last()).toContainText("已自动压缩");
    await expect(page.getByTestId("run")).toHaveCount(2);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
