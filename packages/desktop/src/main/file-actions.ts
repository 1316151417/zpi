import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isPathInside } from "./path-bounds.ts";
import { validatedFile } from "./workspace-files.ts";

interface FileActionServices {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
  writeText(text: string): void;
}

export async function performFileAction(
  cwd: string,
  target: string,
  action: string,
  services: FileActionServices,
): Promise<void> {
  if (
    !target ||
    target.length > 8192 ||
    /[\0\r\n]/.test(target) ||
    !["open", "reveal", "copy-absolute", "copy-relative"].includes(action)
  )
    throw new Error("invalid_input: 文件操作无效");
  const path = resolve(cwd, target);
  if (!isAbsolute(target) && !isPathInside(resolve(cwd), path))
    throw new Error("invalid_input: 相对文件路径超出当前工作目录");
  if (action === "copy-absolute" || action === "copy-relative") {
    services.writeText(action === "copy-absolute" ? path : relative(cwd, path));
    return;
  }
  try {
    if (!(await stat(path)).isFile()) throw new Error("invalid_input: 仅支持打开文件");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`not_found: 文件不存在：${path}`);
    throw error;
  }
  if (!isAbsolute(target)) await validatedFile(cwd, target);
  if (action === "reveal") services.showItemInFolder(path);
  else {
    const failure = await services.openPath(path);
    if (failure) throw new Error(`storage: ${failure}`);
  }
}
