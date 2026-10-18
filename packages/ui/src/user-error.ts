import { imageLimits } from "zpi-coding-agent/input";

/** Shared so the renderer pre-check and the main process reject with the same copy. */
export const attachmentLimitMessage = `每个草稿最多 ${imageLimits.count} 个附件，请先发送或移除已有附件。`;

const fallback = "操作失败，请重试。如果问题持续，请重启应用。";
const categories = /^(configuration|busy|not_found|provider|storage|invalid_input)\s*[:：]\s*/i;

function safeCopy(message: string): boolean {
  if (
    !message ||
    message.length > 180 ||
    /[\p{Cc}{}[\]<>`\\]|https?:|\/\S|\b(?:Error|Exception|undefined|null|NaN|SQL|IPC)\b/iu.test(message) ||
    /堆栈|调用栈|内部(?:异常|错误)|未定义|空指针|断言|语法错误|服务器返回|响应(?:体|内容)|请求(?:体|头)|异常[:：]/.test(
      message,
    )
  )
    return false;
  // Only familiar product/format names may accompany natural-language copy, not arbitrary exception text.
  const prose = message.replace(
    /\b(?:API\s*Key|API|ChatGPT|OpenAI|Anthropic|Claude|DeepSeek|Gemini|ZPI|HTTP|HTTPS|PDF|Word|Excel|PowerPoint|PNG|JPEG|JPG|GIF|WebP|SVG|MiB|KiB|MB|KB|OAuth|macOS|Windows)\b/gi,
    "",
  );
  return !/[A-Za-z_]/.test(prose) && /[\u3400-\u9fff]/.test(prose);
}

function filename(path: string | undefined): string | undefined {
  const name = path?.replace(/\\/g, "/").split("/").pop();
  if (!name || name === "." || name === ".." || /[\p{Cc}{}[\]<>`'"：:]/u.test(name)) return;
  return name.length > 60 ? `${name.slice(0, 40)}…${name.slice(-16)}` : name;
}

export function userErrorMessage(error: unknown): string {
  const details = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  let message =
    typeof error === "string" ? error : typeof details?.message === "string" ? details.message : "";
  let code = typeof details?.code === "string" ? details.code.toLowerCase() : "";
  message = message.trim();
  for (let i = 0; i < 8; i++) {
    const previous = message;
    message = message
      .replace(/^Error invoking remote method\s+(['"])[^\r\n]*?\1\s*:\s*/i, "")
      .replace(/^Error\s*:\s*/i, "");
    message = message
      .replace(categories, (_, category: string) => {
        code = category.toLowerCase();
        return "";
      })
      .trim();
    if (message === previous) break;
  }
  const missingCopy = /^找不到文件“([^”]+)”，请确认文件是否已移动或删除。$/.exec(message);
  if (missingCopy && filename(missingCopy[1]) === missingCopy[1]) return message;
  if (safeCopy(message)) return message;

  // Inspect only the summary; response bodies and stacks are never copied into user-facing text.
  const summary = message.split(/[\r\n]/, 1)[0]?.slice(0, 1000) ?? "";
  const signal = `${code} ${summary}`;
  const status = typeof details?.status === "number" ? details.status : undefined;
  if (/\bENOENT\b|no such file or directory|file not found|找不到文件|文件不存在/i.test(signal)) {
    const path =
      typeof details?.path === "string"
        ? details.path
        : (/(?:open|stat|lstat|scandir|access|unlink|readlink)\s+['"]([^'"\r\n]+)['"]/i.exec(summary)?.[1] ??
          /(?:文件不存在|找不到文件|file not found)\s*[:：]\s*['"“]?(.+?)['"”]?$/i.exec(summary)?.[1]);
    const name = filename(path);
    return name
      ? `找不到文件“${name}”，请确认文件是否已移动或删除。`
      : "找不到文件，请确认文件是否已移动或删除。";
  }
  if (/\b(?:EACCES|EPERM)\b|permission denied|operation not permitted|权限不足|没有权限/i.test(signal))
    return "没有权限完成此操作，请检查文件或系统权限后重试。";
  if (/\bENOSPC\b|no space left|disk (?:is )?full|磁盘空间不足/i.test(signal))
    return "磁盘空间不足，请清理空间后重试。";
  if (
    /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ERR_TIMED_OUT|TimeoutError)\b|timed?\s*out|timeout|超时/i.test(
      signal,
    )
  )
    return "请求超时，请检查网络连接后重试。";
  if (
    status === 401 ||
    /\b401\b|unauthenticated|unauthorized|(?:invalid|incorrect)[ _-]?(?:api[ _-]?)?key|authentication|登录已过期/i.test(
      signal,
    )
  )
    return "认证失败，请检查 API Key 或重新登录后重试。";
  if (
    status === 429 ||
    /\b429\b|rate[ _-]?limit|too many requests|quota|insufficient[ _-]?(?:quota|balance)|余额不足|额度不足/i.test(
      signal,
    )
  )
    return "服务请求过于频繁或额度不足，请稍后重试，并检查账户额度。";
  if (status === 403 || /\b403\b|forbidden|access denied/i.test(signal))
    return "服务拒绝了请求，请检查账户权限和模型访问权限。";
  if (
    /model[ _-]not[ _-]found|unknown model|model .* (?:does not exist|not found|not available)/i.test(signal)
  )
    return "所选模型不可用，请在设置中检查模型或选择其他模型。";
  if (
    /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ERR_NETWORK|ERR_CONNECTION_\w+|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED)\b|failed to fetch|fetch failed|network(?:error| error)|socket hang up|offline|网络连接失败/i.test(
      signal,
    )
  )
    return "无法连接到服务，请检查网络、代理和服务地址后重试。";
  if (
    (status !== undefined && status >= 500) ||
    /\b50[0-9]\b|service unavailable|bad gateway|internal server error|overloaded/i.test(signal)
  )
    return "模型服务暂时不可用，请稍后重试或切换模型。";
  if (/\bAbortError\b|aborted|cancelled|canceled/i.test(signal)) return "操作已取消，请在需要时重试。";

  switch (code) {
    case "configuration":
      return "配置不可用，请在设置中检查后重试。";
    case "busy":
      return "当前操作尚未完成，请稍后重试。";
    case "not_found":
      return "所需内容不存在或已被删除，请刷新后重试。";
    case "provider":
      return "模型服务请求失败，请检查服务设置后重试。";
    case "invalid_input":
      return "输入内容无效，请检查后重试。";
    default:
      return fallback;
  }
}
