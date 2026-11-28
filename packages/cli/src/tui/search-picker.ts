import {
  Container,
  fuzzyFilter,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
} from "@earendil-works/pi-tui";
import { dim, listTheme } from "./theme.ts";

export class SearchPicker extends Container {
  private input = new Input({ prompt: "› ", placeholder: "搜索", placeholderStyle: dim });
  private list: SelectList;
  private readonly items: SelectItem[];
  private readonly choose: (value: string, save?: boolean) => void;
  private readonly cancel: () => void;
  private readonly allowSave: boolean;
  constructor(
    items: SelectItem[],
    query: string,
    selected: string | undefined,
    choose: (value: string, save?: boolean) => void,
    cancel: () => void,
    allowSave = false,
  ) {
    super();
    this.items = items;
    this.choose = choose;
    this.cancel = cancel;
    this.allowSave = allowSave;
    this.input.setValue(query);
    this.list = this.filtered();
    const index = !query && selected ? items.findIndex((item) => item.value === selected) : -1;
    if (index >= 0) this.list.setSelectedIndex(index);
    this.addChild(this.input);
    this.addChild(this.list);
  }
  get focused() {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }
  private filtered() {
    const items = fuzzyFilter(this.items, this.input.getValue(), (item) => `${item.label} ${item.value}`);
    const list = new SelectList(items, 7, listTheme);
    list.onSelect = (item) => this.choose(item.value);
    list.onCancel = this.cancel;
    return list;
  }
  handleInput(data: string) {
    if (this.allowSave && matchesKey(data, "ctrl+s")) {
      const item = this.list.getSelectedItem();
      if (item) this.choose(item.value, true);
    } else if (
      (["up", "down", "pageUp", "pageDown", "enter", "escape"] as const).some((key) => matchesKey(data, key))
    ) {
      this.list.handleInput(data);
    } else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== previous) {
        this.removeChild(this.list);
        this.list = this.filtered();
        this.addChild(this.list);
      }
    }
  }
}
