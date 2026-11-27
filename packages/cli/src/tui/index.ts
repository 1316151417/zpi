import {
  Container,
  Editor,
  isKeyRelease,
  matchesKey,
  ProcessTerminal,
  type SelectItem,
  SelectList,
  type SlashCommand,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { commands } from "../host/commands.ts";
import type { CliHost } from "../host/index.ts";
import { Completions, references } from "./completion.ts";
import { accent, bold, dim, listTheme, safeText } from "./theme.ts";
import { Transcript } from "./transcript.ts";

interface InteractiveOptions {
  host: CliHost;
  initialPrompt?: string;
  selectSession?: boolean;
  listModels(): Promise<{ name: string; description?: string }[]>;
  signal?: AbortSignal;
}

const hint = "Enter 发送 · Ctrl+J 换行 · /help 帮助 · Ctrl+O 工具详情";
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runInteractive({
  host,
  listModels,
  initialPrompt,
  selectSession,
  signal,
}: InteractiveOptions): Promise<number> {
  if (signal?.aborted) return 130;
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal, true);
  const transcript = new Transcript();
  const panel = new Container();
  const status = new Text("", 1, 0);
  const editor = new Editor(
    tui,
    { borderColor: dim, selectList: listTheme },
    { paddingX: 1, autocompleteMaxVisible: 5 },
  );
  async function availableCommands(reportErrors = false): Promise<SlashCommand[]> {
    try {
      return [
        ...commands,
        ...(await host.listCommands()).filter((file) => !commands.some((cmd) => cmd.name === file.name)),
      ];
    } catch (error) {
      if (reportErrors) transcript.note(messageOf(error));
      return [...commands];
    }
  }
  editor.setAutocompleteProvider(new Completions(host.cwd, availableCommands));
  let skill: string | undefined;
  let turn: AbortController | undefined;
  let task: Promise<void> | undefined;
  let cancelPicker: (() => void) | undefined;
  let pastedCommand: string | undefined;
  const exit = Promise.withResolvers<number>();
  let closing = false;

  function update() {
    const current = host.getSelection();
    const info = [
      current.model,
      current.effort,
      skill && `Skill ${skill}`,
      turn ? "运行中 · Esc 中断" : task && !cancelPicker ? "正在准备…" : hint,
    ].filter(Boolean);
    status.setText(dim(safeText(info.join("  ·  "))));
    tui.requestRender();
  }
  function finish(code: number) {
    if (closing) return;
    closing = true;
    cancelPicker?.();
    turn?.abort();
    exit.resolve(code);
  }
  function picker(title: string, items: SelectItem[], empty: string, selected?: string) {
    if (closing) return Promise.resolve(undefined);
    if (!items.length) {
      transcript.note(empty);
      update();
      return Promise.resolve(undefined);
    }
    const result = Promise.withResolvers<string | undefined>();
    const list = new SelectList(
      items.map((item) => ({
        ...item,
        label: safeText(item.label).replaceAll("\n", " "),
        description: item.description && safeText(item.description).replaceAll("\n", " "),
      })),
      7,
      listTheme,
    );
    const index = items.findIndex((item) => item.value === selected);
    if (index >= 0) list.setSelectedIndex(index);
    const done = (value?: string) => {
      cancelPicker = undefined;
      panel.clear();
      panel.addChild(editor);
      tui.setFocus(editor);
      tui.requestRender();
      result.resolve(value);
    };
    cancelPicker = () => done();
    list.onCancel = cancelPicker;
    list.onSelect = (item) => done(item.value);
    panel.clear();
    panel.addChild(new Text(bold(title) + dim("   ↑↓ 选择 · Enter 确定 · Esc 返回"), 1, 0));
    panel.addChild(list);
    tui.setFocus(list);
    tui.requestRender();
    return result.promise;
  }
  async function resume() {
    const all = await host.listHistory();
    for (const row of all) if (row.error) transcript.note(`无法读取 ${row.id} · ${row.error}`);
    const chosen = await picker(
      "继续会话",
      all
        .filter((row) => !row.error)
        .map((row) => ({
          value: row.id,
          label: row.title,
          description: new Date(row.mtime).toLocaleString(),
        })),
      "当前目录没有可继续的 CLI 会话",
    );
    if (chosen && !closing) {
      await host.resume(chosen);
      transcript.reset(host.getMessages());
      skill = undefined;
    }
    return Boolean(chosen);
  }
  async function local(name: string) {
    switch (name) {
      case "help":
        transcript.note(
          [
            ...(await availableCommands(true)).map((cmd) => `/${cmd.name}   ${cmd.description ?? ""}`),
            "",
            hint,
            "Tab 采纳补全 · @ 引用文件或目录 · Esc 关闭候选或中断 · Ctrl+D 退出空输入框",
          ].join("\n"),
        );
        break;
      case "exit":
        finish(0);
        break;
      case "clear":
        await host.clear();
        transcript.reset([]);
        skill = undefined;
        break;
      case "resume":
        await resume();
        break;
      case "model": {
        const models = await listModels();
        const value = await picker(
          "选择模型",
          models.map((model) => ({ value: model.name, label: model.name, description: model.description })),
          "尚无可用模型。使用 zpi auth login 连接服务。",
          host.getSelection().model,
        );
        if (value && !closing) await host.setModel(value);
        break;
      }
      case "effort": {
        const levels = await host.getEfforts();
        const value = await picker(
          "推理档位",
          levels.map((level) => ({ value: level, label: level })),
          "当前模型没有可选推理档位",
          host.getSelection().effort,
        );
        if (value && !closing) await host.setEffort(value);
        break;
      }
      case "context": {
        const usage = host.getContext();
        if (!usage) transcript.note("当前会话尚无上下文用量");
        else {
          const tokens = usage.inputTokens ?? usage.estimatedTokens;
          transcript.note(
            `上下文 ${tokens == null ? "未知" : tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens${usage.percent == null ? "" : ` (${usage.percent.toFixed(1)}%)`}`,
          );
        }
        break;
      }
      case "skills": {
        const skills = await host.listSkills();
        const items: SelectItem[] = skills.map(({ name, description }) => ({
          value: name,
          label: name,
          description,
        }));
        if (skill) items.unshift({ value: "", label: "移除已选 Skill" });
        const value = await picker(
          "为下一条消息选择 Skill",
          items,
          "当前目录和用户配置中没有可用 Skill",
          skill,
        );
        if (value !== undefined) skill = value || undefined;
        break;
      }
    }
  }
  async function submit(text: string, literal: boolean) {
    if (!text.trim() || closing) return;
    editor.addToHistory(text);
    const command = !literal && /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (
      command &&
      commands.some((item) => item.name === command[1]) &&
      !["compact", "init"].includes(command[1])
    ) {
      if (command[2]) throw new Error(`/${command[1]} 不接收参数`);
      await local(command[1]);
      return;
    }
    turn = new AbortController();
    transcript.beginTurn();
    transcript.user(text);
    update();
    try {
      const answer = await host.run(text, {
        literal,
        filePaths: literal ? [] : references(text),
        skill,
        signal: turn.signal,
        onEvent: (event) => {
          transcript.event(event);
          tui.requestRender();
        },
      });
      if (answer && answer !== transcript.lastAnswer) transcript.note(answer);
      skill = undefined;
    } catch (error) {
      if (!turn.signal.aborted) throw error;
      transcript.note("已中断");
    } finally {
      turn = undefined;
    }
  }
  function perform(action: () => Promise<void>) {
    if (task || closing) return;
    editor.disableSubmit = true;
    task = Promise.resolve()
      .then(action)
      .catch((error) => {
        transcript.note(messageOf(error));
      })
      .finally(() => {
        task = undefined;
        editor.disableSubmit = false;
        update();
      });
    update();
  }

  editor.onSubmit = (text) => {
    const literal = Boolean(pastedCommand && text.trimStart().split(/\s/, 1)[0] === pastedCommand);
    pastedCommand = undefined;
    if (text.trim()) perform(() => submit(text, literal));
  };
  const unlisten = tui.addInputListener((data) => {
    if (isKeyRelease(data)) return;
    if (closing) return { consume: true };
    if (cancelPicker) {
      if (matchesKey(data, "ctrl+c")) {
        cancelPicker();
        return { consume: true };
      }
      return;
    }
    // Bracketed paste is delivered as one input record by pi-tui's StdinBuffer.
    if (data.startsWith("\x1b[200~") && !editor.getExpandedText().trim())
      pastedCommand = data
        .slice(6, data.endsWith("\x1b[201~") ? -6 : undefined)
        .trimStart()
        .match(/^\/\S+/)?.[0];
    else if (!editor.getText()) pastedCommand = undefined;
    if (matchesKey(data, "ctrl+o")) {
      transcript.toggleDetails();
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (editor.isShowingAutocomplete()) {
        editor.handleInput("\x1b");
        tui.requestRender();
      } else if (turn) turn.abort();
      else if (matchesKey(data, "ctrl+c")) {
        editor.setText("");
        update();
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && !task && !editor.getText()) {
      finish(0);
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+j") && data !== "\n") {
      editor.handleInput("\n");
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "enter")) {
      if (task) return { consume: true };
      // Enter submits what was typed. Only Tab accepts a candidate.
      if (editor.isShowingAutocomplete()) editor.handleInput("\x1b");
    }
  });
  const onAbort = () => finish(130);
  const onEnd = () => finish(0);
  signal?.addEventListener("abort", onAbort, { once: true });
  process.stdin.once("end", onEnd);
  try {
    transcript.reset(host.getMessages());
    tui.addChild(new Text(`${bold("zpi")}  ${accent(safeText(host.cwd))}`, 1, 0));
    tui.addChild(transcript);
    tui.addChild(panel);
    panel.addChild(editor);
    tui.addChild(status);
    tui.setFocus(editor);
    tui.start();
    update();
    if (selectSession || initialPrompt)
      perform(async () => {
        if (selectSession && !(await resume())) return;
        if (initialPrompt) await submit(initialPrompt, false);
      });
    const code = await exit.promise;
    await task;
    return code;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    process.stdin.off("end", onEnd);
    unlisten();
    try {
      await terminal.drainInput(120, 20);
    } finally {
      tui.stop();
    }
  }
}
