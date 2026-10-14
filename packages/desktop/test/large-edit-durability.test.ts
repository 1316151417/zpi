import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAssistantMessageEventStream, emptyAssistant } from "zpi-ai";
import { createAgentSession, type FileChange, ModelRuntime, SessionManager } from "zpi-coding-agent";
import { fakeConfig } from "../../../tests/fake-server.ts";
import { directory } from "../../coding-agent/test/helpers/session-fixture.ts";
import { applyFileRewind, planFileRewind } from "../src/main/file-rewind.ts";

for (const sizeMiB of [1, 3]) {
  it(`persists a small edit on a ${sizeMiB} MiB line and preserves eligible rewind snapshots`, async () => {
    const cwd = await realpath(await directory());
    const agentDir = join(cwd, "agent");
    const before = `old${"x".repeat(sizeMiB * 1024 * 1024)}\n`;
    await writeFile(join(cwd, "large.txt"), before);
    let requests = 0;
    const runtime = await ModelRuntime.create();
    runtime.registerProvider("fake", {
      models: [fakeConfig("")],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const message = emptyAssistant(model);
        message.content =
          ++requests === 1
            ? [
                {
                  type: "toolCall",
                  id: "edit-large",
                  name: "edit",
                  arguments: { path: "large.txt", edits: [{ oldText: "old", newText: "new" }] },
                },
              ]
            : [{ type: "text", text: "done" }];
        message.stopReason = requests === 1 ? "toolUse" : "stop";
        stream.push({ type: "start", partial: message });
        stream.end(message);
        return stream;
      },
    });
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      homeDir: join(cwd, "home"),
      modelRuntime: runtime,
      sessionManager: manager,
    });
    try {
      await session.prompt("Make the edit");
      expect(requests).toBe(2);
      expect(await readFile(join(cwd, "large.txt"), "utf8")).toBe(before.replace("old", "new"));
      const file = manager.getSessionFile() as string;
      const reopened = SessionManager.open(file);
      const results = reopened
        .buildSessionContext()
        .messages.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        isError: false,
        details: { diff: expect.stringContaining("omitted"), patch: "", firstChangedLine: 1 },
      });
      expect(Buffer.byteLength(JSON.stringify(results[0]))).toBeLessThan(128 * 1024);
      expect(reopened.buildSessionContext().messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ text: "done" }],
      });
      const transcript = await readFile(file, "utf8");
      SessionManager.open(file);
      expect(await readFile(file, "utf8")).toBe(transcript);
      const change = (results[0].details as unknown as { fileChange: FileChange }).fileChange;
      if (sizeMiB === 1) {
        expect(change.beforeFile).toBeTruthy();
        expect(change.afterFile).toBeTruthy();
        expect(change.patchFile).toBeTruthy();
        expect(change.patch).toBeUndefined();
        expect(await readFile(change.beforeFile as string, "utf8")).toBe(before);
        expect(await readFile(change.afterFile as string, "utf8")).toBe(before.replace("old", "new"));
        expect((await readFile(change.patchFile as string, "utf8")).length).toBeGreaterThan(2 * 1024 * 1024);
        const plan = await planFileRewind(
          [change],
          join(agentDir, "tool-output", manager.getSessionId()),
          cwd,
        );
        expect(plan.conflicts).toEqual([]);
        let committed = false;
        expect(
          applyFileRewind(plan, () => {
            committed = true;
          }),
        ).toEqual([]);
        expect(committed).toBe(true);
        expect(await readFile(join(cwd, "large.txt"), "utf8")).toBe(before);
      } else {
        // The existing combined 4 MiB snapshot limit remains unchanged.
        expect(change.beforeFile).toBeUndefined();
        expect(change.reason).toContain("超限");
      }
    } finally {
      session.dispose();
    }
  });
}
