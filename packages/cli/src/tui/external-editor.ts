import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function editDraft(text: string, signal?: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "zpi-cli-editor-"));
  try {
    const path = join(directory, "prompt.md");
    await writeFile(path, text, { mode: 0o600 });
    // VISUAL and EDITOR can include options. Pass the draft path as a separate shell argument.
    const command = process.env.VISUAL?.trim() || process.env.EDITOR?.trim() || "vi";
    const child = spawn("/bin/sh", ["-c", `exec ${command} "$1"`, "zpi-cli", path], {
      stdio: "inherit",
      signal,
    });
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error("外部编辑器未正常退出，已保留原草稿。");
    return (await readFile(path, "utf8")).replace(/\r\n/g, "\n").replace(/\n$/, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
