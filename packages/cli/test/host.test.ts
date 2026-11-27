import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  emptyAssistant,
  getCurrentTools,
  type TranscriptContext,
} from "@zpi-dev/ai";
import { ModelRuntime, SessionManager } from "@zpi-dev/coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { fakeConfig } from "../../../tests/fake-server.ts";
import { DirectoryHistory } from "../src/host/history.ts";
import { CliHost } from "../src/host/index.ts";
import { CliResources, fileContext } from "../src/host/resources.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

async function fixture() {
  const homeDir = await realpath(await mkdtemp(join(tmpdir(), "zpi-cli-host-test-")));
  cleanups.push(() => rm(homeDir, { recursive: true, force: true }));
  const cwd = join(homeDir, "project");
  const root = join(homeDir, ".zpi", "cli");
  await mkdir(cwd);
  const contexts: TranscriptContext[] = [];
  const accountsUsed: string[] = [];
  let active = "personal";
  const accounts = {
    selectModel: (explicit?: string, previous?: { accountId: string }) => {
      if (explicit && explicit !== "gateway/fake") throw new Error("Unknown test model");
      const accountId = previous?.accountId ?? active;
      const runtime = new ModelRuntime();
      runtime.registerProvider("alias", {
        models: [fakeConfig("")],
        streamSimple(model, context) {
          contexts.push(context);
          accountsUsed.push(accountId);
          const output = emptyAssistant(model);
          output.content = [{ type: "text", text: `turn ${contexts.length}` }];
          if (context.messages.at(-1)?.content === "phase-test")
            output.content = [
              { type: "text", phase: "commentary", text: "progress" },
              { type: "text", phase: "partial_answer", text: "draft" },
              { type: "text", phase: "final_answer", text: "delivered" },
            ];
          const stream = createAssistantMessageEventStream();
          stream.end(output);
          return stream;
        },
      });
      const model = runtime.getModel("alias", "fake");
      if (!model) throw new Error("Missing test model");
      return { runtime, model, binding: { provider: "gateway", modelId: model.id, accountId } };
    },
  };
  const options = { cwd, root, homeDir, accounts };
  const create = (overrides: Partial<ConstructorParameters<typeof CliHost>[0]> = {}) => {
    const host = new CliHost({ ...options, ...overrides });
    cleanups.push(() => host.close());
    return host;
  };
  return {
    ...options,
    create,
    contexts,
    accountsUsed,
    switchToWork: () => {
      active = "work";
    },
  };
}

it("creates history only after valid input, locks a single writer and restores the recorded account", async () => {
  const f = await fixture();
  const host = f.create();
  await host.setModel("gateway/fake");
  expect(await host.run("/help")).toContain("/init");
  for (const input of ["/review", "/commit", "/summary", "/compact", " "])
    await expect(host.run(input)).rejects.toThrow();
  expect(await host.listHistory()).toEqual([]);
  expect(await host.run("first turn")).toBe("turn 1");
  const [item] = await host.listHistory();
  expect(item.title).toBe("first turn");
  const competing = f.create();
  await expect(competing.resume(item.id)).rejects.toThrow("另一个进程");
  await host.close();
  f.switchToWork();
  await competing.resumeLatest();
  expect(await competing.run("again")).toBe("turn 2");
  expect(competing.getMessages().some((m) => m.role === "user" && m.content === "first turn")).toBe(true);
  await competing.setModel("gateway/fake");
  expect(await competing.run("use work")).toBe("turn 3");
  expect(f.accountsUsed).toEqual(["personal", "personal", "work"]);
  await competing.clear();
  expect(await competing.listHistory()).toHaveLength(1);
  expect(competing.getMessages()).toEqual([]);
  const alias = join(f.homeDir, "alias");
  await symlink(f.cwd, alias);
  await f.create({ cwd: alias }).resume(item.id);
  expect(await f.create({ cwd: f.homeDir }).listHistory()).toEqual([]);
});

