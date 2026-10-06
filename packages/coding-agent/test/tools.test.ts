import { createBashTool, SessionManager } from "ZPI-coding-agent";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fakeModel } from "../../../tests/fake-server.ts";
import { directory } from "./helpers/session-fixture.ts";

it("bash cancellation and timeout clean descendants, output is snapshot", async () => {
  const cwd = await directory();
  const bash = createBashTool(cwd);
  for (const prefix of ["PI", "ZPI"])
    for (const name of ["SESSION_ID", "SESSION_FILE", "PROVIDER", "MODEL", "REASONING_LEVEL"])
      vi.stubEnv(`${prefix}_${name}`, "inherited-wrong-session");
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const withContext = createBashTool(cwd, undefined, () => ({
    cwd,
    model: fakeModel("http://localhost"),
    sessionManager: manager,
    thinkingLevel: "high",
  }));
  const command = `"${process.execPath}" -e 'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PI|ZPI)_(SESSION_ID|SESSION_FILE|PROVIDER|MODEL|REASONING_LEVEL)$/.test(k)))))'`;
  const metadata = await withContext.execute("metadata", { command });
  expect(metadata.content[0]?.type).toBe("text");
  if (metadata.content[0]?.type === "text")
    expect(JSON.parse(metadata.content[0].text)).toEqual({
      ZPI_SESSION_ID: manager.getSessionId(),
      ZPI_SESSION_FILE: manager.getSessionFile(),
      ZPI_PROVIDER: "fake",
      ZPI_MODEL: "fake",
      ZPI_REASONING_LEVEL: "high",
    });
  const noContext = await bash.execute("no-context", { command });
  expect(noContext.content).toEqual([{ type: "text", text: "{}\n" }]);
  const controller = new AbortController();
  const snapshots: string[] = [];
  const run = bash.execute(
    "../../untrusted",
    { command: "echo first; sleep 30 & wait" },
    controller.signal,
    (r) => {
      if (r.content[0]?.type === "text") {
        snapshots.push(r.content[0].text);
        controller.abort();
      }
    },
  );
  await expect(run).rejects.toThrow("Command aborted");
  expect(snapshots[0]).toBe("first\n");
  await expect(bash.execute("timeout", { command: "sleep 30", timeout: 0.05 })).rejects.toThrow("timed out");
});
