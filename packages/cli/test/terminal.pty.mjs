import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { testProvider } from "./fixtures/provider.mjs";
import { invoke, login, terminal } from "./fixtures/terminal.mjs";

const bin = process.env.ZPI_TEST_BIN ?? fileURLToPath(new URL("../bin/zpi.mjs", import.meta.url));

test("real terminal, isolated providers, persistent sessions and clean pipes", {
  timeout: 210000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zpi-terminal-test-"));
  const desktop = join(root, "desktop-private");
  await mkdir(desktop, { mode: 0o000 });
  t.after(async () => {
    await chmod(desktop, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  const provider = await testProvider();
  t.after(() => provider.close());
  const cwd = join(root, "project");
  const temp = join(root, "tmp");
  const home = join(root, "home");
  const elsewhere = join(root, "other");
  await Promise.all([cwd, temp, home, elsewhere].map((path) => mkdir(path)));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: temp,
    ZPI_DATA_DIR: desktop,
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    TEST_PERSONAL: "fixture-personal",
    TEST_WORK: "fixture-work",
    OPENAI_CUSTOM_HEADERS: "X-Unbound-Header: unrelated-openai-account",
    ANTHROPIC_CUSTOM_HEADERS: "X-Unbound-Header: unrelated-anthropic-account",
    OPENAI_LOG: "debug",
    ANTHROPIC_LOG: "debug",
  };
  await mkdir(join(cwd, ".zpi"));
  await writeFile(
    join(cwd, ".zpi", "settings.json"),
    JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
  );
  const options = { env, cwd };
  const historyFiles = async () =>
    (
      await readdir(join(home, ".zpi", "cli"), { recursive: true }).catch((err) => {
        if (err.code === "ENOENT") return [];
        throw err;
      })
    ).filter((f) => f.endsWith(".jsonl"));
  const call = (args, stdin, dir = cwd) => invoke(bin, args, { ...options, cwd: dir }, stdin);
  const ok = async (args, stdin, dir) => {
    const result = await call(args, stdin, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  const open = (args = []) => {
    const ui = terminal(bin, args, options);
    t.after(ui.kill);
    return ui;
  };
  assert.match(await ok(["--help"]), /zpi auth switch/);
  assert.match(await ok(["--version"]), /^\d+\.\d+\.\d+\n$/);
  for (const flags of [[], ["-p"], ["-r", "-p"], ["-c", "-r"], ["--unknown"]]) {
    const result = await call(flags);
    assert.equal(result.code, 2, JSON.stringify(flags) + result.stderr);
    assert.equal(result.stdout, "");
  }
  // Compare the POSIX tty mode, including echo and canonical input, after the binary exits.
  const shell =
    'before=$(stty -g) || exit 95; "$1" || exit $?; after=$(stty -g) || exit 96; test "$before" = "$after" || exit 97';
  const empty = terminal("/bin/sh", ["-c", shell, "check-terminal", bin], options);
  t.after(empty.kill);
  await empty.waitFor("Enter 发送");
  empty.write("\x04");
  assert.equal((await empty.exit).exitCode, 0);
  assert.deepEqual(await historyFiles(), []);
  assert.equal((await call(["auth", "login", "anthropic", "--method", "key"], "never-a-key")).code, 2);

  await login(bin, options, { name: "team", variable: "TEST_PERSONAL", base: provider.url, multiple: true });
  const initial = await ok(["models"]);
  assert.match(initial, /team\/coder/);
  assert.match(initial, /team\/org\/writer/);
  const unknown = await call(["-p", "/review"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /未知命令/);
  assert.equal(provider.requests.length, 0);
  assert.equal(
    await ok(["-p", "-m", "team/org/writer", "用中文回答"], "first\nsecond"),
    "answer-org/writer\n",
  );
  assert.match(JSON.stringify(provider.requests.at(-1).body), /用中文回答\\n\\nfirst\\nsecond/u);
  assert.equal(provider.requests.at(-1).authorization, "Bearer fixture-personal");
  assert.deepEqual(await historyFiles(), []);

  await writeFile(join(cwd, "notes.md"), "这是测试文件\n");
  const first = open(["exercise-tools"]);
  await first.waitFor("answer-coder");
  await first.waitFor("Enter 发送");
  assert.equal(await readFile(join(cwd, "proof.txt"), "utf8"), "after\n");
  first.write("\x0f");
  first.resize(75, 23);
  first.write("\x04");
  assert.equal((await first.exit).exitCode, 0);
  const [history] = await historyFiles();
  assert.ok(history);
  const id = history
    .split("/")
    .at(-1)
    .replace(/\.jsonl$/, "");
  assert.equal(await ok(["-r", id, "-p", "continue"]), "answer-coder\n");
  const alias = join(root, "linked-project");
  await symlink(cwd, alias);
  assert.equal(await ok(["-c", "-p", "continue"], "", alias), "answer-coder\n");
  assert.equal((await call(["-c", "-p", "test"], "", elsewhere)).code, 1);
  assert.equal((await call(["-r", id, "-p", "test"], "", elsewhere)).code, 1);

  const active = open(["-r", id]);
  await active.waitFor("Enter 发送");
  const conflict = await call(["-c", "-p", "busy"]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /占用|另一个进程/);
  active.kill();
  await active.exit;
  assert.equal(await ok(["-c", "-p", "after lock release"]), "answer-coder\n");

  await login(bin, options, { name: "team", account: "work", variable: "TEST_WORK", existing: true });
  assert.match(await ok(["auth", "list"]), /work/);
  await ok(["auth", "switch", "team", "work"]);
  await ok(["-c", "-p", "preserve billing"]);
  assert.equal(provider.requests.at(-1).authorization, "Bearer fixture-personal");
  await ok(["-p", "fresh billing"]);
  assert.equal(provider.requests.at(-1).authorization, "Bearer fixture-work");
  await ok(["-c", "-m", "team/coder", "-p", "explicit billing"]);
  assert.equal(provider.requests.at(-1).authorization, "Bearer fixture-work");
  const action = await ok(["-c", "-p", "/compact"]);
  assert.ok(action.trim());
  assert.notEqual(action, "answer-coder\n");

  for (const [name, protocol, path] of [
    ["responses", 1, "/responses"],
    ["anth", 2, "/messages"],
  ]) {
    await login(bin, options, { name, base: provider.url, protocol, variable: "TEST_WORK" });
    assert.equal(await ok(["-p", "-m", `${name}/coder`, "test"]), "answer-coder\n");
    assert.ok(provider.requests.at(-1).url.includes(path));
    assert.ok(provider.requests.at(-1).authorization.endsWith("fixture-work"));
  }
  await login(bin, options, {
    name: "manual",
    base: `${provider.url}/manual`,
    variable: "TEST_WORK",
    manual: true,
  });
  await ok(["models", "--default", "manual/manual-test"]);
  assert.equal(await ok(["-p", "new default"]), "answer-manual-test\n");
  await ok(["models", "--default", "team/coder"]);

  const ui = open(["-r"]);
  await ui.waitFor("继续会话");
  ui.write("\r");
  await ui.waitFor("Enter 发送");
  ui.write("@not");
  await ui.waitFor("notes.md");
  ui.write("\t");
  ui.write("\x1b[200~ 阅读下面的中文\n第二行\x1b[201~");
  ui.write("\r");
  await ui.waitFor("answer-coder");
  await ui.waitFor("Enter 发送");
  assert.match(JSON.stringify(provider.requests.at(-1).body), /第二行/);
  ui.write("hold-this-request\r");
  await ui.waitFor("Esc 中断");
  ui.write("\x1b");
  await ui.waitFor("已中断");
  ui.write("\x04");
  assert.equal((await ui.exit).exitCode, 0);
  const interrupted = spawn(bin, ["-p", "hold-this-request"], {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const status = new Promise((resolve) => interrupted.once("close", resolve));
  t.after(() => {
    if (interrupted.exitCode === null) interrupted.kill("SIGKILL");
  });
  const limit = Date.now() + 5000;
  const before = provider.requests.length;
  while (provider.requests.length <= before && Date.now() < limit) await delay(25);
  assert.ok(provider.requests.length > before);
  interrupted.kill("SIGINT");
  assert.equal(await status, 130);

  const prior = await historyFiles();
  // Run all 100 through separate processes so startup, private tmpdirs and cleanup are exercised.
  for (let i = 0; i < 100; i += 5) {
    const outputs = await Promise.all(Array.from({ length: 5 }, (_, n) => ok(["-p", `short ${i + n}`])));
    assert.ok(outputs.every((result) => result === "answer-coder\n"));
  }
  assert.deepEqual(await historyFiles(), prior);
  assert.deepEqual(
    (await readdir(temp)).filter((f) => f.startsWith("zpi-cli-")),
    [],
  );
  const cancel = open(["auth", "login"]);
  await cancel.waitFor("服务");
  cancel.write("\x03");
  assert.equal((await cancel.exit).exitCode, 130);
  const logout = open(["auth", "logout"]);
  await logout.waitFor("移除哪个 CLI 连接");
  logout.write("\x1b[B\r");
  assert.equal((await logout.exit).exitCode, 0);
  const removed = await call(["-c", "-p", "removed account"]);
  assert.equal(removed.code, 1);
  await ok(["auth", "switch", "team", "default"]);
  assert.equal(await ok(["-c", "-p", "-m", "team/coder", "rebind"]), "answer-coder\n");
  assert.ok(provider.requests.every((r) => !r.injectedHeader));
  const early = spawn(bin, ["-p", "closed pipe"], { ...options, stdio: ["ignore", "pipe", "pipe"] });
  early.stdout.destroy();
  assert.equal(await new Promise((resolve) => early.once("close", resolve)), 0);
  const readOnly = await openFile(join(cwd, "notes.md"), "r");
  try {
    const failed = spawnSync(bin, ["-p", "/help"], { ...options, stdio: ["ignore", readOnly.fd, "pipe"] });
    assert.equal(failed.status, 1, String(failed.stderr));
    assert.match(String(failed.stderr), /EBADF/);
  } finally {
    await readOnly.close();
  }
});