it("previews incomplete live history without repairs and isolates a corrupt transcript", async () => {
  const f = await fixture();
  const host = f.create();
  await host.run("keep me");
  const [{ id }] = await host.listHistory();
  const history = new DirectoryHistory(f.root, f.cwd);
  const path = history.path(id);
  const before = await readFile(path, "utf8");
  await appendFile(path, "{");
  await writeFile(history.path("corrupt"), "invalid\n");
  expect((await host.listHistory()).find((item) => item.id === "corrupt")?.error).toBeTruthy();
  const second = f.create();
  await expect(second.resume(id)).rejects.toThrow("另一个进程");
  expect(await readFile(path, "utf8")).toBe(`${before}{`);
  await host.close();
  await second.resume(id);
  expect(await readFile(path, "utf8")).not.toMatch(/\{$/);
});

it("resumes the newest valid session without parsing older transcripts", async () => {
  const f = await fixture();
  const host = f.create();
  await host.run("older");
  const [older] = await host.listHistory();
  await host.clear();
  await host.run("newer");
  await host.close();
  const [newer] = (await host.listHistory()).filter((item) => item.id !== older.id);
  const history = new DirectoryHistory(f.root, f.cwd);
  const empty = SessionManager.create(f.cwd, join(history.directory, "sessions"), { id: "empty" });
  await empty.flushAsync();
  await writeFile(history.path("broken"), "invalid\n");
  for (const [index, id] of [older.id, newer.id, "empty", "broken"].entries()) {
    await utimes(history.path(id), index + 1, index + 1);
  }

  const preview = vi.spyOn(DirectoryHistory.prototype, "preview");
  try {
    const next = f.create();
    await next.resumeLatest();
    expect(preview.mock.calls.map(([id]) => id)).toEqual(["broken", "empty", newer.id, newer.id]);
    expect(next.getMessages().some((m) => m.role === "user" && m.content === "newer")).toBe(true);
  } finally {
    preview.mockRestore();
  }
});

it("shows the draft model for an effort choice and reselects the current default on submit", async () => {
  const f = await fixture();
  const host = f.create();
  const [effort] = await host.getEfforts();
  await host.setEffort(effort);
  expect(host.getSelection()).toEqual({ model: "gateway/fake", effort });
  f.switchToWork();
  const select = vi.spyOn(f.accounts, "selectModel");
  await host.run("first turn");
  expect(select).toHaveBeenCalledWith(undefined);
  expect(f.accountsUsed).toEqual(["work"]);
});

it("requires an explicit choice when old transcripts lack an account binding", async () => {
  const f = await fixture();
  const history = new DirectoryHistory(f.root, f.cwd);
  const id = randomUUID();
  const manager = SessionManager.create(f.cwd, join(history.directory, "sessions"), { id });
  manager.appendModelChange("alias", "fake");
  manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
  const host = f.create();
  await expect(host.resume(id)).rejects.toThrow("-m");
  const rebound = f.create({ model: "gateway/fake" });
  await rebound.resume(id);
  expect(await rebound.run("resume")).toBe("turn 1");
  expect(await rebound.listHistory()).toHaveLength(1);
});

it("ephemeral calls use native tools, expose only this turn and leave no resumable session", async () => {
  const f = await fixture();
  const host = f.create({ ephemeral: true });
  await writeFile(join(f.cwd, "notes.txt"), "data");
  await mkdir(join(f.cwd, "src"));
  expect(await host.run("use references", { filePaths: ["notes.txt", "src"] })).toBe("turn 1");
  const serialized = JSON.stringify(f.contexts[0]);
  expect(serialized).toContain("notes.txt");
  expect(serialized).toContain("src/");
  expect(
    getCurrentTools(f.contexts[0].messages)
      .map((t) => t.name)
      .sort(),
  ).toEqual(["bash", "edit", "read", "write"]);
  expect(await host.run("/tmp/x")).toBe("turn 2");
  expect(await host.run("/compact", { literal: true })).toBe("turn 3");
  expect(await host.run("/init consider tests")).toBe("turn 4");
  expect(JSON.stringify(f.contexts.at(-1)?.messages.at(-1))).toContain("AGENTS.md");
  expect(await host.run("phase-test")).toBe("delivered");
  expect(await host.listHistory()).toEqual([]);
  await host.close();
  await expect(readFile(join(f.root, "sessions"))).rejects.toHaveProperty("code", "ENOENT");
});

it("keeps skills explicit and enforces command provenance, priority, argument boundaries and print policy", async () => {
  const f = await fixture();
  const skills = join(f.cwd, ".agents", "skills", "testing");
  const project = join(f.cwd, ".zpi", "commands");
  const global = join(f.homeDir, ".zpi", "commands");
  for (const dir of [project, global, skills]) await mkdir(dir, { recursive: true });
  await writeFile(join(skills, "SKILL.md"), "---\ndescription: unit tests\n---\nSPECIAL SKILL BODY");
  await writeFile(join(f.cwd, "AGENTS.md"), "PROJECT INSTRUCTIONS");
  await writeFile(join(global, "DOC.md"), "user version");
  await writeFile(join(project, "doc.md"), "---\nskills: [testing]\n---\nproject argument=$1");
  await writeFile(join(project, "script.md"), "run !`echo forbidden`");
  await writeFile(join(project, "tty.md"), "---\ndisable-noninteractive: true\n---\ninteractive only");
  await symlink(join(global, "DOC.md"), join(project, "unregistered.md"));
  const host = f.create({ ephemeral: true });
  const resources = new CliResources(f.cwd, f.homeDir);
  expect((await host.listCommands()).map((c) => c.name)).toEqual(["doc"]);
  expect((await host.listSkills()).map((s) => s.name)).toEqual(["testing"]);
  await host.run("hello");
  expect(JSON.stringify(f.contexts[0])).toContain("PROJECT INSTRUCTIONS");
  expect(JSON.stringify(f.contexts[0])).not.toContain("unit tests");
  await host.run('/DOC "!\u0060literal\u0060"');
  expect(JSON.stringify(f.contexts[1])).toContain("SPECIAL SKILL BODY");
  expect(JSON.stringify(f.contexts[1])).toContain("project argument=!\u0060literal\u0060");
  const pending = await resources.prepare("/doc", {});
  await writeFile(join(project, "doc.md"), "replaced");
  await expect(pending.verify?.()).rejects.toThrow("更改");
  for (const [name, error] of [
    ["script", "桌面端"],
    ["tty", "交互模式"],
    ["unregistered", "unregistered"],
  ])
    await expect(host.run(`/${name}`)).rejects.toThrow(error);
  await writeFile(
    join(f.cwd, ".zpi", "command-state.json"),
    JSON.stringify({ version: 1, disabled: ["doc.md"] }),
  );
  await expect(host.run("/doc")).rejects.toThrow("禁用");
  await writeFile(join(f.cwd, ".zpi", "command-state.json"), "oops");
  await expect(host.run("/doc")).rejects.toThrow("command-state.json");
  expect(f.contexts).toHaveLength(2);
});

it("validates referenced images and rejects paths outside the real workspace", async () => {
  const f = await fixture();
  await symlink(f.homeDir, join(f.cwd, "outside"));
  await expect(fileContext(f.cwd, ["outside"])).rejects.toThrow("当前目录");
  await writeFile(join(f.cwd, "broken.png"), "not an image");
  await expect(fileContext(f.cwd, ["broken.png"])).rejects.toThrow();
  const sharp = (await import("sharp")).default;
  await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
    .png()
    .toFile(join(f.cwd, "pixel.png"));
  const context = await fileContext(f.cwd, ["pixel.png"]);
  expect(context.images?.[0].type).toBe("image");
});

it("prints the native manual compaction notification for this round only", async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, ".zpi"));
  await writeFile(
    join(f.cwd, ".zpi", "settings.json"),
    JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
  );
  const host = f.create();
  await host.run("earlier ".repeat(200));
  await host.run("latest");
  const printed = await host.run("/compact keep test decisions");
  expect(printed).toContain("上下文已压缩");
  expect(await host.run("/compact")).toContain("无需压缩");
});

