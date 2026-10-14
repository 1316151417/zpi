import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { deferred } from "../../../tests/fake-server.ts";
import { createEditTool, createWriteTool } from "../src/core/tools/index.ts";
import { withFileMutationQueue } from "../src/core/tools/pi/file-mutation-queue.ts";
import { createWriteToolDefinition } from "../src/core/tools/pi/write.ts";
import { temp } from "./helpers/workspace-fixture.ts";

for (const suffix of ["new.txt", "missing/nested/new.txt", "existing.txt"]) {
  it(`serializes directory aliases for ${suffix} without blocking unrelated files`, async () => {
    const cwd = await temp();
    const real = join(cwd, "real"),
      alias = join(cwd, "alias");
    await mkdir(real);
    await symlink(real, alias, "junction");
    if (suffix === "existing.txt") await writeFile(join(real, suffix), "original");
    const entered = deferred(),
      release = deferred();
    const order: string[] = [];
    const first = withFileMutationQueue(join(real, suffix), async () => {
      order.push("first");
      entered.resolve();
      await release.promise;
      await mkdir(dirname(join(real, suffix)), { recursive: true });
      await writeFile(join(real, suffix), "first");
    });
    await entered.promise;
    const second = withFileMutationQueue(join(alias, suffix), async () => {
      order.push("second");
      await mkdir(dirname(join(alias, suffix)), { recursive: true });
      await writeFile(join(alias, suffix), "second");
    });
    try {
      await withFileMutationQueue(join(cwd, "unrelated"), async () => {
        order.push("independent");
      });
      expect(order).toEqual(["first", "independent"]);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    expect(order).toEqual(["first", "independent", "second"]);
    expect(await readFile(join(real, suffix), "utf8")).toBe("second");
  });
}

it("local writes reject non-directory ancestors without stranding later mutations", async () => {
  const cwd = await temp();
  await writeFile(join(cwd, "file"), "text");
  await expect(
    createWriteToolDefinition(cwd).execute("local", { path: "file/nested/child", content: "invalid" }),
  ).rejects.toMatchObject({ code: "ENOTDIR" });
  await expect(withFileMutationQueue(join(cwd, "file/nested/child"), async () => "released")).resolves.toBe(
    "released",
  );
  await expect(withFileMutationQueue(join(cwd, "other"), async () => "released")).resolves.toBe("released");
});

it("custom remote writes and edits do not inherit incompatible local ancestors", async () => {
  const cwd = await temp();
  await writeFile(join(cwd, "remote-directory"), "This is only a file on the local filesystem");
  const path = "remote-directory/file.txt";
  const absolutePath = join(cwd, path);
  const remote = new Map<string, string>();
  const directories: string[] = [];
  const writeRemote = async (file: string, content: string) => {
    remote.set(file, content);
  };
  const write = createWriteTool(cwd, {
    operations: { mkdir: async (dir) => void directories.push(dir), writeFile: writeRemote },
  });
  const written = await write.execute("write", { path, content: "original text" });
  expect(written.details).toBeUndefined();
  expect(directories).toEqual([join(cwd, "remote-directory")]);
  expect(remote.get(absolutePath)).toBe("original text");
  const edit = createEditTool(cwd, {
    operations: {
      access: async () => {},
      readFile: async (file) => Buffer.from(remote.get(file) ?? ""),
      writeFile: writeRemote,
    },
  });
  const edited = await edit.execute("edit", { path, edits: [{ oldText: "original", newText: "edited" }] });
  expect(edited.details).not.toHaveProperty("fileChange");
  expect(remote.get(absolutePath)).toBe("edited text");
  expect(await readFile(join(cwd, "remote-directory"), "utf8")).toContain("only a file");
});

for (const kind of ["file", "directory"] as const) {
  it.skipIf(process.platform === "win32")(
    `serializes a dangling ${kind} symlink with a relative target`,
    async () => {
      const cwd = await temp();
      await mkdir(join(cwd, "real"));
      await mkdir(join(cwd, "aliases"));
      const link = join(cwd, "aliases", "link");
      const target = join(cwd, "real", kind === "file" ? "new.txt" : "missing/nested/new.txt");
      await symlink(
        kind === "file" ? "../real/new.txt" : "../real/missing",
        link,
        kind === "file" ? "file" : "dir",
      );
      // A second relative dangling link verifies that expansion retains the suffix.
      const outer = join(cwd, "aliases", "outer");
      await symlink("link", outer, kind === "file" ? "file" : "dir");
      const alias = kind === "file" ? outer : join(outer, "nested", "new.txt");
      const entered = deferred(),
        release = deferred();
      const order: string[] = [];
      const first = withFileMutationQueue(target, async () => {
        order.push("first");
        entered.resolve();
        await release.promise;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, "first");
      });
      await entered.promise;
      const second = withFileMutationQueue(alias, async () => {
        order.push("second");
        await writeFile(alias, "second");
      });
      try {
        await withFileMutationQueue(join(cwd, "other"), async () => {
          order.push("independent");
        });
        expect(order).toEqual(["first", "independent"]);
      } finally {
        release.resolve();
        await Promise.all([first, second]);
      }
      expect(order).toEqual(["first", "independent", "second"]);
      expect(await readFile(target, "utf8")).toBe("second");
    },
  );
}

it.skipIf(process.platform === "win32")(
  "rejects symlink cycles and releases the registration queue",
  async () => {
    const cwd = await temp();
    await symlink("b", join(cwd, "a"));
    await symlink("a", join(cwd, "b"));
    await expect(withFileMutationQueue(join(cwd, "a"), async () => {})).rejects.toMatchObject({
      code: "ELOOP",
    });
    await expect(withFileMutationQueue(join(cwd, "other"), async () => "released")).resolves.toBe("released");
  },
);
