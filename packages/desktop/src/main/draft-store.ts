import { type ConversationSelection, validSelections } from "zpi-ui/selections";
import type { StateStore } from "./state-store.ts";
export interface TextDraft {
  selections?: ConversationSelection[];
  text: string;
  fileReferences: string[];
  selection: [number, number];
  revision: number;
}
export class DraftStore {
  private stateStore: StateStore;
  constructor(stateStore: StateStore) {
    this.stateStore = stateStore;
  }
  private validateId(id: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid_input: 无效草稿会话");
  }
  get(id: string): TextDraft {
    this.validateId(id);
    const value = this.stateStore.getDraft<TextDraft>(id);
    if (value === undefined) return { text: "", fileReferences: [], selection: [0, 0], revision: 0 };
    this.validate(value);
    return value;
  }
  save(id: string, value: TextDraft): void {
    this.validateId(id);
    this.validate(value);
    if (value.revision < this.get(id).revision) return;
    this.stateStore.saveDraft(id, value);
  }
  private validate(value: TextDraft): void {
    if (
      !value ||
      typeof value.text !== "string" ||
      (value.selections !== undefined && !validSelections(value.selections)) ||
      value.text.length > 100000 ||
      !Array.isArray(value.fileReferences) ||
      value.fileReferences.length > 30 ||
      value.fileReferences.some((p) => typeof p !== "string") ||
      !Array.isArray(value.selection) ||
      value.selection.length !== 2 ||
      value.selection.some((p) => !Number.isSafeInteger(p) || p < 0 || p > value.text.length) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0
    )
      throw new Error("invalid_input: 无效草稿");
  }
  delete(id: string): void {
    this.validateId(id);
    this.stateStore.deleteDraft(id);
  }
}
