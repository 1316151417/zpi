import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type HookInvocation, HookRunner } from "zpi-coding-agent";
import { assertExternalPlugin, bindExternalPlugin, importLocalPlugin } from "../src/index.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(script: string, event = "SessionStart", extras: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zpi-plugin-compat-"));
  directories.push(dir);
  const source = join(dir, "source"),
    storage = join(dir, "plugins"),
    cwd = join(dir, "work");
  await mkdir(join(source, ".claude-plugin"), { recursive: true });
  await mkdir(cwd);
  await writeFile(
    join(source, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "sample",
      version: "1.0",
      hooks: {
        [event]: [
          {
            ...(event.includes("ToolUse") ? { matcher: "Bash" } : {}),
            hooks: [
              {
                type: "process",
                command: process.execPath,
                // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture tests literal plugin variables.
                args: ["${CLAUDE_PLUGIN_ROOT}/hook.mjs"],
                ...extras,
              },
            ],
          },
        ],
      },
    }),
  );
  await writeFile(join(source, "hook.mjs"), script);
  return { dir, source, storage, cwd, import: () => importLocalPlugin(source, storage) };
}
function runner(snapshot: Awaited<ReturnType<typeof importLocalPlugin>>, storage: string) {
  return new HookRunner(bindExternalPlugin(snapshot, { storage }).hooks ?? []);
}
const stdin =
  "let text = ''; for await (const chunk of process.stdin) text += chunk; const input = JSON.parse(text);\n";

test("import and preview stay inert; frozen startup hooks receive Claude/ZCode aliases and variables", async () => {
  const f = await fixture(
    stdin +
      `await import('node:fs/promises').then(fs => fs.writeFile(process.env.CLAUDE_PROJECT_DIR + '/executed', 'yes')); console.log(JSON.stringify({hookSpecificOutput:{hookEventName: input.hook_event_name, additionalContext: input.session_id + ':' + process.env.CLAUDE_PLUGIN_ROOT + ':' + process.env.ZCODE_PLUGIN_ROOT}}));`,
  );
  const snapshot = await f.import();
  bindExternalPlugin(snapshot, { storage: f.storage });
  await expect(access(join(f.cwd, "executed"))).rejects.toThrow();
  await writeFile(join(f.source, "hook.mjs"), "throw new Error('new source must not affect frozen plugin')");
  const result = await runner(snapshot, f.storage).run({
    event: "SessionStart",
    sessionId: "session",
    cwd: f.cwd,
    source: "startup",
  });
  expect(result.additionalContexts).toEqual([`session:${snapshot.options?.root}:${snapshot.options?.root}`]);
  expect(await readFile(join(f.cwd, "executed"), "utf8")).toBe("yes");
});

test("Bash matcher aliases and replacement inputs use the existing core validation path", async () => {
  const f = await fixture(
    stdin +
      `console.log(JSON.stringify({hookSpecificOutput:{hookEventName: input.hook_event_name, updatedInput: {command: input.tool_name + ':' + input.tool_input.command}}}));`,
    "PreToolUse",
  );
  const snapshot = await f.import();
  const input: HookInvocation = {
    event: "PreToolUse",
    sessionId: "s",
    cwd: f.cwd,
    toolCallId: "call",
    toolName: "bash",
    toolInput: { command: "original" },
  };
  const result = await runner(snapshot, f.storage).run(input, undefined, (value) => value);
  expect(result.updatedInput).toEqual({ command: "Bash:original" });
});

test("exit two stderr blocks prompts while malformed output or modified cache cannot bypass a pre hook", async () => {
  const f = await fixture("console.error('policy denial'); process.exit(2)", "UserPromptSubmit");
  const snapshot = await f.import();
  const denied = await runner(snapshot, f.storage).run({
    event: "UserPromptSubmit",
    sessionId: "s",
    cwd: f.cwd,
    prompt: "blocked",
  });
  expect(denied).toMatchObject({ block: true, reason: "policy denial" });
  const pre = await fixture("console.log('{broken')", "PreToolUse");
  const original = await pre.import();
  const input: HookInvocation = {
    event: "PreToolUse",
    sessionId: "s",
    cwd: pre.cwd,
    toolCallId: "c",
    toolName: "bash",
    toolInput: {},
  };
  expect((await runner(original, pre.storage).run(input)).block).toBe(true);
  await writeFile(join(String(original.options?.root), "hook.mjs"), "console.log('{}')");
  expect(() => assertExternalPlugin(original, pre.storage, true)).toThrow("缓存内容已改变");
  expect((await runner(original, pre.storage).run(input)).block).toBe(true);
});

