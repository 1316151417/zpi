import { sep } from "node:path";
import {
  Container,
  Editor,
  getNativeClipboard,
  isKeyRelease,
  matchesKey,
  ProcessTerminal,
  type SelectItem,
  SelectList,
  type SlashCommand,
  Text,
  TruncatedText,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { imageLimits } from "@zpi-dev/coding-agent";
import type { Accounts } from "../accounts/index.ts";
import { builtinNames, commands, isSessionCommand } from "../host/commands.ts";
import type { CliHost } from "../host/index.ts";
import { Completions, references } from "./completion.ts";
import { SearchPicker } from "./search-picker.ts";
import { bold, dim, listTheme, safeText, wordmark } from "./theme.ts";
import { Transcript } from "./transcript.ts";

interface InteractiveOptions {
  host: CliHost;
  initialPrompt?: string;
  selectSession?: boolean;
  accounts: Accounts;
  signal?: AbortSignal;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

class PromptEditor extends Editor {
  override render(width: number) {
    const lines = super.render(width);
    // Use the editor's reserved left margin so IME and mouse positions stay aligned.
    if (lines[1]?.startsWith("  ")) lines[1] = dim("❯") + lines[1].slice(1);
    return lines;
  }
}

export async function runInteractive({
  host,
  accounts,
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
  const editor = new PromptEditor(
    tui,
    { borderColor: dim, selectList: listTheme },
    { paddingX: 2, autocompleteMaxVisible: 5 },
  );
  async function availableCommands(reportErrors = false): Promise<SlashCommand[]> {
    try {
      return [...(await host.listCommands()), ...commands];
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
  let images = new Map<string, Uint8Array>();
  let imageIndex = 0;
  let stash: { text: string; command?: string; skill?: string; images: typeof images } | undefined;
  const inputHistory = new Set<string>();
  const exit = Promise.withResolvers<number>();
  let closing = false;
  let defaultModel: string | undefined;

  function models() {
    const available = accounts.availableModels();
    defaultModel = available.find((item) => item.isDefault)?.id;
    return available;
  }

  function update() {
    const current = host.getSelection();
    const info = [
      current.model ?? defaultModel,
      current.effort && current.effort !== "off" && current.effort,
      current.fast && "加速",
      skill && `Skill ${skill}`,
      stash && "草稿已暂存",
      turn && "运行中",
    ].filter(Boolean);
    status.setText(info.length ? dim(safeText(info.join("  ·  "))) : "");
    tui.requestRender();
  }
  function finish(code: number) {
    if (closing) return;
    closing = true;
    cancelPicker?.();
    turn?.abort();
    exit.resolve(code);
  }
  async function inTerminal<T>(run: () => Promise<T>) {
    tui.stop();
    try {
      return await run();
    } finally {
      if (!closing) {
        tui.start();
        tui.requestRender(true);
      }
    }
  }
  function picker(
    title: string,
    items: SelectItem[],
    empty: string,
    selected?: string,
    search?: { query: string; save?: () => void },
  ) {
    if (closing) return Promise.resolve(undefined);
    if (!items.length) {
      transcript.note(empty);
      update();
      return Promise.resolve(undefined);
    }
    const result = Promise.withResolvers<string | undefined>();
    const clean = items.map((item) => ({
      ...item,
      label: safeText(item.label).replaceAll("\n", " "),
      description: item.description && safeText(item.description).replaceAll("\n", " "),
    }));
    const done = (value?: string) => {
      cancelPicker = undefined;
      panel.clear();
      panel.addChild(editor);
      tui.setFocus(editor);
      tui.requestRender();
      result.resolve(value);
    };
    cancelPicker = () => done();
    let list: SelectList | SearchPicker;
    if (search) {
      list = new SearchPicker(
        clean,
        search.query,
        selected,
        (value, save) => {
          if (save) search.save?.();
          done(value);
        },
        cancelPicker,
        !!search.save,
      );
    } else {
      list = new SelectList(clean, 7, listTheme);
      list.setSelectedIndex(
        Math.max(
          0,
          items.findIndex((item) => item.value === selected),
        ),
      );
      list.onCancel = cancelPicker;
      list.onSelect = (item) => done(item.value);
    }
    panel.clear();
    panel.addChild(new Text(bold(title), 1, 0));
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
      undefined,
      { query: "" },
    );
    if (chosen && !closing) {
      await host.resume(chosen);
      transcript.reset(host.getMessages());
      skill = undefined;
      images.clear();
      stash = undefined;
    }
    return Boolean(chosen);
  }
  async function local(name: string, argument = "") {
    switch (name) {
      case "help":
        transcript.note(
          [
            ...(await availableCommands(true)).map((cmd) => `/${cmd.name}   ${cmd.description ?? ""}`),
            "",
            "Ctrl+J 换行 · Ctrl+R 搜索输入 · Ctrl+O 思考与工具详情 · Ctrl+L / Alt+P 选模型",
            "Ctrl+P / Ctrl+Shift+P 切换模型 · Shift+Tab 切换推理档位 · Alt+O 切换加速",
            "Tab 采纳补全 · @ 引用文件或目录 · Esc 关闭候选或中断 · Ctrl+D 退出空输入框",
            "Ctrl+V 粘贴图片 · Ctrl+S 暂存或取回草稿 · Ctrl+G 用外部编辑器编辑",
          ].join("\n"),
        );
        break;
      case "copy": {
        if (argument && !/^[1-9]\d*$/.test(argument)) throw new Error("用法：/copy [倒数第几条回答]");
        const answer = host.lastAnswer(Number(argument || 1));
        if (!answer) throw new Error("当前会话找不到这条回答。");
        process.stdout.write(`\x1b]52;c;${Buffer.from(answer).toString("base64")}\x07`);
        transcript.note("已向终端发送复制请求。");
        break;
      }
      case "exit":
        finish(0);
        break;
      case "clear":
        await host.clear();
        transcript.reset([]);
        skill = undefined;
        images.clear();
        stash = undefined;
        models();
        break;
      case "resume":
        await resume();
        break;
      case "rename":
        await host.rename(argument);
        transcript.note(`会话已命名为 ${argument}`);
        break;
      case "model": {
        const items = models();
        const current = host.getSelection().model ?? defaultModel;
        const rank = (id: string) => (id === current ? 0 : id === defaultModel ? 1 : 2);
        const exact = items.find((m) => m.id === argument);
        const sameId = items.filter((m) => m.id.slice(m.id.indexOf("/") + 1) === argument);
        let save = false;
        const value =
          exact?.id ??
          (sameId.length === 1 ? sameId[0].id : undefined) ??
          (await picker(
            "选择模型   ·   Ctrl+S 设为默认",
            items
              .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
              .map(({ id }) => ({
                value: id,
                label: id,
                description: [id === current && "当前", id === defaultModel && "默认"]
                  .filter(Boolean)
                  .join(" · "),
              })),
            "尚无可用模型。使用 /login 连接服务。",
            current,
            {
              query: argument,
              save: () => {
                save = true;
              },
            },
          ));
        if (value && !closing) {
          await host.setModel(value);
          if (save) {
            accounts.setDefault(value);
            defaultModel = value;
          }
        }
        break;
      }
      case "login":
      case "logout": {
        const { runAccountCommand } = await import("../accounts/commands.ts");
        try {
          await inTerminal(() =>
            runAccountCommand(accounts, "auth", argument ? [name, argument] : [name], signal),
          );
        } catch (error) {
          if (!(error instanceof Error && "exitCode" in error && error.exitCode === 130)) throw error;
        } finally {
          if (!closing) models();
        }
        break;
      }
      case "fast":
        await host.toggleFast();
        break;
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
    inputHistory.delete(text);
    inputHistory.add(text);
    if (inputHistory.size > 100) {
      const oldest = inputHistory.values().next().value;
      if (oldest !== undefined) inputHistory.delete(oldest);
    }
    const command = !literal && /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (command && builtinNames.has(command[1]) && !isSessionCommand(command[1])) {
      if (command[2] && !["model", "login", "copy", "rename"].includes(command[1]))
        throw new Error(`/${command[1]} 不接收参数`);
      await local(command[1], command[2]?.trim());
      return;
    }
    turn = new AbortController();
    const started = performance.now();
    transcript.beginTurn();
    transcript.user(text);
    update();
    try {
      const answer = await host.run(text, {
        literal,
        filePaths: literal ? [] : references(text),
        clipboardImages: [...images].filter(([marker]) => text.includes(marker)).map(([, bytes]) => bytes),
        skill,
        signal: turn.signal,
        onEvent: (event) => {
          transcript.event(event);
          tui.requestRender();
        },
      });
      transcript.finishTurn(answer, performance.now() - started);
      skill = undefined;
      images.clear();
    } catch (error) {
      transcript.finishTurn("");
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
    if (!task && (matchesKey(data, "ctrl+l") || matchesKey(data, "alt+p"))) {
      perform(() => local("model"));
      return { consume: true };
    }
    if (!task && !editor.isShowingAutocomplete()) {
      if (matchesKey(data, "ctrl+v")) {
        perform(async () => {
          const draft = editor.getExpandedText();
          for (const marker of images.keys()) if (!draft.includes(marker)) images.delete(marker);
          if (images.size >= imageLimits.count) throw new Error("本条消息图片数量超限");
          const bytes = await getNativeClipboard()?.getImage();
          if (closing) return;
          if (!bytes?.length) throw new Error("剪贴板中没有可用图片，可用 @ 引用图片文件。");
          if (bytes.length > imageLimits.sourceBytes) throw new Error("剪贴板图片太大。");
          const marker = `[图片 ${++imageIndex}]`;
          images.set(marker, bytes);
          editor.insertTextAtCursor(marker);
        });
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+s")) {
        const text = editor.getExpandedText();
        if (text.trim()) {
          stash = { text, command: pastedCommand, skill, images };
          editor.setText("");
          pastedCommand = undefined;
          skill = undefined;
          images = new Map();
        } else if (stash) {
          editor.setText(stash.text);
          pastedCommand = stash.command;
          skill = stash.skill;
          images = stash.images;
          stash = undefined;
        }
        update();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+g")) {
        perform(async () => {
          const { editDraft } = await import("./external-editor.ts");
          const value = await inTerminal(() => editDraft(editor.getExpandedText(), signal));
          if (!closing) editor.setText(value);
        });
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+r")) {
        perform(async () => {
          const value = await picker(
            "搜索输入历史",
            Array.from(inputHistory)
              .reverse()
              .map((value) => ({ value, label: value })),
            "本次终端还没有输入历史",
            undefined,
            { query: editor.getText() },
          );
          if (value !== undefined) editor.setText(value);
        });
        return { consume: true };
      }
      const previous = matchesKey(data, "ctrl+shift+p");
      if (previous || matchesKey(data, "ctrl+p")) {
        perform(async () => {
          const all = models();
          if (!all.length) return local("model");
          const index = all.findIndex((m) => m.id === (host.getSelection().model ?? defaultModel));
          const next = (index + (previous ? -1 : 1) + all.length) % all.length;
          await host.setModel(all[next].id);
        });
        return { consume: true };
      }
      if (matchesKey(data, "shift+tab")) {
        perform(async () => {
          const levels: readonly string[] = await host.getEfforts();
          const current = host.getSelection().effort;
          const index = current ? levels.indexOf(current) : -1;
          if (levels.length) await host.setEffort(levels[(index + 1) % levels.length]);
        });
        return { consume: true };
      }
      if (matchesKey(data, "alt+o")) {
        perform(() => local("fast"));
        return { consume: true };
      }
    }
    if (!task && data === "?" && !editor.getText()) {
      perform(() => local("help"));
      return { consume: true };
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
      if (pastedCommand && editor.isShowingAutocomplete()) editor.handleInput("\x1b");
    }
  });
  const onAbort = () => finish(130);
  const onEnd = () => finish(0);
  signal?.addEventListener("abort", onAbort, { once: true });
  process.stdin.once("end", onEnd);
  try {
    transcript.reset(host.getMessages());
    try {
      models();
    } catch (error) {
      transcript.note(messageOf(error));
    }
    const home = host.homeDir;
    const directory =
      host.cwd === home || host.cwd.startsWith(home + sep) ? `~${host.cwd.slice(home.length)}` : host.cwd;
    tui.addChild(new TruncatedText(`${wordmark}   ${dim(safeText(directory))}`, 1, 1));
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