it("releases the writer lock on process death without stale-owner detection or lock deletion", async () => {
  const f = await fixture();
  const host = f.create();
  await host.run("one writer");
  const [{ id }] = await host.listHistory();
  await host.close();
  const history = new DirectoryHistory(f.root, f.cwd);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked");
    setInterval(() => {}, 60000);
  `,
      join(history.directory, "locks", `${id}.sqlite`),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const exited = once(child, "close");
  try {
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => {
        throw new Error("Child exited before lock");
      }),
    ]);
    await expect(host.resume(id)).rejects.toThrow("另一个进程");
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  await host.resume(id);
  expect(await host.run("continue")).toBe("turn 2");
});

it("removes each ephemeral tool-output directory after both success and failure", async () => {
  const f = await fixture();
  const temp = join(f.homeDir, "tmp");
  await mkdir(temp);
  vi.stubEnv("TMPDIR", temp);
  try {
    for (let i = 0; i < 100; i++) {
      const host = f.create({ ephemeral: true });
      await host.run("temporary");
      const [work] = await readdir(temp);
      expect(work).toMatch(/^zpi-cli-/);
      const output = join(temp, work, "tool-output");
      await mkdir(output, { recursive: true });
      await writeFile(join(output, "snapshot"), "temporary output");
      await host.close();
      expect(await readdir(temp)).toEqual([]);
    }
    const failed = f.create({
      ephemeral: true,
      accounts: {
        selectModel() {
          const selected = f.accounts.selectModel();
          selected.runtime.clearProviders();
          return selected;
        },
      },
    });
    await expect(failed.run("failed call")).rejects.toThrow();
    await failed.close();
    expect(await readdir(temp)).toEqual([]);
    expect(await f.create().listHistory()).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});
