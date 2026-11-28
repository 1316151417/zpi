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

async function waitForFrame(ui, condition, label) {
  let rows;
  const deadline = Date.now() + 5000;
  do {
    const cells = await ui.screen();
    rows = cells.map((line) => line?.translateToString(true) ?? "");
    if (condition(rows)) return { rows, cells };
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`missing ${label} in rendered terminal:\n${rows.join("\n")}`);
}

const showsFooterModel = (id) => (rows) => rows.at(-1).trimEnd().endsWith(`  ${id}`);

async function waitForFooterModel(ui, id) {
  await ui.waitFor(`  ${id}`);
  return waitForFrame(ui, showsFooterModel(id), `footer model ${id}`);
}

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
  const open = (args = [], trackScreen = false) => {
    const ui = terminal(bin, args, { ...options, trackScreen });
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
  const empty = terminal("/bin/sh", ["-c", shell, "check-terminal", bin], {
    ...options,
    cwd: home,
    trackScreen: true,
  });
  t.after(empty.kill);
  await empty.waitFor("~");
  const footer = (await empty.screen())
    .slice(-2)
    .map((line) => line?.translateToString(true) ?? "")
    .join("\n");
  assert.doesNotMatch(footer, /Enter 发送|Ctrl\+J|Ctrl\+O/);
  empty.write("\x04");
  assert.equal((await empty.exit).exitCode, 0);
  assert.deepEqual(await historyFiles(), []);
  assert.equal((await call(["auth", "login", "anthropic", "--method", "key"], "never-a-key")).code, 2);

  await login(bin, options, { name: "team", variable: "TEST_PERSONAL", base: provider.url });
  const initial = await ok(["models"]);
  assert.deepEqual(initial.trimEnd().split("\n"), ["team/coder", "team/org/writer"]);
  assert.doesNotMatch(await ok(["auth", "list"]), /default/);
  assert.equal(await ok(["--list-models", "writer"]), "team/org/writer\n");
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

  const modelProject = join(root, "model-picker");
  await mkdir(modelProject);
  const visual = join(root, "test-editor");
  await writeFile(visual, '#!/bin/sh\nprintf "edited-in-terminal" >> "$1"\n', { mode: 0o700 });
  const modelUi = terminal(bin, [], {
    env: { ...env, VISUAL: visual },
    cwd: modelProject,
    trackScreen: true,
  });
  t.after(modelUi.kill);
  await waitForFooterModel(modelUi, "coder");
  modelUi.write("draft: ");
  modelUi.write("\x13");
  await modelUi.waitFor("草稿已暂存");
  modelUi.write("\x13");
  await modelUi.waitFor("draft:");
  modelUi.write("\x07");
  await modelUi.waitFor("edited-in-terminal");
  modelUi.write("\x03");
  modelUi.write("/login\r");
  await modelUi.waitFor("选择服务");
  modelUi.write("\x03");
  await waitForFooterModel(modelUi, "coder");
  modelUi.write("/login anthropic\r");
  await modelUi.waitFor("密钥来源");
  modelUi.write("\x03");
  await waitForFooterModel(modelUi, "coder");
  modelUi.write("/model writer\r");
  await modelUi.waitFor("仅显示已连接提供商的模型");
  await modelUi.waitFor("org/writer [team]");
  modelUi.write("\x13"); // save default with Ctrl+S
  await waitForFooterModel(modelUi, "org/writer");
  assert.equal(await ok(["-p", "saved model"]), "answer-org/writer\n");
  modelUi.write("/model team/coder\r");
  await waitForFooterModel(modelUi, "coder");
  modelUi.write("/fast\r");
  await modelUi.waitFor("加速");
  modelUi.write("show-thinking\r");
  await modelUi.waitFor("检查终端回放");
  await modelUi.waitFor("answer-coder");
  assert.equal(provider.requests.at(-1).body.service_tier, "priority");
  modelUi.write("\x14");
  await modelUi.waitFor("思考…");
  modelUi.write("\x14");
  await modelUi.waitFor("检查终端回放");
  modelUi.write("/rename 终端验证\r");
  await modelUi.waitFor("会话已命名为 终端验证");
  modelUi.write("/copy 1\r");
  await modelUi.waitFor("已向终端发送复制请求");
  assert.ok(modelUi.rawOutput().includes(`\x1b]52;c;${Buffer.from("answer-coder").toString("base64")}\x07`));
  modelUi.write("\x12");
  await modelUi.waitFor("搜索输入历史");
  modelUi.write("thinking\r");
  await modelUi.waitFor("show-thinking");
  modelUi.write("\x03");
  modelUi.write("\x04");
  assert.equal((await modelUi.exit).exitCode, 0);
  const renamed = terminal(bin, ["-r"], { ...options, cwd: modelProject });
  t.after(renamed.kill);
  await renamed.waitFor("终端验证");
  renamed.write("\x1b");
  await renamed.waitFor("────");
  renamed.write("\x04");
  assert.equal((await renamed.exit).exitCode, 0);
  assert.equal((await call(["-c", "-p", "continue fast"], "", modelProject)).stdout, "answer-coder\n");
  assert.equal(provider.requests.at(-1).body.service_tier, "priority");
  await ok(["models", "--default", "team/coder"]);

  const pickerHistory = await historyFiles();
  await writeFile(join(cwd, "notes.md"), "这是测试文件\n");
  const first = open(["exercise-tools"], true);
  await first.waitFor("answer-coder");
  await waitForFooterModel(first, "coder");
  assert.equal(await readFile(join(cwd, "proof.txt"), "utf8"), "after\n");
  first.write("\x0f");
  first.resize(75, 23);
  first.write("\x04");
  assert.equal((await first.exit).exitCode, 0);
  const [history] = (await historyFiles()).filter((file) => !pickerHistory.includes(file));
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

  const active = open(["-r", id], true);
  await waitForFooterModel(active, "coder");
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
    const reasoningUi = terminal(bin, ["-m", `${name}/coder`, "show-thinking"], {
      ...options,
      cwd: elsewhere,
      trackScreen: true,
    });
    t.after(reasoningUi.kill);
    const thought = name === "responses" ? "Responses 可见摘要" : "Anthropic 可见推理";
    await waitForFrame(
      reasoningUi,
      (rows) =>
        rows.some((line) => line.includes(thought)) &&
        rows.some((line) => line.includes("answer-coder")) &&
        !rows.some((line) => line.includes("运行中")),
      `visible thinking over ${name}`,
    );
    reasoningUi.write("\x04");
    assert.equal((await reasoningUi.exit).exitCode, 0);
  }
  await login(bin, options, {
    name: "manual",
    base: `${provider.url}/manual`,
    variable: "TEST_WORK",
    manual: true,
    effort: "high",
  });
  assert.equal(
    await ok(["-p", "-m", "manual/manual-test", "--effort", "high", "manual effort"]),
    "answer-manual-test\n",
  );
  assert.equal(provider.requests.at(-1).body.reasoning_effort, "high");
  const preview = open(["-m", "manual/manual-test"]);
  await preview.waitFor("manual-test • high");
  preview.write("\x04");
  assert.equal((await preview.exit).exitCode, 0);
  await ok(["models", "--default", "manual/manual-test"]);
  assert.equal(await ok(["-p", "new default"]), "answer-manual-test\n");
  await ok(["models", "--default", "team/coder"]);

  const ambiguous = open([], true);
  await ambiguous.waitFor("(team) coder");
  ambiguous.write("/model coder\r");
  await ambiguous.waitFor("仅显示已连接提供商的模型");
  await ambiguous.waitFor("coder [anth]");
  const inModelPicker = (rows) => rows.some((row) => row.includes("仅显示已连接提供商的模型"));
  await waitForFrame(ambiguous, inModelPicker, "ambiguous model choices");
  ambiguous.write("\x1b");
  await waitForFrame(ambiguous, (rows) => !inModelPicker(rows), "editor after canceling model choices");
  ambiguous.write("\x04");
  assert.equal((await ambiguous.exit).exitCode, 0);

  const ui = open(["-r"], true);
  const lastAnswer = (question) =>
    waitForFrame(
      ui,
      (rows) => {
        const asked = rows.findLastIndex((line) => line.includes(question));
        return (
          asked >= 0 &&
          rows.slice(asked + 1).some((line) => line.trim() === "answer-coder") &&
          !rows.some((line) => line.includes("运行中"))
        );
      },
      `answer following ${question}`,
    );
  await ui.waitFor("继续会话");
  ui.write("\r");
  await ui.waitFor("(team) coder");
  ui.write("@not");
  await ui.waitFor("notes.md");
  ui.write("\t");
  ui.write("\x1b[200~ 阅读下面的中文\n第二行\x1b[201~");
  ui.write("\r");
  await lastAnswer("第二行");
  assert.match(JSON.stringify(provider.requests.at(-1).body), /第二行/);
  const skillDir = join(cwd, ".agents", "skills", "proofread");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\ndescription: 校对正文\n---\nPROOFREAD BODY");
  ui.write("/");
  await ui.waitFor("/proofread");
  ui.write("proof");
  ui.write("\t");
  await ui.waitFor("/proofread ");
  ui.write("检查这一段\r");
  await lastAnswer("/proofread 检查这一段");
  const skillMessage = provider.requests.at(-1).body.messages.findLast((message) => message.role === "user");
  assert.match(JSON.stringify(skillMessage.content), /检查这一段/);
  assert.match(JSON.stringify(skillMessage.content), /PROOFREAD BODY/);
  ui.write("hold-this-request\r");
  await ui.waitFor("运行中");
  ui.write("\x1b");
  await ui.waitFor("已中断");
  ui.write("\x04");
  assert.equal((await ui.exit).exitCode, 0);
  const replay = open(["-r", id]);
  await replay.waitFor("/proofread 检查这一段");
  await replay.waitFor("(team) coder");
  assert.doesNotMatch(replay.output(), /PROOFREAD BODY|Required skill:/);
  replay.write("\x04");
  assert.equal((await replay.exit).exitCode, 0);
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

