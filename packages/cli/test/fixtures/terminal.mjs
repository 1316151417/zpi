import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import xterm from "@xterm/xterm";
import { spawn as openPty } from "node-pty";

export function invoke(bin, args, options, input = "") {
  const child = spawn(bin, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", (err) => {
    if (err.code !== "EPIPE") throw err;
  });
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function terminal(bin, args, { trackScreen, ...options }) {
  const screen = trackScreen
    ? new xterm.Terminal({ cols: 110, rows: 34, allowProposedApi: true })
    : undefined;
  const pty = openPty(bin, args, { ...options, cols: 110, rows: 34, name: "xterm-256color" });
  let output = "";
  let cursor = 0;
  let ended = false;
  let wake;
  pty.onData((chunk) => {
    output += chunk;
    screen?.write(chunk);
    wake?.();
  });
  const exit = new Promise((resolve) =>
    pty.onExit((result) => {
      ended = true;
      wake?.();
      resolve(result);
    }),
  );
  async function waitFor(needle) {
    const deadline = Date.now() + 10000;
    for (;;) {
      const fresh = stripVTControlCharacters(output).slice(cursor);
      if (fresh.includes(needle)) {
        cursor += fresh.indexOf(needle) + needle.length;
        return;
      }
      assert(!ended && Date.now() < deadline, `missing "${needle}" in PTY output: ${fresh.slice(-1400)}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  }
  return {
    waitFor,
    write: (data) => pty.write(data),
    resize: (cols, rows) => {
      pty.resize(cols, rows);
      screen?.resize(cols, rows);
    },
    exit,
    output: () => stripVTControlCharacters(output),
    rawOutput: () => output,
    screen: async () => {
      assert.ok(screen, "trackScreen must be enabled to inspect rendered rows");
      await new Promise((done) => screen.write("", done));
      return Array.from({ length: screen.rows }, (_, i) =>
        screen.buffer.active.getLine(screen.buffer.active.viewportY + i),
      );
    },
    kill: () => {
      if (!ended) pty.kill("SIGKILL");
      screen?.dispose();
    },
  };
}

export async function login(
  bin,
  options,
  { name, protocol = 0, base, account, variable, existing = false, manual = false, effort },
) {
  const ui = terminal(
    bin,
    ["auth", "login", name, "--method", "key", ...(account ? ["--account", account] : [])],
    options,
  );
  const answer = async (label, input = "") => {
    await ui.waitFor(label);
    ui.write(`${input}\r`);
  };
  const down = "\x1b[B";
  try {
    if (!existing) {
      await answer("协议", down.repeat(protocol));
      await answer("Base URL", base);
    }
    await answer("密钥来源", down);
    await answer("环境变量名", variable);
    if (manual) {
      await answer("模型 ID", "manual-test");
      await answer("上下文上限");
      await answer("输出上限");
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      assert.ok(!effort || levels.includes(effort));
      await answer("支持的推理档位", effort ? `${down.repeat(levels.indexOf(effort))} ` : "");
      await answer("再添加一个模型", "n");
    }
    assert.equal((await ui.exit).exitCode, 0, ui.output());
  } finally {
    ui.kill();
  }
}
