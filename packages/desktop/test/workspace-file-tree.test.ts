import { expect, test } from "vitest";
import {
  buildWorkspaceDirectoryGitStatuses,
  filterWorkspaceFileTreeRows,
  getWorkspaceDirectoryGitStatuses,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "../src/renderer/workspace-file-tree/model.ts";

test("directory decorations retain distinct descendant statuses and their priority across path separators", () => {
  const statuses = new Map<string, WorkspaceFileGitStatus>([
    ["C:\\repo\\src\\new.ts", "added"],
    ["C:/repo/src/deep/edit.ts", "modified"],
    ["C:/repo/src/deep/removed.ts", "deleted"],
    ["C:/repo/src/also-new.ts", "added"],
    ["C:/repo/ignored/cache", "ignored"],
    ["C:/repo/other.ts", "untracked"],
    ["C:/repo/src-sibling/file.ts", "renamed"],
  ]);
  const directories = buildWorkspaceDirectoryGitStatuses(statuses);
  expect(getWorkspaceDirectoryGitStatuses(directories, "C:\\repo\\src\\")).toEqual([
    "modified",
    "added",
    "deleted",
  ]);
  expect(getWorkspaceDirectoryGitStatuses(directories, "C:/repo")).toEqual([
    "ignored",
    "modified",
    "added",
    "deleted",
    "untracked",
    "renamed",
  ]);
  expect(getWorkspaceDirectoryGitStatuses(directories, "C:/repo/src/deep")).toEqual(["modified", "deleted"]);
  expect(getWorkspaceDirectoryGitStatuses(directories, "C:/repo/src/empty")).toEqual([]);
  expect(getWorkspaceDirectoryGitStatuses(directories, "C:/repo/src/deep/edit.ts")).toEqual([]);
});

test("changed-only filtering retains ancestor directories and changed files while preserving row order", () => {
  const rows: WorkspaceFileTreeRow[] = [
    {
      path: "/repo/src",
      name: "src",
      type: "directory",
      depth: 0,
      expanded: true,
      loaded: true,
      loading: false,
      error: null,
    },
    {
      path: "/repo/src/edit.ts",
      name: "edit.ts",
      type: "file",
      depth: 1,
      expanded: false,
      loaded: false,
      loading: false,
      error: null,
    },
    {
      path: "/repo/clean.ts",
      name: "clean.ts",
      type: "file",
      depth: 0,
      expanded: false,
      loaded: false,
      loading: false,
      error: null,
    },
  ];
  const statusByPath = new Map<string, WorkspaceFileGitStatus>([["/repo/src/edit.ts", "modified"]]);
  const options = {
    rows,
    statusByPath,
    directoryStatusesByPath: buildWorkspaceDirectoryGitStatuses(statusByPath),
  };
  expect(filterWorkspaceFileTreeRows({ ...options, changedOnly: true })).toEqual(rows.slice(0, 2));
  expect(filterWorkspaceFileTreeRows({ ...options, changedOnly: false })).toBe(rows);
});
