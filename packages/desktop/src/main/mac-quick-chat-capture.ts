import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Clipboard } from "electron";
import { imageLimits } from "zpi-coding-agent/input";
import type { QuickChatDraftInput } from "../shared/quick-chat.ts";
import type { QuickChatCaptureKind } from "./quick-chat-capture.ts";

interface Options {
  platform: string;
  testMode: boolean;
  temporaryDirectory: string;
  selectionHelper: string;
  clipboard: Pick<Clipboard, "readText" | "readImage">;
  accessibilityAccess(): boolean;
  run?: (
    command: string,
    args: string[],
    options: { signal: AbortSignal; timeout?: number; maxBuffer?: number },
  ) => Promise<{ stdout: string | Buffer }>;
}
const run = promisify(execFile);
function checkedText(text: string): string {
  if (text.length > 32_000) throw new Error("invalid_input: 带入文字超过 32000 字，请缩短内容");
  return text;
}
function checkedImage(bytes: Uint8Array): Uint8Array {
  if (!bytes.length || bytes.length > imageLimits.sourceBytes)
    throw new Error("invalid_input: 图片为空或超过 10 MiB，请缩小截图或图片");
  return bytes;
}

/** OS access stays here, outside the host/SDK. No clipboard writes or automatic copy keystrokes. */
export function macQuickChatCapture(options: Options) {
  const execute = options.run ?? run;
  async function selection(signal: AbortSignal): Promise<QuickChatDraftInput | undefined> {
    if (!options.accessibilityAccess())
      throw new Error("configuration: 请在系统设置 → 隐私与安全性 → 辅助功能中允许 ZPI 读取选中文字，再重试");
    let stdout: string | Buffer;
    try {
      ({ stdout } = await execute(options.selectionHelper, [], {
        signal,
        timeout: 5000,
        maxBuffer: 256 * 1024,
      }));
    } catch (cause) {
      if (signal.aborted) return;
      throw new Error(
        "configuration: 读取选中文字失败，请检查辅助功能权限和目标应用；也可先复制，再用剪贴板带入",
        { cause },
      );
    }
    if (!String(stdout).trim())
      throw new Error("configuration: 选中文字读取未返回结果，请重试；也可先复制，再用剪贴板带入");
    const result: { text?: string; error?: string } = JSON.parse(String(stdout));
    if (result.error === "permission")
      throw new Error("configuration: 选中文字读取未获辅助功能权限，请授权后重试");
    if (result.error === "too_large") throw new Error("invalid_input: 选中文字超过 32000 字，请缩短选区");
    if (typeof result.text !== "string" || !result.text.trim())
      throw new Error(
        "invalid_input: 未读到选中文字，或当前应用未提供选区。请先复制，再使用剪贴板带入快捷键",
      );
    return { text: checkedText(result.text) };
  }
  async function screenshot(signal: AbortSignal): Promise<QuickChatDraftInput | undefined> {
    const directory = await mkdtemp(join(options.temporaryDirectory, "zpi-capture-"));
    const path = join(directory, "screenshot.png");
    try {
      try {
        await execute("/usr/sbin/screencapture", ["-i", "-s", "-x", "-t", "png", path], { signal });
      } catch (error) {
        if (signal.aborted) return;
        // Escape cancels without creating a file. Permission failures remain errors.
        if ((error as { code?: unknown }).code !== 1)
          throw new Error("configuration: 系统截图无法完成，请检查屏幕录制权限后重试", { cause: error });
        if (String((error as { stderr?: unknown }).stderr ?? "").trim())
          throw new Error("configuration: 系统截图失败，请检查屏幕录制权限后重试", { cause: error });
        return;
      }
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) return;
      if (info.size > imageLimits.sourceBytes) throw new Error("invalid_input: 截图超过 10 MiB，请缩小选区");
      return { image: { name: "截图.png", bytes: checkedImage(await readFile(path)) } };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return (
    kind: QuickChatCaptureKind,
    signal: AbortSignal,
  ): QuickChatDraftInput | undefined | Promise<QuickChatDraftInput | undefined> => {
    if (options.testMode) throw new Error("Native capture is unavailable in desktop tests");
    if (options.platform !== "darwin") throw new Error("configuration: 内容带入快捷键目前仅支持 macOS");
    if (kind === "selection") return selection(signal);
    if (kind === "screenshot") return screenshot(signal);
    const image = options.clipboard.readImage();
    // Images win over accompanying clipboard text/HTML, matching an ordinary image paste.
    if (!image.isEmpty()) {
      const size = image.getSize();
      if (size.width * size.height > imageLimits.pixels)
        throw new Error("invalid_input: 剪贴板图片像素过大，请缩小图片");
      return { image: { name: "剪贴板.png", bytes: checkedImage(image.toPNG()) } };
    }
    const text = checkedText(options.clipboard.readText());
    if (!text.trim()) throw new Error("invalid_input: 剪贴板里没有可带入的文字或图片");
    return { text };
  };
}
