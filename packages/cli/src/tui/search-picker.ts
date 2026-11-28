import {
  Container,
  fuzzyFilter,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { accent, dim, listTheme, muted, panelBorder, resourceTitle } from "./theme.ts";

const words = (label: string) =>
  label
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

function modelRow(
  item: SelectItem,
  current: string | undefined,
  primary: string | undefined,
  selected: boolean,
) {
  const slash = item.value.indexOf("/");
  const provider = item.value.slice(0, slash);
  const id = item.value.slice(slash + 1);
  const idWords = words(id);
  const compact = idWords.join("");
  const distinct = words(item.label).some(
    (word) => !idWords.includes(word) && !(word.length > 1 && compact.includes(word)),
  );
  const name = distinct ? ` (${item.label})` : "";
  const marker = item.value === current ? accent("✓ ") : "  ";
  const badge = item.value === primary ? " · default" : "";
  return marker + (selected ? accent(id) : id) + muted(`${name} [${provider}]${badge}`);
}

export class SearchPicker extends Container {
  readonly capturesViewportInput = true;
  private input: Input;
  private list: SelectList;
  private results = new Container();
  private modelName = new Text("", 0, 0);
  private readonly items: SelectItem[];
  private readonly choose: (value: string, save?: boolean) => void;
  private readonly cancel: () => void;
  private readonly model?: { defaultModel?: string };
  private readonly current?: string;
  constructor(
    items: SelectItem[],
    query: string,
    selected: string | undefined,
    choose: (value: string, save?: boolean) => void,
    cancel: () => void,
    model?: { defaultModel?: string },
  ) {
    super();
    this.items = items;
    this.choose = choose;
    this.cancel = cancel;
    this.model = model;
    this.current = selected;
    this.input = model
      ? new Input()
      : new Input({ prompt: "› ", placeholder: "搜索", placeholderStyle: dim });
    this.input.setValue(query);
    this.list = this.filtered();
    const index = !query && selected ? items.findIndex((item) => item.value === selected) : -1;
    if (index >= 0) {
      this.list.setSelectedIndex(index);
      this.list.onSelectionChange?.(items[index]);
    }
    if (model) {
      this.addChild(panelBorder);
      this.addChild(new Spacer(1));
      this.addChild(new Text(resourceTitle("仅显示已连接提供商的模型。用 /login 添加提供商。"), 0, 0));
      this.addChild(new Spacer(1));
    }
    this.addChild(this.input);
    if (model) this.addChild(new Spacer(1));
    this.addChild(this.results);
    this.results.addChild(this.list);
    if (model) {
      this.addChild(new Spacer(1));
      this.addChild(this.modelName);
      this.addChild(new Spacer(1));
      this.addChild(new Text(dim("  Enter 选择 · Ctrl+S 设为默认 · Esc 取消"), 0, 0));
      this.addChild(panelBorder);
    }
  }
  get focused() {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }
  private filtered() {
    const query = this.input.getValue();
    const primary = this.model?.defaultModel;
    const items = fuzzyFilter(this.items, query, (item) =>
      this.model
        ? `${item.value.split("/", 1)[0]} ${item.value} ${item.label}${item.value === primary ? " default" : ""}`
        : `${item.label} ${item.value}`,
    );
    if (this.model && query.trim() && "default".startsWith(query.trim().toLowerCase())) {
      const index = items.findIndex((item) => item.value === primary);
      if (index > 0) items.unshift(...items.splice(index, 1));
    }
    const list = this.model
      ? new SelectList(
          items,
          10,
          { ...listTheme, noMatch: () => muted("  没有匹配的模型") },
          {
            truncatePrimary: ({ item, isSelected }) => modelRow(item, this.current, primary, isSelected),
          },
        )
      : new SelectList(items, 7, listTheme);
    if (this.model) {
      list.onSelectionChange = (item) => this.modelName.setText(muted(`  模型名称：${item.label}`));
      if (items[0]) list.onSelectionChange(items[0]);
      else this.modelName.setText("");
    }
    list.onSelect = (item) => this.choose(item.value);
    list.onCancel = this.cancel;
    return list;
  }
  handleInput(data: string) {
    if (this.model && matchesKey(data, "ctrl+s")) {
      const item = this.list.getSelectedItem();
      if (item) this.choose(item.value, true);
    } else if (
      (["up", "down", "pageUp", "pageDown", "enter", "escape", "ctrl+c"] as const).some((key) =>
        matchesKey(data, key),
      )
    ) {
      this.list.handleInput(data);
    } else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== previous) {
        this.results.clear();
        this.list = this.filtered();
        this.results.addChild(this.list);
      }
    }
  }
}
