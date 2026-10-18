import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsup";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

// App API, not OS hotkeys. No synthetic ACKs, timers, native visibility or renderer.
test("native quick-chat lifecycle records reset, frame and input latency", async ({
  desktopIsolation,
}, info) => {
  void desktopIsolation;
  const dir = await mkdtemp(join(tmpdir(), "zpi-native-lifecycle-"));
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
  await build({
    entry: ["tests/helpers/quick-chat-app.ts"],
    outDir: dir,
    format: ["esm"],
    bundle: true,
    splitting: false,
    target: "node24",
    removeNodeProtocol: false,
    noExternal: ["zpi-ai", "zpi-agent", "zpi-coding-agent", "typebox"],
    external: ["electron", "sharp", "node-pty"],
    silent: true,
    define: { "process.env.ZPI_QUICK_CHAT_FIXTURE_ASSETS": JSON.stringify(resolve("packages/desktop/dist")) },
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  const release = deferred();
  const server = await fakeServer(async (_request, response, index) => {
    send(response, chunk({ content: "完成的隔离历史" }));
    if (index === 1) {
      await release.promise;
      send(response, chunk({ content: "迟到旧结果" }));
    }
    done(response);
  });
  const app = await launchDesktop({ dir, url: server.url, entry: join(dir, "quick-chat-app.js") });
  const quick = await app.firstWindow();
  const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
  const invoke = (kind: "toggle" | "new" | "show" | "hide") =>
    app.evaluate(async (_electron, kind) => {
      const control = (
        globalThis as typeof globalThis & {
          quickChatFixture: {
            toggle(newConversation?: boolean): Promise<void>;
            show(): Promise<void>;
            hide(): void;
          };
        }
      ).quickChatFixture;
      const started = performance.now();
      if (kind === "hide") control.hide();
      else if (kind === "show") await control.show();
      else await control.toggle(kind === "new");
      return performance.now() - started;
    }, kind);
  const state = () =>
    app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { visible: window.isVisible(), focused: window.isFocused(), height: window.getBounds().height };
    });
  const samples: { case: string; ms: number; inputMs?: number }[] = [];
  try {
    await invoke("show");
    await expect(input).toBeFocused();
    await expect.poll(state).toMatchObject({ visible: true, focused: true });
    for (let i = 0; i < 10; i++) {
      await invoke("hide");
      const started = performance.now();
      samples.push({ case: "hidden blank new", ms: await invoke("new") });
      await expect.poll(state).toMatchObject({ visible: true, focused: true, height: 44 });
      await input.fill(`可输入 ${i}`);
      await expect(input).toHaveValue(`可输入 ${i}`);
      samples[samples.length - 1].inputMs = performance.now() - started;
      samples.push({ case: "visible draft new", ms: await invoke("new") });
      await expect(input).toHaveValue("");
      await invoke("new");
      await expect.poll(state).toMatchObject({ visible: false });
      samples.push({ case: "blank resume", ms: await invoke("toggle") });
      await expect(input).toBeFocused();
    }
    await input.fill("建立完成历史");
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await invoke("hide");
    samples.push({ case: "idle history resume", ms: await invoke("toggle") });
    await expect.poll(state).toMatchObject({ visible: true, focused: true, height: 560 });
    samples.push({ case: "visible history new", ms: await invoke("new") });
    await expect(quick.getByTestId("run")).toHaveCount(0);
    await expect.poll(state).toMatchObject({ visible: true, height: 560 });
    const sessionId = async () =>
      quick.evaluate(async () => {
        const result = await window.zpiQuickChat.getSnapshot();
        if (!result.ok) throw new Error(result.error.message);
        return result.value.session.sessionId;
      });
    for (let i = 0; i < 2; i++) {
      const before = await sessionId();
      await quick.getByRole("button", { name: "新对话", exact: true }).click();
      await expect.poll(sessionId).not.toBe(before);
      await expect.poll(state).toMatchObject({ visible: true, height: 560 });
    }
    await input.fill("展开草稿");
    await invoke("hide");
    await invoke("toggle");
    await expect.poll(state).toMatchObject({ visible: true, focused: true, height: 560 });
    await expect(input).toHaveValue("展开草稿");
    await input.fill("");
    await invoke("hide");
    samples.push({ case: "empty expanded resume", ms: await invoke("toggle") });
    await expect.poll(state).toMatchObject({ visible: true, focused: true, height: 44 });
    // Real native hide/blur events are delivered while these requests wait for
    // a real renderer frame. Repeats must join the same new session.
    const beforeBurst = await sessionId();
    await invoke("hide");
    await app.evaluate(async () => {
      const control = (
        globalThis as typeof globalThis & { quickChatFixture: { toggle(fresh: boolean): Promise<void> } }
      ).quickChatFixture;
      await Promise.all(Array.from({ length: 8 }, () => control.toggle(true)));
    });
    await expect.poll(state).toMatchObject({ visible: true, focused: true, height: 44 });
    expect(await sessionId()).not.toBe(beforeBurst);
    await input.fill("取消运行");
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "running");
    samples.push({ case: "running new", ms: await invoke("new") });
    release.resolve();
    await expect(quick.getByTestId("run")).toHaveCount(0);
    await input.fill("新会话不会接收旧结果");
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(quick.getByTestId("run")).not.toContainText("迟到旧结果");
    const beforeExpiry = await sessionId();
    await invoke("hide");
    await app.evaluate(() =>
      (globalThis as typeof globalThis & { expireQuickChatFixture(): void }).expireQuickChatFixture(),
    );
    samples.push({ case: "expired resume (advanced host clock)", ms: await invoke("toggle") });
    await expect.poll(state).toMatchObject({ visible: true, focused: true, height: 44 });
    expect(await sessionId()).not.toBe(beforeExpiry);
    await expect(quick.getByTestId("run")).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
    await expect.poll(state).toMatchObject({ visible: false, focused: false });
    await invoke("toggle");
    await expect.poll(state).toMatchObject({ visible: true, focused: true, height: 44 });
    for (const sample of samples) expect(sample.ms, sample.case).toBeLessThan(1000);
  } finally {
    release.resolve();
    await app.close();
    await server.close();
    await writeFile(info.outputPath("latency.json"), JSON.stringify(samples, null, 2));
    await writeFile(
      info.outputPath("timing.json"),
      await readFile(join(dir, "agent/logs/quick-chat-timing.json")),
    );
    await info.attach("latency.json", {
      path: info.outputPath("latency.json"),
      contentType: "application/json",
    });
    await info.attach("timing.json", {
      path: info.outputPath("timing.json"),
      contentType: "application/json",
    });
  }
});

test("native main new-task click records input readiness for comparison", async ({
  desktopIsolation,
}, info) => {
  void desktopIsolation;
  const dir = await mkdtemp(join(tmpdir(), "zpi-native-main-new-"));
  const app = await launchDesktop({ dir, url: "" });
  const page = await app.firstWindow();
  const samples: number[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
      await expect(page.getByLabel("消息", { exact: true })).toBeFocused();
      await expect(page.getByLabel("消息", { exact: true })).toBeEditable();
      samples.push(performance.now() - started);
    }
  } finally {
    await app.close();
    await writeFile(info.outputPath("main-new-input.json"), `${JSON.stringify(samples, null, 2)}\n`);
    await info.attach("main-new-input.json", {
      path: info.outputPath("main-new-input.json"),
      contentType: "application/json",
    });
  }
});
