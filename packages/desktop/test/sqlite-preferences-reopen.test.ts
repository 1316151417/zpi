import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DraftStore } from "../src/main/draft-store.ts";
import { StateStore } from "../src/main/state-store.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { TaskGroupsStore } from "../src/main/task-groups.ts";

it("reopens settings, groups and drafts from disk without touching legacy public files", async () => {
  const root = await mkdtemp(join(tmpdir(), "zpi-preferences-reopen-"));
  const path = join(root, "state.sqlite");
  const encryption = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };
  let state = new StateStore(path);
  try {
    const task = { id: "task", title: "Task", projectId: null, createdAt: 1, updatedAt: 1 };
    state.upsertTask(task);
    const settings = new SettingsStore(root, encryption, state);
    settings.updatePreferences({ theme: "dark" });
    const groups = new TaskGroupsStore(state);
    const group = groups.update({ type: "create" }, [task]).groups[0];
    groups.update({ type: "rename", id: group.id, title: "Saved group" }, [task]);
    const expectedGroups = groups.update({ type: "moveTask", id: task.id, groupId: group.id }, [task]);
    const draft = {
      text: "Saved draft",
      fileReferences: [],
      selection: [2, 4] as [number, number],
      revision: 7,
    };
    new DraftStore(state).save(task.id, draft);
    for (const file of ["settings.json", "task-groups.json", "projects.json"])
      await writeFile(join(root, file), "legacy invalid JSON");
    state.close();
    state = new StateStore(path);
    expect(new SettingsStore(root, encryption, state).get().interface.theme).toBe("dark");
    expect(new TaskGroupsStore(state).get([task])).toEqual(expectedGroups);
    expect(new DraftStore(state).get(task.id)).toEqual(draft);
    for (const file of ["settings.json", "task-groups.json", "projects.json"])
      expect(await readFile(join(root, file), "utf8")).toBe("legacy invalid JSON");
  } finally {
    state.close();
    await rm(root, { recursive: true, force: true });
  }
});
