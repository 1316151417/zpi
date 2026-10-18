import { describe, expect, test } from "vitest";
import { attachmentLimitMessage, userErrorMessage } from "../src/renderer/user-error.ts";

const fallback = "操作失败，请重试。如果问题持续，请重启应用。";

describe("userErrorMessage", () => {
  test.each([
    ["configuration: 请先选择有效模型", "请先选择有效模型"],
    ["busy: 请先停止运行", "请先停止运行"],
    ["not_found: 附件不存在或不属于此会话", "附件不存在或不属于此会话"],
    ["provider: 无法打开浏览器，请重试", "无法打开浏览器，请重试"],
    ["storage: 无法读取结果", "无法读取结果"],
    ["invalid_input: 图片单张上限为 10 MiB", "图片单张上限为 10 MiB"],
    [
      "Error: configuration: 当前模型不支持图片，请选择图片模型或移除附件",
      "当前模型不支持图片，请选择图片模型或移除附件",
    ],
    ["Error invoking remote method 'zpi:invoke': Error: busy: 请先停止运行", "请先停止运行"],
    ['Error: Error invoking remote method "zpi:invoke": Error: storage: 无法读取结果', "无法读取结果"],
    [new Error("请先登录 ChatGPT"), "请先登录 ChatGPT"],
    ["invalid_input: 图片损坏", "图片损坏"],
    ["稍后重试", "稍后重试"],
    ["离线", "离线"],
    [{ code: "invalid_input", message: attachmentLimitMessage }, attachmentLimitMessage],
    ["认证失败，请检查 API Key 或重新登录后重试。", "认证失败，请检查 API Key 或重新登录后重试。"],
  ])("retains safe copy without transport/code prefixes: %j", (error, expected) => {
    expect(userErrorMessage(error)).toBe(expected);
  });

  test.each([
    undefined,
    null,
    false,
    42,
    {},
    { message: { secret: "hidden" } },
    new TypeError("Cannot read properties of undefined (reading 'id')"),
    "Error: arbitrary synthetic failure",
    "storage: Missing transcript index",
    "storage: Invalid transcript sequence/chain at byte 123",
    "读取失败：TypeError: Cannot read properties of undefined",
    "内部异常：未定义变量，无法读取结果",
    '请求失败：{"message":"secret","debug":"server internals"}',
    '{"error":{"message":"内部错误，无法读取密钥"}}',
    "<html><body>读取失败：secret</body></html>",
    "读取失败\n    at read (/private/session.ts:12:3)",
    "读取失败：/Users/private/workspace/session.json",
    "请求失败：Bearer sk-private-secret",
    "服务器返回：请求失败，账户密钥已失效",
    `请求失败：${"很".repeat(200)}`,
  ])("does not leak arbitrary technical data, even with Chinese: %j", (error) => {
    expect(userErrorMessage(error)).toBe(fallback);
  });

  test.each([
    ["ENOENT: no such file or directory, open '/Users/private/project/计划.md'", "计划.md"],
    [
      "Error: storage: ENOENT: no such file or directory, stat 'C:\\Users\\private\\report.pdf'",
      "report.pdf",
    ],
    [{ code: "ENOENT", path: "/private/a/file with spaces.txt", message: "missing" }, "file with spaces.txt"],
    ["not_found: 文件不存在：/Users/private/project/foo.md", "foo.md"],
    ["文件不存在：C:\\Users\\private\\中文.md", "中文.md"],
  ])("shows only a concise missing filename: %j", (error, name) => {
    expect(userErrorMessage(error)).toBe(`找不到文件“${name}”，请确认文件是否已移动或删除。`);
  });

  test("omits malformed filenames and shortens long names", () => {
    expect(userErrorMessage({ code: "ENOENT", path: "/private/<secret>" })).toBe(
      "找不到文件，请确认文件是否已移动或删除。",
    );
    const message = userErrorMessage({ code: "ENOENT", path: `/private/${"a".repeat(200)}.txt` });
    expect(message).toContain("…");
    expect(message).toContain(".txt");
    expect(message.length).toBeLessThan(100);
    expect(message).not.toContain("/private");
  });

  test.each([
    ["EACCES: permission denied, open '/private/secret'", "权限"],
    [{ code: "EPERM", message: "operation not permitted" }, "权限"],
    ["ENOSPC: no space left on device", "磁盘空间不足"],
    ["ETIMEDOUT: request failed", "请求超时"],
    ["TimeoutError: request failed", "请求超时"],
    ['provider: 401 {"token":"private"}', "认证失败"],
    [{ status: 401, message: "secret server body" }, "认证失败"],
    ["Incorrect API key provided: sk-private", "认证失败"],
    ["AuthenticationError: invalid_api_key", "认证失败"],
    ["429: too many requests", "频繁或额度不足"],
    [{ status: 429, message: "server details" }, "频繁或额度不足"],
    ["insufficient_quota: private account details", "频繁或额度不足"],
    ["403 Forbidden: private account details", "账户权限"],
    ["model_not_found: model private is not found", "所选模型不可用"],
    ["ECONNREFUSED 127.0.0.1:1234", "无法连接到服务"],
    ["TypeError: Failed to fetch", "无法连接到服务"],
    ["net::ERR_NAME_NOT_RESOLVED", "无法连接到服务"],
    ["503 <html>secret server details</html>", "模型服务暂时不可用"],
    [{ status: 502, message: "secret server details" }, "模型服务暂时不可用"],
    ["AbortError: operation was aborted", "操作已取消"],
    ["offline", "无法连接到服务"],
  ])("maps known failures without leaking their details: %j", (error, expected) => {
    const message = userErrorMessage(error);
    expect(message).toContain(expected);
    expect(message).not.toMatch(/private|secret|127\.0\.0\.1|Error|<html>/);
  });

  test.each([
    ["configuration", "配置不可用"],
    ["busy", "尚未完成"],
    ["not_found", "不存在或已被删除"],
    ["provider", "模型服务请求失败"],
    ["invalid_input", "输入内容无效"],
    ["storage", fallback],
  ])("uses a safe category fallback for technical messages: %s", (code, expected) => {
    expect(userErrorMessage({ code, message: "InternalInvariant secret" })).toContain(expected);
  });

  test("is idempotent for every known mapping", () => {
    for (const error of [
      "ENOENT",
      "ENOENT: open '/private/file.txt'",
      "not_found: 文件不存在：/private/中文.md",
      "EACCES",
      "ENOSPC",
      "ETIMEDOUT",
      "401",
      "429",
      "403",
      "model_not_found",
      "fetch failed",
      "503",
      "AbortError",
      "configuration: InternalInvariant",
    ]) {
      const message = userErrorMessage(error);
      expect(userErrorMessage(message)).toBe(message);
    }
  });
});
