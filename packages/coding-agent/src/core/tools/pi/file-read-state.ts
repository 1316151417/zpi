import { createHash } from "node:crypto";

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function rangeKey(offset?: number, limit?: number): string {
  return `${offset ?? 1}:${limit ?? ""}`;
}

/** File contents known to the model in one live context; no transcript or disk cache. */
export class FileReadState {
  private files = new Map<string, { hash: string; ranges: Set<string> }>();

  clear(): void {
    this.files.clear();
  }

  isUnchanged(path: string, content: string, offset?: number, limit?: number): boolean {
    const entry = this.files.get(path);
    if (!entry?.ranges.has(rangeKey(offset, limit))) return false;
    return entry.hash === contentHash(content);
  }

  /** Reuse an incremental decoded-text hash without retaining the full file. */
  isHashUnchanged(path: string, hash: string, offset?: number, limit?: number): boolean {
    const entry = this.files.get(path);
    if (!entry?.ranges.has(rangeKey(offset, limit))) return false;
    return entry.hash === hash;
  }

  recordRead(path: string, content: string, offset?: number, limit?: number, truncated = false): void {
    this.recordReadHash(path, contentHash(content), offset, limit, truncated);
  }

  recordReadHash(path: string, hash: string, offset?: number, limit?: number, truncated = false): void {
    let entry = this.files.get(path);
    if (entry?.hash !== hash) {
      entry = { hash, ranges: new Set() };
      this.files.set(path, entry);
    }
    // A truncated tool result must remain readable, including its continuation notice.
    if (!truncated) entry.ranges.add(rangeKey(offset, limit));
  }

  recordWrite(path: string, content: string): void {
    this.files.set(path, { hash: contentHash(content), ranges: new Set([rangeKey()]) });
  }

  recordEdit(path: string, before: string, after: string): void {
    // Editing a range does not make the rest of the file known. Line shifts also invalidate old ranges.
    const knewFullFile = this.isUnchanged(path, before);
    this.files.delete(path);
    if (knewFullFile) this.recordWrite(path, after);
  }
}
