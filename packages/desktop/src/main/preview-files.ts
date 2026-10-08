import { stat } from "node:fs/promises";
import { resolveLocalFilePath } from "./local-file-path.ts";
export async function checkPreviewFiles(
  cwd: string,
  input: unknown,
): Promise<Array<{ path: string; exists: boolean }>> {
  if (
    !Array.isArray(input) ||
    input.length > 15 ||
    input.some((path) => typeof path !== "string" || !path || path.length > 8192 || /[\0\r\n]/.test(path))
  )
    throw new Error("invalid_input: 文件预览检查参数无效");
  return Promise.all(
    input.map(async (path: string) => {
      try {
        if (process.platform !== "win32" && /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(path))
          return { path, exists: false };
        return { path, exists: (await stat(await resolveLocalFilePath(cwd, path))).isFile() };
      } catch {
        return { path, exists: false };
      }
    }),
  );
}
