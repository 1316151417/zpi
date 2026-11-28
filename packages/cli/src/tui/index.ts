import { execFile } from "node:child_process";
import { basename, sep } from "node:path";
import {
  type Component,
  Container,
  getNativeClipboard,
  Input,
  isKeyRelease,
  Loader,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  type SelectItem,
  SelectList,
  type SlashCommand,
  Spacer,
  Text,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { clampThinkingLevel } from "@zpi-dev/ai";
import { imageLimits } from "@zpi-dev/coding-agent";
import type { Accounts } from "../accounts/index.ts";
import { loginProviders } from "../accounts/services.ts";
import { commands, isSessionCommand, sessionNameProblem } from "../host/commands.ts";
import type { CliHost } from "../host/index.ts";
import { Completions, references, withArgumentChoices } from "./completion.ts";
import { Footer } from "./footer.ts";
import { HelpPanel, shortcutCard } from "./help.ts";
import { PromptEditor } from "./prompt-editor.ts";
import { SearchPicker } from "./search-picker.ts";
import {
  accent,
  bold,
  dim,
  failure,
  listTheme,
  panelBorder,
  safeText,
  thinkingBorderColor,
  wordmark,
} from "./theme.ts";
import { Transcript } from "./transcript.ts";

interface InteractiveOptions {
  host: CliHost;
  initialPrompt?: string;
  selectSession?: boolean;
  accounts: Accounts;
  signal?: AbortSignal;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runInteractive({
  host,
  accounts,
  initialPrompt,
  selectSession,
  signal,
}: InteractiveOptions): Promise<number> {
  if (signal?.aborted) return 130;
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true);
  const transcript = new Transcript();
  const document = new Container();
  const header = new Text(wordmark, 1, 1);
  const settings = host.readSettings();
  const progress = new Container();
  const panel = new Container();
  const home = host.homeDir;
  const footer = new Footer(
    host.cwd === home || host.cwd.startsWith(home + sep) ? `~${host.cwd.slice(home.length)}` : host.cwd,
  );
  const viewport = new ScrollView(document, { follow: "end", primary: true });
  const dock = new VStack([
    { component: progress, minSize: 0, shrink: 1 },
    { component: panel, minSize: 3, shrink: 1 },
    { component: footer, minSize: 0, shrink: 1 },
  ]);
  tui.setLayoutRoot(
    new VStack([
      { component: viewport, basis: 0, grow: 1, minSize: 1 },
      { component: dock, shrink: 1, minSize: 1 },
    ]),
  );
  function showChat() {
    document.clear();
    document.addChild(header);
    document.addChild(transcript);
  }
  function readBranch() {
    execFile(
      "git",
      ["symbolic-ref", "--short", "--quiet", "HEAD"],
      { cwd: host.cwd, timeout: 1000 },
      (error, output) => {
        if (closing) return;
        footer.branch = error ? "" : output.trim();
        tui.requestRender();
      },
    );
  }
  const argumentChoices = {
    model: () => accounts.availableModels().map(({ id }) => id),
    effort: () => host.getEfforts(),
    fast: () => ["on", "off"],
    login: () => loginProviders(accounts.snapshot.accounts).map(({ value }) => value),
  };
  async function availableCommands(forHelp = false): Promise<SlashCommand[]> {
    const builtins = forHelp ? commands : withArgumentChoices(commands, argumentChoices);
    try {
      const custom = await host.listCommands({ includeSkills: !forHelp });
      return forHelp ? [...builtins, ...custom] : [...custom, ...builtins];
    } catch (error) {
      if (forHelp) transcript.note(messageOf(error), "error");
      return builtins;
    }
  }
  let pastedCommand: string | undefined;
  const editor = new PromptEditor(
    tui,
    new Completions(host.cwd, availableCommands),
    (token) => token === pastedCommand,
  );
  let turn: AbortController | undefined;
  let task: Promise<void> | undefined;
  let cancelPicker: (() => void) | undefined;
  let images = new Map<string, Uint8Array>();
  let imageIndex = 0;
  let stash: { text: string; command?: string; images: typeof images } | undefined;
  const inputHistory = new Set<string>();
  const exit = Promise.withResolvers<number>();
  let closing = false;
  let defaultModel: string | undefined;
  let terminalTitle = "";

  let available: ReturnType<Accounts["availableModels"]> = [];
  function models(restorePreferences = false) {
    const state = accounts.snapshot;
    available = accounts.availableModels(state);
    footer.providerCount = new Set(available.map((m) => m.provider)).size;
    if (restorePreferences && state.hideThinking) transcript.toggleThinking();
    defaultModel = available.find((item) => item.isDefault)?.id;
    return available;
  }

  function update() {
    const current = host.getSelection();
    const selected = current.model ?? defaultModel ?? "";
    const model = available.find((item) => item.id === selected);
    footer.model = safeText(selected) || "no-model";
    footer.subscription = current.subscription ?? model?.subscription ?? false;
    footer.window = model?.definition.contextWindow;
    const reasoning = model?.definition.reasoning ?? false;
    const effort =
      current.effort ??
      (model && reasoning
        ? clampThinkingLevel(
            { ...model.definition, api: model.api, reasoning },
            settings.getModelThinkingLevel(model.provider, model.definition.id) ??
              settings.getDefaultThinkingLevel() ??
              "medium",
          )
        : undefined);
    footer.name = host.getSessionName() ?? "";
    const title = ["ZPI", footer.name, basename(host.cwd) || host.cwd].filter(Boolean).join(" - ");
    if (terminalTitle !== title) {
      terminalTitle = title;
      terminal.setTitle(safeText(title).replaceAll("\n", " "));
    }
    footer.mode = [effort === "off" ? reasoning && "thinking off" : effort, current.fast && "加速"]
      .filter(Boolean)
      .join(" • ");
    footer.draft = stash ? "草稿已暂存" : "";
    editor.borderColor = thinkingBorderColor(effort);
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
  function showPanel(
    title: string | undefined,
    create: (done: (value?: string) => void) => Component,
    hint = "",
    feedback?: Text,
  ) {
    if (closing) return Promise.resolve(undefined);
    const result = Promise.withResolvers<string | undefined>();
    const done = (value?: string) => {
      cancelPicker = undefined;
      panel.clear();
      panel.addChild(editor);
      tui.setFocus(editor);
      update();
      result.resolve(value);
    };
    cancelPicker = () => done();
    panel.clear();
    const component = create(done);
    panel.addChild(new Spacer(1));
    if (title !== undefined) {
      panel.addChild(panelBorder);
      if (title) panel.addChild(new Text(bold(title) + (hint ? dim(`   ·   ${hint}`) : ""), 1, 0));
    }
    panel.addChild(component);
    if (feedback) panel.addChild(feedback);
    tui.setFocus(component);
    update();
    return result.promise;
  }

  function picker(
    title: string | undefined,
    items: SelectItem[],
    empty: string,
    selected?: string,
    search?: { query: string; defaultModel?: string; save?: () => void },
  ) {
    if (!items.length) {
      transcript.note(empty);
      update();
      return Promise.resolve(undefined);
    }
    const clean = items.map((item) => ({
      ...item,
      label: safeText(item.label).replaceAll("\n", " "),
      description: item.description && safeText(item.description).replaceAll("\n", " "),
    }));
    return showPanel(title, (done) => {
      if (search)
        return new SearchPicker(
          clean,
          search.query,
          selected,
          (value, save) => {
            if (save) search.save?.();
            done(value);
          },
          () => done(),
          search.save ? { defaultModel: search.defaultModel } : undefined,
        );
      const list = new SelectList(clean, 7, listTheme);
      list.setSelectedIndex(
        Math.max(
          0,
          items.findIndex((item) => item.value === selected),
        ),
      );
      list.onCancel = () => done();
      list.onSelect = (item) => done(item.value);
      return list;
    });
  }

  function resetTranscript() {
    const messages = host.getMessages();
    transcript.reset(messages);
    footer.restoreCost(messages);
    footer.refresh(host);
  }
  async function resume(query = "") {
    const all = await host.listHistory();
    for (const row of all) if (row.error) transcript.note(`无法读取 ${row.id} · ${row.error}`, "error");
    const sessions = all
      .filter((row) => !row.error)
      .map((row) => ({
        value: row.id,
        label: row.title,
        description: new Date(row.mtime).toLocaleString(),
      }));
    const exact = sessions.find((item) => item.value === query);
    const chosen =
      exact?.value ??
      (await picker("继续会话", sessions, "当前目录没有可继续的 CLI 会话", undefined, { query }));
    if (chosen && !closing) {
      await host.resume(chosen);
      resetTranscript();
      transcript.note(`已继续会话 · ${sessions.find((item) => item.value === chosen)?.label ?? chosen}`);
      images.clear();
      stash = undefined;
    }
    return Boolean(chosen);
  }
  async function local(name: string, argument = "") {
    switch (name) {
      case "help": {
        const definitions = await availableCommands(true);
        document.clear();
        try {
          const selected = await showPanel(
            "",
            (done) => new HelpPanel(definitions, done, () => terminal.rows),
          );
          if (selected) editor.setText(selected);
        } finally {
          showChat();
        }
        break;
      }
      case "hotkeys":
        transcript.addPanel(shortcutCard());
        viewport.scrollToEnd();
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
        resetTranscript();
        images.clear();
        stash = undefined;
        models();
        break;
      case "resume":
        await resume(argument);
        break;
      case "rename": {
        const feedback = new Text("", 1, 0);
        const value =
          argument ||
          (await showPanel(
            "重命名会话",
            (done) => {
              const field = new Input({
                prompt: "名称  ",
                placeholder: "输入会话名称",
                placeholderStyle: dim,
              });
              field.setValue(host.getSessionName() ?? "");
              field.onEscape = () => done();
              field.onSubmit = (name) => {
                const problem = sessionNameProblem(name.trim());
                if (problem) feedback.setText(failure(`✕  ${safeText(problem)}`));
                else done(name.trim());
              };
              return field;
            },
            "1–100 字 · Enter 保存 · Esc 取消",
            feedback,
          ));
        if (value !== undefined) {
          await host.rename(value);
          transcript.note(`会话已命名为 ${value}`);
        }
        break;
      }
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
            undefined,
            items
              .toSorted(
                (a, b) =>
                  rank(a.id) - rank(b.id) || a.id.split("/", 1)[0].localeCompare(b.id.split("/", 1)[0]),
              )
              .map(({ id, name }) => ({ value: id, label: name })),
            "尚无可用模型。使用 /login 连接服务。",
            current,
            {
              query: argument,
              defaultModel,
              save: () => {
                save = true;
              },
            },
          ));
        if (value && !closing) {
          await host.setModel(value);
          footer.refresh(host);
          if (save) {
            accounts.setDefault(value);
            defaultModel = value;
          }
          transcript.note(save ? `当前与默认模型已设为 ${value}` : `当前模型已设为 ${value}`);
        }
        break;
      }
      case "login":
      case "logout": {
        const { runAccountCommand } = await import("../accounts/commands.ts");
        try {
          await inTerminal(() =>
            runAccountCommand(
              accounts,
              "auth",
              argument ? [name, argument] : [name],
              signal,
              (text, warning) => transcript.note(text.trimEnd(), warning ? "error" : "info"),
            ),
          );
        } catch (error) {
          if (!(error instanceof Error && "exitCode" in error && error.exitCode === 130)) throw error;
        } finally {
          if (!closing) models();
        }
        break;
      }
      case "fast": {
        const mode = argument.toLowerCase();
        if (mode && mode !== "on" && mode !== "off") throw new Error("用法：/fast [on|off]");
        const enabled = await host.toggleFast(mode ? mode === "on" : undefined);
        transcript.note(enabled ? "加速已开启" : "加速已关闭");
        break;
      }
      case "effort": {
        let value: string | undefined = argument;
        if (!value) {
          const levels = await host.getEfforts();
          value = await picker(
            "推理档位",
            levels.map((level) => ({ value: level, label: level })),
            "当前模型没有可选推理档位",
            host.getSelection().effort,
          );
        }
        if (value && !closing) {
          await host.setEffort(value);
          transcript.note(`推理档位已设为 ${value}`);
        }
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
        const items = (await host.listCommands())
          .filter((cmd) => cmd.kind === "skill")
          .map((cmd) => ({
            value: cmd.name,
            label: `/${cmd.name}`,
            description: cmd.description,
          }));
        const value = await picker("选择 Skill", items, "当前目录和用户配置中没有可用 Skill", undefined, {
          query: "",
        });
        if (value) editor.setText(`/${value} `);
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
    const builtin = command && commands.find((cmd) => cmd.name === command[1]);
    if (command && builtin && !isSessionCommand(builtin.name)) {
      if (!["help", "clear", "exit"].includes(builtin.name)) transcript.user(text);
      if (command[2] && !builtin.argumentHint) throw new Error(`/${command[1]} 不接收参数`);
      await local(command[1], command[2]?.trim());
      return;
    }
    turn = new AbortController();
    let ranShell = false;
    const loader = new Loader(tui, accent, dim, "运行中");
    progress.addChild(loader);
    viewport.scrollToEnd();
    transcript.beginTurn();
    transcript.user(text);
    update();
    try {
      const answer = await host.run(text, {
        literal,
        filePaths: literal ? [] : references(text),
        clipboardImages: [...images].filter(([marker]) => text.includes(marker)).map(([, bytes]) => bytes),
        signal: turn.signal,
        onEvent: (event) => {
          if (event.type === "tool_execution_end" && event.toolName === "bash") ranShell = true;
          if (event.type === "message_end" && event.message.role === "assistant")
            footer.recordCost(event.message);
          transcript.event(event);
          tui.requestRender();
        },
      });
      transcript.finishTurn(answer);
      images.clear();
    } catch (error) {
      transcript.finishTurn("");
      if (!turn.signal.aborted) throw error;
      transcript.note("已中断");
    } finally {
      loader.stop();
      progress.clear();
      if (ranShell) readBranch();
      turn = undefined;
      footer.refresh(host);
    }
  }
  function perform(action: () => Promise<void>) {
    if (task || closing) return;
    editor.disableSubmit = true;
    task = Promise.resolve()
      .then(action)
      .catch((error) => {
        transcript.note(messageOf(error), "error");
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
          stash = { text, command: pastedCommand, images };
          editor.setText("");
          pastedCommand = undefined;
          images = new Map();
        } else if (stash) {
          pastedCommand = stash.command;
          editor.setText(stash.text);
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
          footer.refresh(host);
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
    if (matchesKey(data, "ctrl+t")) {
      const hidden = transcript.toggleThinking();
      try {
        accounts.setThinkingHidden(hidden);
      } catch (error) {
        transcript.note(messageOf(error), "error");
      }
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
    resetTranscript();
    try {
      models(true);
    } catch (error) {
      transcript.note(messageOf(error), "error");
    }
    showChat();
    panel.addChild(editor);
    readBranch();
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
