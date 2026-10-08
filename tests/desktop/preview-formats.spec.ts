import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("Office, PDF and media cards preview actual existing files without turn changes", async () => {
  test.setTimeout(60000);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ZPI-preview-formats-")));
  const project = join(dir, "project");
  await mkdir(project);
  await copyFile(resolve("tests/fixtures/preview.docx"), join(project, "报告.docx"));
  await copyFile(resolve("tests/fixtures/references.xlsx"), join(project, "报表.xlsx"));
  await copyFile(resolve("tests/fixtures/preview.webm"), join(project, "视频.webm"));
  const audio = Buffer.alloc(44 + 8000 * 2);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  await writeFile(join(project, "音频.wav"), audio);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(join(project, "文档.pdf"), pdf);
  const server = await fakeServer((_, response) => {
    send(
      response,
      chunk({
        content: "已有 `报告.docx`、`报表.xlsx`、`文档.pdf`、`音频.wav`、`视频.webm`，这一轮没有文件变更。",
      }),
    );
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({
      dir,
      project,
      url: server.url,
      packaged: Boolean(process.env.ZPI_TEST_PACKAGED_APP),
    });
    const page = await app.firstWindow();
    await page.getByLabel("添加项目", { exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("预览已有文件");
    await editor.press("Enter");
    const cards = page.locator(".assistant-preview-card");
    await expect(cards).toHaveCount(5);
    await expect(cards.locator(".file-type-icon").first()).toHaveAttribute("src", /material-icons/);
    const open = async (name: string) => {
      await cards.filter({ hasText: name }).getByRole("button", { name: "打开", exact: true }).click();
    };
    const close = () => page.getByLabel("收起右侧栏", { exact: true }).click();
    await open("报告.docx");
    await expect(page.locator('[data-office-preview-kind="docx"]')).toContainText("真实 Word 预览");
    await close();
    await open("报表.xlsx");
    await expect(page.locator('[data-office-preview-kind="excel"] canvas').first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "模型数据", exact: true })).toBeVisible();
    await close();
    await open("音频.wav");
    await expect(page.locator("audio")).toBeVisible();
    await expect
      .poll(() => page.locator("audio").evaluate((el: HTMLAudioElement) => el.readyState))
      .toBeGreaterThanOrEqual(2);
    await close();
    await open("视频.webm");
    await expect(page.locator("video")).toBeVisible();
    await expect
      .poll(() => page.locator("video").evaluate((el: HTMLVideoElement) => el.videoWidth))
      .toBe(160);
    await close();
    await open("文档.pdf");
    await expect
      .poll(() =>
        app?.evaluate(({ webContents }) =>
          webContents.getAllWebContents().some((wc) => decodeURI(wc.getURL()).endsWith("文档.pdf")),
        ),
      )
      .toBe(true);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
