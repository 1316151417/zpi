import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { chunk, done, fakeServer, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";

const codec = {
  isEncryptionAvailable: () => true,
  encryptString: (v: string) => Buffer.from(v),
  decryptString: (v: Buffer) => v.toString(),
};
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture(
  handler: Parameters<typeof fakeServer>[0] = (_, r) => {
    send(r, chunk({ content: "ok" }));
    done(r);
  },
) {
  const dir = await mkdtemp(join(tmpdir(), "zpi-projects-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const server = await fakeServer(handler);
  cleanup.push(server.close);
  const settings = new SettingsStore(dir, codec);
  settings.saveProvider({
    id: "p",
    name: "P",
    baseUrl: server.url,
    apiKey: "fixture-key",
    models: [{ id: "new" }, { id: "plain", reasoning: false }],
  });
  const workspace = join(dir, "workspace");
  const host = new SessionHost(dir, settings, join(dir, "resources"), workspace, undefined, []);
  await host.init();
  cleanup.push(() => host.close());
  return { dir, workspace, host, settings, server };
}

it("nullable ownership uses the real workspace for AGENTS, skills, init and tools, and reloads the reserved partition", async () => {
  let wrote = false;
  const f = await fixture((body, r) => {
    if (JSON.stringify(body).includes("create or edit ONLY") && !wrote) {
      wrote = true;
      send(
        r,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "init-write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "AGENTS.md", content: "workspace instructions" }),
              },
            },
          ],
        }),
      );
      done(r, "tool_calls");
    } else {
      send(r, chunk({ content: "done" }));
      done(r);
    }
  });
  expect(existsSync(f.workspace)).toBe(false);
  const s = f.host.createSession(null);
  expect(s).toMatchObject({ projectId: null, cwd: f.workspace });
  expect(f.host.listProjects()).toEqual([]);
  await mkdir(join(f.workspace, ".zpi", "skills", "inspect"), { recursive: true });
  await writeFile(
    join(f.workspace, ".zpi", "skills", "inspect", "SKILL.md"),
    "---\nname: inspect\ndescription: Workspace\n---\nWORKSPACE SKILL",
  );
  expect((await f.host.listSessionSkills(s.id)).skills.map((s) => s.name)).toContain("inspect");
  await f.host.setSessionSelection(s.id, { provider: "p", modelId: "new", reasoning: "none" });
  await f.host.startRun({ sessionId: s.id, text: "/init" });
  await f.host.activeRuns.get(s.id)?.done;
  expect(await readFile(join(f.workspace, "AGENTS.md"), "utf8")).toBe("workspace instructions");
  expect(f.server.requests.every((r) => r.reasoning_effort === "none")).toBe(true);
  await f.host.startRun({ sessionId: s.id, text: "$inspect inspect" });
  await f.host.activeRuns.get(s.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1))).toContain("WORKSPACE SKILL");
  expect(JSON.stringify(f.server.requests.at(-1))).toContain("workspace instructions");
  const file = join(f.dir, "agent", "sessions", "_unassigned", `${s.id}.jsonl`);
  expect(await readFile(file, "utf8")).toContain('"projectId":null');
  const restarted = new SessionHost(f.dir, f.settings, join(f.dir, "resources"), f.workspace, undefined, []);
  await restarted.init();
  cleanup.push(() => restarted.close());
  expect(restarted.getSessionSnapshot(s.id).session.cwd).toBe(f.workspace);
  expect(restarted.listRecentSessions().map((s) => s.id)).toEqual([s.id]);
  const p = await f.host.addProject(f.workspace);
  const explicit = f.host.createSession(p.id);
  expect(explicit.projectId).toBe(p.id);
  expect(f.host.listSessions(p.id).map((s) => s.id)).toEqual([explicit.id]);
  expect(() => f.host.createSession("missing")).toThrow("项目不存在");
});

it("five pins are enforced globally, idempotently and persist through unpin/archive/restart", async () => {
  const f = await fixture();
  const project = await f.host.addProject(f.dir);
  const tasks = Array.from({ length: 7 }, (_, i) => f.host.createSession(i % 2 ? project.id : null));
  for (const task of tasks.slice(0, 5)) f.host.setSessionPinned(task.id, true);
  const initial = f.host.listRecentSessions().filter((r) => r.pinnedAt != null);
  expect(() => f.host.setSessionPinned(tasks[5].id, true)).toThrow("最多置顶 5 个");
  expect(f.host.setSessionPinned(tasks[0].id, true).pinnedAt).toBe(initial[0].pinnedAt);
  f.host.setSessionPinned(tasks[0].id, false);
  f.host.setSessionPinned(tasks[5].id, true);
  await f.host.archiveSession(tasks[1].id);
  f.host.setSessionPinned(tasks[6].id, true);
  expect(() => f.host.setSessionPinned(tasks[1].id, true)).toThrow();
  await f.host.close();
  const restarted = new SessionHost(f.dir, f.settings, join(f.dir, "resources"), f.workspace, undefined, []);
  await restarted.init();
  cleanup.push(() => restarted.close());
  expect(
    restarted
      .listRecentSessions()
      .filter((r) => r.pinnedAt != null)
      .map((r) => r.id),
  ).toEqual(tasks.slice(2).map((r) => r.id));
  expect(() => restarted.setSessionPinned(tasks[0].id, true)).toThrow("最多置顶 5 个");
});
