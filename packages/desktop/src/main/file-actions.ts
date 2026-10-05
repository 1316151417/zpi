import { stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { localFileCandidate, resolveLocalFilePath, validateFileLocation } from "./local-file-path.ts";

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
  input?: unknown,
): Promise<void> {
  if (
    !target ||
    target.length > 8192 ||
    /[\0\r\n]/.test(target) ||
    !["open", "reveal", "copy-absolute", "copy-relative"].includes(action)
  )
    throw new Error("invalid_input: 文件操作无效");
  const location = validateFileLocation(input);
  const bounded = location?.relative || !isAbsolute(target);
  const path = localFileCandidate(cwd, target, bounded);
  if (action === "copy-absolute" || action === "copy-relative") {
    services.writeText(action === "copy-absolute" ? path : relative(cwd, path) || ".");
    return;
  }
  const actual = await resolveLocalFilePath(cwd, target, bounded);
  const info = await stat(actual);
  const directory = info.isDirectory();
  if (!info.isFile() && !directory) throw new Error("invalid_input: 仅支持打开文件及文件夹");
  if (action === "reveal" && !directory) services.showItemInFolder(path);
  else {
    const failure = await services.openPath(path);
    if (failure) throw new Error(`storage: ${failure}`);
  }
}