test("screen layout, help, inline Skills and command arguments in a real terminal", {
  timeout: 60_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zpi-screen-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, "sample");
  const skillDir = join(cwd, ".agents", "skills", "proofread");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\ndescription: Check a local sample sentence\n---\nSKILL_BODY_MARKER",
  );
  await mkdir(join(cwd, ".zpi", "commands"), { recursive: true });
  await writeFile(
    join(cwd, ".zpi", "commands", "quality.md"),
    "---\ndescription: Inspect the sample\nargument-hint: <path>\n---\nLook at $1.",
  );
  await writeFile(join(cwd, "demo.txt"), "private read output\nsecond line\n");
  const provider = await testProvider();
  t.after(() => provider.close());
  const options = {
    cwd,
    env: {
      HOME: home,
      TMPDIR: home,
      PATH: process.env.PATH,
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      TEST_KEY: "fixture",
    },
  };
  await login(bin, options, { name: "team", variable: "TEST_KEY", base: provider.url });
  const printed = await invoke(bin, ["-p", "/help"], options);
  assert.equal(printed.code, 0);
  assert.match(printed.stdout, /\/quality <path>/);
  assert.doesNotMatch(printed.stdout, /proofread|SKILL_BODY_MARKER/);
  const ui = terminal(bin, [], { ...options, trackScreen: true });
  t.after(ui.kill);

  const frame = (condition, label) => waitForFrame(ui, condition, label);
  const has = (text) => (rows) => rows.some((row) => row.includes(text));
  const draft = (text) => (rows) => rows.some((row) => row.trimStart().startsWith(text));
  const initial = await frame(
    (rows) => showsFooterModel("coder")(rows) && has("ZPI")(rows),
    "wordmark and bottom model",
  );
  assert.deepEqual(
    initial.rows
      .slice(0, -5)
      .map((line) => line.trim())
      .filter(Boolean),
    ["ZPI"],
  );
  assert.ok(initial.rows.at(-2).includes("~/sample"), initial.rows.slice(-2).join("\n"));
  const header = initial.cells[initial.rows.findIndex((line) => line.trim() === "ZPI")];
  const firstLetter = header.translateToString(true).indexOf("ZPI");
  for (let i = firstLetter; i < firstLetter + 3; i++) assert.equal(header.getCell(i).getFgColor(), 0xf2be57);

  ui.write("/help\r");
  await frame(has("Tab 切页"), "help panel");
  ui.write("\t");
  const help = await frame(has("/rename <会话名称>"), "command usage");
  assert.doesNotMatch(help.rows.join("\n"), /proofread|Check a local sample sentence/);
  ui.write("\x1b");
  await frame((rows) => !has("Tab 切页")(rows) && showsFooterModel("coder")(rows), "closed help");

  ui.write("/skills\r");
  await frame(has("选择 Skill"), "Skill picker");
  ui.write("\r");
  await frame(draft("/proofread"), "Skill in composer");
  ui.write("检查文字");
  const { cells } = await frame(draft("/proofread 检查文字"), "inline Skill with arguments");
  const row = cells.find((line) =>
    line?.translateToString(true).trimStart().startsWith("/proofread 检查文字"),
  );
  const skillStart = row.translateToString(true).indexOf("/proofread");
  assert.notEqual(row.getCell(skillStart).getFgColor(), row.getCell(skillStart + 11).getFgColor());
  assert.equal(row.getCell(skillStart).getFgColor(), row.getCell(skillStart + 9).getFgColor());
  ui.write("\x03");
  ui.write("/rename ");
  await frame(
    (rows) => rows.some((row) => row.trimStart().startsWith("/rename ") && row.includes("会话名称")),
    "argument hint in editor",
  );
  ui.write("\r");
  await frame(has("重命名会话"), "rename form");
  ui.write("样例标题\r");
  await frame(
    (rows) => rows.some((row) => row.includes("ℹ") && row.includes("会话已命名为 样例标题")),
    "system confirmation",
  );
  assert.equal(provider.requests.length, 0);

  ui.write("exercise-layout\r");
  const answer = await frame(has("Final line."), "complete answer");
  const lines = answer.rows.map((row) => row.trim());
  const start = lines.indexOf("exercise-layout");
  assert.ok(start >= 0, "the complete turn fits in a 34-row terminal");
  assert.deepEqual(lines.slice(start, start + 19), [
    "exercise-layout",
    "",
    "",
    "Reason one",
    "",
    "- note",
    "",
    "Checking the sample.",
    "",
    "",
    "read demo.txt",
    "",
    "",
    "Heading",
    "",
    "A first paragraph.",
    "",
    "Second paragraph:",
    "- line one",
  ]);
  assert.ok(lines.includes("```ts"));
  assert.ok(lines.includes("const ok = true;"));
  assert.doesNotMatch(lines.join("\n"), /private read output|✻ 用时/);
  const thoughtLine = answer.cells.find((line) => line?.translateToString(true).trim() === "Reason one");
  const thoughtCol = thoughtLine.translateToString(true).indexOf("Reason");
  assert.ok(thoughtLine.getCell(thoughtCol).isItalic(), "thinking is italic");
  const userLine = answer.cells[start];
  assert.equal(userLine.getCell(0).getBgColor(), 0x212c4f);
  assert.equal(userLine.getCell(109).getBgColor(), 0x212c4f);
  ui.write("\x0f");
  await frame(
    (rows) => has("private read output")(rows) && has("Reason one")(rows),
    "expanded Read with visible thinking",
  );
  ui.write("\x14");
  await frame(
    (rows) => has("思考…")(rows) && !has("Reason one")(rows) && has("private read output")(rows),
    "thinking hidden while Read stays expanded",
  );
  ui.write("\x0f");
  await frame(
    (rows) => has("read demo.txt")(rows) && !has("private read output")(rows) && has("思考…")(rows),
    "tools collapsed independently",
  );

  ui.write("/rename\r");
  await frame(
    (rows) => rows.some((row) => row.includes("名称") && row.includes("样例标题")),
    "current name in form",
  );
  ui.write("\x1b");
  await frame((rows) => !has("重命名会话")(rows), "rename cancelled");
  ui.write("\x04");
  assert.equal((await ui.exit).exitCode, 0);

  const resumed = terminal(bin, ["-c"], { ...options, trackScreen: true });
  t.after(resumed.kill);
  await resumed.waitFor("思考…");
  await resumed.waitFor("Final line.");
  assert.doesNotMatch(resumed.output(), /Reason one|private read output/);
  resumed.write("\x14");
  await resumed.waitFor("Reason one");
  const callsBeforeHelp = provider.requests.length;
  resumed.write("/hotkeys\r");
  await waitForFrame(
    resumed,
    (rows) => rows.some((row) => row.includes("显示或收起思考")),
    "shortcut reference in the transcript",
  );
  assert.equal(provider.requests.length, callsBeforeHelp);
  resumed.write("\x04");
  assert.equal((await resumed.exit).exitCode, 0);
});
