import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CommandEditor, CommandSettings } from "../src/renderer/CommandSettings.tsx";
import type { CustomCommand } from "../src/shared/custom-commands.ts";

vi.mock("../src/renderer/store.ts", () => ({
  useStore: (select: (state: { projects: unknown[] }) => unknown) => select({ projects: [] }),
}));

const command: CustomCommand = {
  id: "review.md",
  name: "/review",
  filePath: "/mock/commands/review.md",
  revision: "revision",
  enabled: true,
  prompt: "Review $ARGUMENTS",
};
function editor(initial?: CustomCommand, busy = false) {
  return renderToStaticMarkup(
    createElement(CommandEditor, {
      initial,
      busy,
      scopeControl: createElement("button", { type: "button" }, "用户"),
      onSave: async () => {},
      onDelete: () => {},
      onCancel: () => {},
    }),
  );
}

// These are server-rendered component contracts, not browser layout/cascade assertions.
describe("command settings presentation", () => {
  it("announces initial loading and disables the refresh action while pending", () => {
    const html = renderToStaticMarkup(
      createElement(CommandSettings, { breadcrumbContainer: null, onEditingChange: () => {} }),
    );
    expect(html).toContain('aria-label="刷新命令" aria-busy="true" disabled=""');
    expect(html).toContain('class="command-loading" role="status"');
    expect(html).toContain("加载中...");
    expect(html).not.toContain("尚未安装命令");
  });
  it("keeps new drafts invalid until both required fields are supplied", () => {
    const html = editor();
    expect(html).toContain('class="command-new" type="submit" disabled=""');
    expect(html).toContain("描述（可选）");
    expect(html).toContain("参数提示（可选）");
    expect(html).not.toContain('class="command-delete"');
  });
  it("renders editable contents but locks an existing command's name", () => {
    const html = editor(command);
    expect(html).toContain('disabled="" maxLength="50" value="review"');
    expect(html).toContain('class="command-new" type="submit">保存');
    expect(html).toContain('class="command-delete"');
    expect(html).toContain("Review $ARGUMENTS");
  });
  it("blocks saving an unreadable linked command while preserving deletion", () => {
    const html = editor({ ...command, unreadable: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain('class="command-new" type="submit" disabled=""');
    expect(html).toContain('class="command-delete"><svg');
  });
  it("disables all editor actions and inputs while saving", () => {
    const html = editor(command, true);
    expect(html).toContain('class="command-new" type="submit" disabled="">保存中...');
    expect(html).toContain('class="command-delete" disabled=""');
    expect(html).toContain('type="button" disabled="">取消');
    expect(html.match(/disabled=""/g)).toHaveLength(7);
  });
});
