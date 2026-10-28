import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { WorkspaceFileSearchInput, WorkspaceFileSearchResult } from "../shared/workspace-files.ts";
import { WorkspaceFileSearch } from "./workspace-files.ts";

interface Search {
  owner: number;
  scope: string;
  controller: AbortController;
  scan: WorkspaceFileSearch;
  continuation?: string;
  busy: boolean;
  expiry?: ReturnType<typeof setTimeout>;
}

/** Short-lived cursors belong to a renderer request, not a persistent workspace index. */
export class WorkspaceFileSearches {
  private searches = new Map<string, Search>();
  private key(owner: number, requestId: string) {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId))
      throw new Error("invalid_input: 文件搜索标识无效");
    return `${owner}:${requestId}`;
  }
  async search(
    owner: number,
    sessionId: string | null,
    cwd: string,
    input: WorkspaceFileSearchInput,
  ): Promise<WorkspaceFileSearchResult> {
    const key = this.key(owner, input.requestId);
    if (typeof input.query !== "string" || input.query.length > 500)
      throw new Error("invalid_input: 文件查询无效");
    if (input.filesOnly !== undefined && typeof input.filesOnly !== "boolean")
      throw new Error("invalid_input: 文件搜索类型无效");
    const limit = input.limit ?? 1000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("invalid_input: 文件搜索数量无效");
    const root = input.rootPath ?? cwd;
    if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0") || root.length > 8192)
      throw new Error("invalid_input: 工作目录无效");
    const scope = JSON.stringify([sessionId, resolve(root), input.query, Boolean(input.filesOnly), limit]);
    let search = this.searches.get(key);
    if (input.continuation !== undefined) {
      if (!search || search.scope !== scope || search.continuation !== input.continuation)
        throw new Error("invalid_input: 文件搜索已过期，请重新搜索");
      if (search.busy) throw new Error("busy: 文件搜索仍在进行");
    } else {
      await this.cancel(owner, input.requestId);
      // Bound abandoned renderers/cursors even if their cleanup message never arrives.
      if (this.searches.size >= 16) {
        const oldest = this.searches.entries().next().value;
        if (oldest) await this.release(oldest[0], oldest[1]);
      }
      const controller = new AbortController();
      search = {
        owner,
        scope,
        controller,
        busy: false,
        scan: new WorkspaceFileSearch(resolve(root), input.query, controller.signal, limit, input.filesOnly),
      };
      this.searches.set(key, search);
    }
    clearTimeout(search.expiry);
    search.busy = true;
    try {
      const { done, ...result } = await search.scan.nextBatch();
      if (done) await this.release(key, search);
      else {
        search.continuation = randomUUID();
        result.continuation = search.continuation;
        search.expiry = setTimeout(() => void this.release(key, search), 120_000);
        search.expiry.unref();
      }
      return result;
    } catch (error) {
      await this.release(key, search);
      throw error;
    } finally {
      search.busy = false;
    }
  }
  private async release(key: string, search: Search) {
    if (this.searches.get(key) === search) this.searches.delete(key);
    clearTimeout(search.expiry);
    search.controller.abort();
    await search.scan.close().catch(() => {});
  }
  async cancel(owner: number, requestId: string) {
    const key = this.key(owner, requestId);
    const search = this.searches.get(key);
    if (search) await this.release(key, search);
  }
  async close(owner?: number) {
    await Promise.all(
      [...this.searches]
        .filter(([, entry]) => owner === undefined || entry.owner === owner)
        .map(([key, entry]) => this.release(key, entry)),
    );
  }
}