test("timeout and cancellation terminate the command process before returning", async () => {
  const f = await fixture(
    `import fs from 'node:fs'; fs.writeFileSync(process.env.CLAUDE_PROJECT_DIR + '/pid', String(process.pid)); setInterval(() => {}, 1000);`,
    "PreToolUse",
    { timeoutMs: 100 },
  );
  const snapshot = await f.import();
  const input: HookInvocation = {
    event: "PreToolUse",
    sessionId: "s",
    cwd: f.cwd,
    toolCallId: "c",
    toolName: "bash",
    toolInput: {},
  };
  expect((await runner(snapshot, f.storage).run(input)).block).toBe(true);
  const pid = Number(await readFile(join(f.cwd, "pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  const abort = new AbortController();
  abort.abort(new Error("user cancelled"));
  await expect(runner(snapshot, f.storage).run(input, abort.signal)).rejects.toThrow("user cancelled");
});

test("output budgets stop noisy commands without injecting partial output", async () => {
  const f = await fixture(
    "process.stdout.write('x'.repeat(200000)); setInterval(() => {}, 1000)",
    "PreToolUse",
  );
  const snapshot = await f.import();
  expect(
    await runner(snapshot, f.storage).run({
      event: "PreToolUse",
      sessionId: "s",
      cwd: f.cwd,
      toolCallId: "c",
      toolName: "bash",
      toolInput: {},
    }),
  ).toMatchObject({ block: true, additionalContexts: [] });
});

test("commands and skills receive namespaces, literal arguments and stable plugin asset paths", async () => {
  const f = await fixture("", "SessionStart");
  await mkdir(join(f.source, "commands"));
  await mkdir(join(f.source, "skills", "review"), { recursive: true });
  await writeFile(
    join(f.source, "commands", "review.md"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture tests literal plugin variables.
    "---\ndescription: Review code\n---\nReview $ARGUMENTS in ${CLAUDE_PLUGIN_ROOT}",
  );
  await writeFile(
    join(f.source, "skills", "review", "SKILL.md"),
    "---\ndescription: Review a project\n---\nRead assets beside this skill.",
  );
  const snapshot = await f.import();
  expect(snapshot.commands?.[0]).toMatchObject({
    name: "sample:review",
    prompt: `Review {{arguments}} in ${snapshot.options?.root}`,
  });
  expect(snapshot.skills?.[0]).toMatchObject({
    name: "sample:review",
    body: "Read assets beside this skill.",
    baseDir: join(String(snapshot.options?.root), "skills", "review"),
  });
});

test.each([{ async: true }, { type: "http", url: "https://example.test" }, { if: "Bash(rm *)" }])(
  "unsupported hook declarations fail at import (%s)",
  async (extras) => {
    const f = await fixture("", "PreToolUse", extras);
    await expect(f.import()).rejects.toThrow(/只支持|暂不支持/);
  },
);

test("manifest precedence, escaping paths, MCP and symlinks are validated before import", async () => {
  const f = await fixture("");
  await mkdir(join(f.source, ".zcode-plugin"));
  const manifest = join(f.source, ".zcode-plugin", "plugin.json");
  await writeFile(manifest, JSON.stringify({ name: "zcode-wins", version: "2" }));
  expect((await f.import()).id).toBe("local.zcode-wins");
  await writeFile(manifest, JSON.stringify({ name: "bad", hooks: "../outside.json" }));
  await expect(f.import()).rejects.toThrow("组件路径必须位于插件内");
  await writeFile(manifest, JSON.stringify({ name: "bad", mcpServers: {} }));
  await expect(f.import()).rejects.toThrow("mcpServers");
  await writeFile(manifest, JSON.stringify({ name: "safe" }));
  await symlink(join(f.source, "hook.mjs"), join(f.source, "linked"));
  await expect(f.import()).rejects.toThrow("符号链接");
});
