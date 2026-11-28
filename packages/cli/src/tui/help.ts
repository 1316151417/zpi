import {
  Container,
  Markdown,
  matchesKey,
  SelectList,
  type SlashCommand,
  Spacer,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { commandUsage } from "../host/commands.ts";
import { accent, bold, dim, listTheme, markdownTheme, panelBorder, safeText } from "./theme.ts";

const groups = [
  {
    title: "输入与编辑",
    rows: [
      ["/", "命令与 Skill"],
      ["@", "引用文件或目录"],
      ["Tab", "补全命令或参数"],
      ["Enter", "发送消息"],
      ["Ctrl+J", "换行"],
      ["Ctrl+V", "粘贴图片"],
      ["Ctrl+R", "搜索输入历史"],
      ["Ctrl+S", "暂存或取回草稿"],
      ["Ctrl+G", "外部编辑器"],
    ],
  },
  {
    title: "会话与模型",
    rows: [
      ["Ctrl+T", "显示或收起思考"],
      ["Ctrl+O", "展开工具与启动详情"],
      ["Esc / Ctrl+C", "取消或中断"],
      ["Ctrl+D", "退出空输入框"],
      ["Ctrl+L / Alt+P", "选择模型"],
      ["Ctrl+P", "下一个模型"],
      ["Ctrl+Shift+P", "上一个模型"],
      ["Shift+Tab", "切换推理档位"],
      ["Alt+O", "切换加速"],
    ],
  },
];

const shortcutTables = groups
  .map(({ title, rows }) =>
    [
      `**${title}**`,
      "",
      "| 按键 | 操作 |",
      "| --- | --- |",
      ...rows.map(([key, action]) => `| \`${key}\` | ${action} |`),
    ].join("\n"),
  )
  .join("\n\n");

export function shortcutCard() {
  const card = new Container();
  card.addChild(panelBorder);
  card.addChild(new Text(accent(bold("Keyboard Shortcuts")), 1, 0));
  card.addChild(new Spacer(1));
  card.addChild(new Markdown(shortcutTables, 1, 1, markdownTheme));
  card.addChild(panelBorder);
  return card;
}

export class HelpPanel {
  readonly capturesViewportInput = true;
  private readonly shortcuts = new Markdown(shortcutTables, 0, 0, markdownTheme);
  private readonly commands: SelectList;
  private commandTab = false;
  private scroll = 0;
  private maxScroll = 0;
  private readonly close: () => void;
  private readonly terminalRows: () => number;

  constructor(definitions: SlashCommand[], done: (value?: string) => void, terminalRows: () => number) {
    this.close = () => done();
    this.terminalRows = terminalRows;
    const count = Math.max(3, Math.min(10, terminalRows() - 9));
    this.commands = new SelectList(
      definitions.map((cmd) => ({
        value: cmd.name,
        label: safeText(commandUsage(cmd)).replaceAll("\n", " "),
        description: safeText(cmd.description ?? "").replaceAll("\n", " "),
      })),
      count,
      listTheme,
    );
    this.commands.onSelect = ({ value }) => done(`/${value} `);
  }
  invalidate() {
    this.commands.invalidate();
    this.shortcuts.invalidate();
  }
  render(width: number) {
    const margin = width > 4 ? "  " : "";
    const inner = Math.max(1, width - margin.length);
    const active = (name: string) => accent(bold(`[${name}]`));
    const tabs = this.commandTab
      ? `${dim("快捷键")}   ${active("命令")}`
      : `${active("快捷键")}   ${dim("命令")}`;
    const body = this.commandTab ? this.commands.render(inner) : this.shortcuts.render(inner);
    const capacity = Math.max(2, this.terminalRows() - 9);
    this.maxScroll = this.commandTab ? 0 : Math.max(0, body.length - capacity);
    this.scroll = Math.min(this.scroll, this.maxScroll);
    const footer = [
      "Tab 切页",
      ...(this.commandTab ? ["↑↓ 选择", "Enter 填入"] : this.maxScroll ? ["↑↓ 滚动"] : []),
      "Esc 关闭",
    ];
    const visible = this.commandTab ? body : body.slice(this.scroll, this.scroll + capacity);
    return [`${bold("帮助")}     ${tabs}`, "", ...visible, "", dim(footer.join("   "))].map(
      (line) => margin + truncateToWidth(line, inner),
    );
  }
  handleInput(data: string) {
    if (matchesKey(data, "escape") || data === "?") return this.close();
    if (
      matchesKey(data, "tab") ||
      matchesKey(data, "shift+tab") ||
      matchesKey(data, "left") ||
      matchesKey(data, "right")
    ) {
      this.commandTab = !this.commandTab;
      this.scroll = 0;
    } else if (this.commandTab) {
      this.commands.handleInput(data);
    } else {
      const page = Math.max(1, this.terminalRows() - 9);
      if (matchesKey(data, "up") || matchesKey(data, "pageUp"))
        this.scroll = Math.max(0, this.scroll - (matchesKey(data, "up") ? 1 : page));
      if (matchesKey(data, "down") || matchesKey(data, "pageDown"))
        this.scroll = Math.min(this.maxScroll, this.scroll + (matchesKey(data, "down") ? 1 : page));
    }
  }
}
