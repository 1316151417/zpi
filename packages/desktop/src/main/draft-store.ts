import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ConversationSelection, validSelections } from "zpi-ui";
import { atomicJson } from "./storage.ts";
export interface TextDraft {
  selections?: ConversationSelection[];
  text: string;
  fileReferences: string[];
  selection: [number, number];
  revision: number;
}
export class DraftStore {
  private dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid_input: 无效草稿会话");
    return join(this.dir, `${id}.json`);
  }
  get(id: string): TextDraft {
    const path = this.path(id);
    if (!existsSync(path)) return { text: "", fileReferences: [], selection: [0, 0], revision: 0 };
    const value = JSON.parse(readFileSync(path, "utf8"));
    this.validate(value);
    return value;
  }
  save(id: string, value: TextDraft): void {
    this.validate(value);
    if (value.revision < this.get(id).revision) return;
    atomicJson(this.path(id), value);
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
    rmSync(this.path(id), { force: true });
  }
}
