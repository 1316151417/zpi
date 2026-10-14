import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { SessionEntry } from "zpi-coding-agent";
import type { InputQueue } from "zpi-ui";
import { HistoryIndex } from "../../packages/desktop/src/main/history-index.ts";
import { validateSubagentProfileState } from "../../packages/desktop/src/main/plugins/subagents/profiles.ts";
import { StateStore, type TaskState } from "../../packages/desktop/src/main/state-store.ts";
import {
  acquireStorageLock,
  activateStorageGeneration,
  generationDirectory,
  type StorageGeneration,
} from "../../packages/desktop/src/main/storage-generation.ts";
import {
  decodeTranscriptEntry,
  encodeTranscriptEntry,
  validateTranscriptHeader,
} from "../../packages/desktop/src/main/transcript-v2.ts";
import type { ProjectRecord } from "../../packages/desktop/src/shared/bridge.ts";
import type { TaskGroupState } from "../../packages/desktop/src/shared/task-groups.ts";
import {
  type LegacySession,
  lines,
  object,
  type Row,
  readLegacySession,
  recoveredQueue,
  systemSnapshot,
} from "./legacy.ts";
import { recoverLegacyJournals } from "./legacy-journal.ts";
import { migrateLegacySettings } from "./legacy-settings.ts";

export interface Fingerprint {
  path: string;
  size: number;
  sha256: string;
}
export interface MigrationPlan {
  adapterVersion: 1;
  migrationId: string;
  recoveryAt: string;
  source: string;
  fingerprint: string;
  files: Fingerprint[];
  omittedRootEntries?: string[];
  blockers: { path: string; reason: string }[];
  sessions: { id: string; path: string; entries: number; counts: Record<string, number> }[];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const part of createReadStream(path)) digest.update(part);
  return digest.digest("hex");
}
const legacyRoots = new Set([
  "agent",
  "agents",
  "agents-state.json",
  "settings.json",
  "projects.json",
  "task-groups.json",
  "drafts",
  "credentials.enc",
  "chatgpt-host.json",
]);
export async function inventory(root: string, legacyOnly = false): Promise<Fingerprint[]> {
  const files: Fingerprint[] = [];
  async function walk(dir: string) {
    for (const entry of (await readdir(dir)).sort()) {
      if (legacyOnly && dir === root && !legacyRoots.has(entry)) continue;
      const path = join(dir, entry),
        info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`symbolic link rejected: ${relative(root, path)}`);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile())
        files.push({ path: relative(root, path), size: info.size, sha256: await fileHash(path) });
      else throw new Error(`special file rejected: ${relative(root, path)}`);
    }
  }
  await walk(root);
  return files;
}
function fingerprint(files: Fingerprint[]): string {
  return hash(JSON.stringify(files));
}
export async function inspect(source: string): Promise<MigrationPlan> {
  source = await realpath(source);
  if (
    await stat(join(source, ".storage-lock")).then(
      () => true,
      () => false,
    )
  )
    throw new Error("source is locked by a runtime; stop it first");
  const files = await inventory(source, true);
  const plan: MigrationPlan = {
    adapterVersion: 1,
    migrationId: randomUUID(),
    recoveryAt: new Date().toISOString(),
    source,
    fingerprint: fingerprint(files),
    files,
    omittedRootEntries: (await readdir(source)).filter((name) => !legacyRoots.has(name)).sort(),
    blockers: [],
    sessions: [],
  };
  try {
    const settings = await optionalJson(source, "settings.json");
    if (settings !== undefined) migrateLegacySettings(settings);
  } catch (error) {
    plan.blockers.push({ path: "settings.json", reason: String(error) });
  }
  try {
    const profiles = await optionalJson(source, "agents-state.json");
    if (profiles !== undefined) validateSubagentProfileState(profiles);
  } catch (error) {
    plan.blockers.push({ path: "agents-state.json", reason: String(error) });
  }
  const ids = new Set<string>();
  for (const file of files.filter((f) => /^agent[/\\]sessions[/\\].+\.jsonl$/.test(f.path))) {
    try {
      const session = await readLegacySession(join(source, file.path));
      try {
        const id = String(session.header.id);
        if (ids.has(id)) throw new Error("duplicate session ID");
        ids.add(id);
        if (file.path.split(sep).at(-1) !== `${id}.jsonl`)
          throw new Error("session ID differs from filename");
        const project = file.path.split(sep).at(-2);
        if (
          session.state["zpi.session_meta"]?.projectId !== undefined &&
          (session.state["zpi.session_meta"].projectId ?? "_unassigned") !== project
        )
          throw new Error("project ownership differs from directory");
        recoveredQueue(session);
        for (const entry of cleanEntries(session, plan))
          encodeTranscriptEntry(entry as unknown as SessionEntry, Number(entry.seq));
        plan.sessions.push({ id, path: file.path, entries: session.entries.length, counts: session.counts });
      } finally {
        session.close();
      }
    } catch (error) {
      plan.blockers.push({ path: file.path, reason: String(error) });
    }
  }
  for (const file of files.filter((f) => /^drafts[/\\].+\.json$/.test(f.path))) {
    if (
      !ids.has(
        file.path
          .split(sep)
          .at(-1)
          ?.replace(/\.json$/, "") ?? "",
      )
    )
      plan.blockers.push({ path: file.path, reason: "orphan draft requires explicit recovery" });
  }
  if (fingerprint(await inventory(source, true)) !== plan.fingerprint)
    throw new Error("source changed during inspection");
  return plan;
}
async function durableJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`,
    file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}
async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function checkPlan(plan: MigrationPlan) {
  if (
    await stat(join(plan.source, ".storage-lock")).then(
      () => true,
      () => false,
    )
  )
    throw new Error("source is locked by a runtime; stop it first");
  if (fingerprint(plan.files) !== plan.fingerprint) throw new Error("plan inventory fingerprint mismatch");
  if (plan.adapterVersion !== 1 || !/^[\w-]+$/.test(plan.migrationId) || plan.blockers.length)
    throw new Error("unsupported or blocked migration plan");
  const sessionPaths = plan.files
    .filter((file) => /^agent[/\\]sessions[/\\].+\.jsonl$/.test(file.path))
    .map((file) => file.path)
    .sort();
  if (!isDeepStrictEqual(sessionPaths, plan.sessions.map((session) => session.path).sort()))
    throw new Error("plan session inventory mismatch");
  if (fingerprint(await inventory(plan.source, true)) !== plan.fingerprint)
    throw new Error("source fingerprint changed; make a new plan");
}
export async function savePlan(source: string, destination: string) {
  const plan = await inspect(source);
  if (inside(plan.source, await canonicalDestination(destination)))
    throw new Error("plan must be outside read-only source");
  await durableJson(destination, plan);
  return plan;
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
async function canonicalDestination(path: string): Promise<string> {
  path = resolve(path);
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalDestination(dirname(path)), path.slice(dirname(path).length + 1));
  }
}
async function withMaintenance<T>(
  source: string,
  target: string,
  stopped: boolean,
  action: () => Promise<T>,
): Promise<T> {
  if (!stopped) throw new Error("stop all old/new runtimes and background writers; pass --offline-confirmed");
  source = await realpath(source);
  const canonicalTarget = await canonicalDestination(target);
  if (canonicalTarget !== resolve(target)) throw new Error("target must not traverse symbolic links");
  target = canonicalTarget;
  if (inside(source, target) || inside(target, source)) throw new Error("source and target must be disjoint");
  await mkdir(target, { recursive: true });
  if ((await realpath(target)) !== target) throw new Error("target must not traverse symbolic links");
  // Legacy runtimes do not honor this lock. The explicit offline prerequisite is mandatory.
  const lockPath = join(dirname(source), `.${hash(source).slice(0, 16)}.storage-maintenance.lock`);
  const lock = await open(lockPath, "wx", 0o600);
  let releaseTarget: (() => void) | undefined;
  try {
    releaseTarget = acquireStorageLock(target, "migration");
    await lock.writeFile(JSON.stringify({ pid: process.pid, source, target }));
    await lock.sync();
    return await action();
  } finally {
    releaseTarget?.();
    await lock.close();
    await rm(lockPath);
  }
}
const pathKeys = new Set([
  "path",
  "outputPath",
  "outputFile",
  "beforeFile",
  "afterFile",
  "patchFile",
  "fileReferences",
]);
function rewritePaths(
  value: unknown,
  source: string,
  destination: string,
  files: Fingerprint[],
  key = "",
): unknown {
  if (typeof value === "string" && pathKeys.has(key) && value.startsWith(`${source}${sep}`)) {
    const path = relative(source, value);
    if (!inside(source, resolve(source, path)) || !files.some((file) => file.path === path))
      throw new Error("missing or unsafe managed reference");
    if (!/^agent[/\\](attachments|tool-output|file-changes|session-context)[/\\]/.test(path))
      throw new Error("unsupported managed reference");
    return join(destination, path);
  }
  if (Array.isArray(value)) return value.map((item) => rewritePaths(item, source, destination, files, key));
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [
        field,
        rewritePaths(item, source, destination, files, field),
      ]),
    );
  return value;
}
function* cleanEntries(session: LegacySession, plan: MigrationPlan): Generator<Row> {
  const entries = recoverLegacyJournals(session.entries, plan.migrationId, plan.recoveryAt);
  let index = 0;
  let parentId: string | null = null;
  let model: Row | null = null,
    thinkingLevel: unknown = "off",
    lastThinkingLevel: unknown = "medium",
    hasThinkingEntry = false;
  for (const entry of entries) {
    let output: Row;
    if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
    if (entry.type === "message" && object(entry.message) && entry.message.role === "assistant")
      model = { provider: entry.message.provider, modelId: entry.message.model };
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
      hasThinkingEntry = true;
      if (thinkingLevel !== "off") lastThinkingLevel = thinkingLevel;
    }
    if (entry.type === "message") output = { ...entry };
    else if (entry.type === "compaction")
      output = {
        ...entry,
        systemMessage:
          entry.systemMessage ??
          systemSnapshot(session.entries, String(entry.id), Date.parse(String(entry.timestamp))),
      };
    else if (
      entry.type === "custom" &&
      [
        "zpi.run",
        "zpi.agent_call",
        "zpi.context_boundary",
        "zpi.streaming_tools",
        "zpi.compaction",
        "zpi.notice",
      ].includes(String(entry.customType))
    )
      output = { ...entry };
    // Retain all original IDs as neutral anchors, including metadata referenced by compaction.
    else
      output = {
        id: entry.id,
        timestamp: entry.timestamp,
        type: "custom",
        customType: "zpi.context_boundary",
        data: ["model_change", "thinking_level_change"].includes(String(entry.type))
          ? { historyConfiguration: { model, thinkingLevel, lastThinkingLevel, hasThinkingEntry } }
          : {},
      };
    output.parentId = parentId;
    output.seq = index + 1;
    parentId = String(output.id);
    index++;
    yield output;
  }
}
async function optionalJson(root: string, path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(root, path), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function migratedTask(
  session: LegacySession,
  item: MigrationPlan["sessions"][number],
): TaskState & { sessionFile: string } {
  const environment = session.state["zpi.environment"] ?? {},
    meta = session.state["zpi.session_meta"] ?? {};
  const sessionFile = item.path;
  const latestRun = session.state["zpi.run"];
  const historicalSelection = session.historicalSelection;
  return {
    id: item.id,
    projectId: (meta.projectId ??
      (item.path.split(sep).at(-2) === "_unassigned" ? null : item.path.split(sep).at(-2))) as string | null,
    title: String(session.state.session_info?.name ?? "新对话"),
    createdAt: Date.parse(String(session.header.timestamp)),
    updatedAt: Date.parse(String(session.lastTimestamp ?? session.header.timestamp)),
    cwd: String(session.header.cwd),
    ...environment,
    ...meta,
    running: false,
    draft: meta.draft === true && !session.counts["zpi.run"],
    status: latestRun?.phase === "start" ? "interrupted" : latestRun?.status,
    unreadAt: session.state["zpi.attention"]?.unreadAt ?? undefined,
    sessionFile,
    titleState: session.state["zpi.title"]?.state,
    lastThinkingLevel: historicalSelection.lastThinkingLevel,
    fork: session.state["zpi.fork"]
      ? { sessionId: session.state["zpi.fork"].parentSessionId, runId: session.state["zpi.fork"].runId }
      : undefined,
    currentSelection: session.state["zpi.selection"] ?? historicalSelection.selection,
    frozenConfiguration: session.state["zpi.configuration"]
      ? {
          ...session.state["zpi.configuration"],
          communicationStyle: session.state["zpi.configuration"].communicationStyle ?? false,
        }
      : undefined,
  } as unknown as TaskState & { sessionFile: string };
}
export async function convert(plan: MigrationPlan, target: string, stopped = false): Promise<string> {
  return withMaintenance(plan.source, target, stopped, async () => {
    await checkPlan(plan);
    const final = generationDirectory(target, plan.migrationId);
    const stage = `${final}.staging`;
    const relocate = (value: unknown) => rewritePaths(value, plan.source, final, plan.files);
    // Never resume based on existence: an incomplete generation is explicitly quarantined.
    try {
      await stat(stage);
      throw new Error("staging exists; preserve it for diagnosis and create a fresh plan");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(stage), { recursive: true });
    await mkdir(stage);
    await durableJson(join(stage, "plan.json"), plan);
    const store = new StateStore(join(stage, "state.sqlite"));
    try {
      const projects = (await optionalJson(plan.source, "projects.json")) ?? [];
      if (!Array.isArray(projects)) throw new Error("invalid projects");
      store.setProjects(projects as ProjectRecord[]);
      const settings = await optionalJson(plan.source, "settings.json");
      if (settings !== undefined) store.setSetting("app", migrateLegacySettings(settings));
      const profiles = await optionalJson(plan.source, "agents-state.json");
      if (profiles !== undefined) {
        validateSubagentProfileState(profiles);
        store.setSetting("subagentProfiles", profiles);
      }
      const pending: {
        task: TaskState & { sessionFile: string };
        state: LegacySession["state"];
        queue: Row;
      }[] = [];
      for (const item of plan.sessions) {
        const session = await readLegacySession(join(plan.source, item.path));
        try {
          const entries = cleanEntries(session, plan);
          const sessionFile = join(
            "agent",
            "sessions",
            item.path.split(sep).at(-2) ?? "_unassigned",
            `${item.id}.jsonl`,
          );
          await mkdir(dirname(join(stage, sessionFile)), { recursive: true });
          const handle = await open(join(stage, sessionFile), "wx", 0o600);
          try {
            await handle.writeFile(
              `${JSON.stringify({ ...session.header, version: 2, generation: plan.migrationId })}\n`,
            );
            for (const entry of entries)
              await handle.writeFile(
                `${JSON.stringify(encodeTranscriptEntry(relocate(entry) as unknown as SessionEntry, Number(entry.seq)))}\n`,
              );
            await handle.sync();
          } finally {
            await handle.close();
          }
          const task = migratedTask(session, item);
          // Only recovery state is needed after this transcript is written.
          pending.push({ task, state: session.state, queue: recoveredQueue(session) });
        } finally {
          session.close();
        }
      }
      while (pending.length) {
        const at = pending.findIndex(
          ({ task }) =>
            !task.parentSessionId || !pending.some((other) => other.task.id === task.parentSessionId),
        );
        if (at < 0) throw new Error("cyclic parent task references");
        const { task, state, queue } = pending.splice(at, 1)[0];
        store.upsertTask(task);
        store.setQueue(task.id, relocate(queue) as InputQueue);
        const draft = await optionalJson(plan.source, join("drafts", `${task.id}.json`));
        if (draft !== undefined) store.saveDraft(task.id, relocate(draft) as { revision: number });
        for (const [key, value] of Object.entries(state)) {
          if (key.startsWith("zpi.background_task:") || key === "zpi.subagent_task") {
            const kind = key === "zpi.subagent_task" ? "subagent" : "background";
            const id = String(value.taskId ?? value.agentId ?? "");
            if (!id || (kind === "background" && key !== `zpi.background_task:${id}`))
              throw new Error("invalid runtime identity");
            store.setRuntime(
              task.id,
              kind,
              id,
              relocate({
                ...value,
                status:
                  value.status === "running"
                    ? kind === "background"
                      ? "lost"
                      : "interrupted"
                    : value.status,
                waitingForInput: false,
                recoveryAt: plan.recoveryAt,
              }),
              String(
                value.status === "running" ? (kind === "background" ? "lost" : "interrupted") : value.status,
              ),
            );
          }
        }
        const index = new HistoryIndex(join(stage, task.sessionFile), store.db);
        await index.load();
      }
      const groups = await optionalJson(plan.source, "task-groups.json");
      if (groups !== undefined) store.setTaskGroups(groups as TaskGroupState);
      store.checkpoint();
    } finally {
      store.close();
    }
    // Copy managed payloads byte-for-byte. Authentication blobs are never parsed or decrypted.
    for (const file of plan.files.filter((file) =>
      /^(agent[/\\](?!sessions[/\\])|agents[/\\]|credentials\.enc$|chatgpt-host\.json$)/.test(file.path),
    )) {
      const output = join(stage, file.path);
      await mkdir(dirname(output), { recursive: true });
      if (/^agent[/\\]attachments[/\\][^/\\]+[/\\]index\.json$/.test(file.path)) {
        await durableJson(output, relocate(JSON.parse(await readFile(join(plan.source, file.path), "utf8"))));
      } else await copyFile(join(plan.source, file.path), output);
      const handle = await open(output, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await checkPlan(plan);
    await durableJson(join(stage, "manifest.json"), {
      migrationId: plan.migrationId,
      files: await inventory(stage),
      sourceFingerprint: plan.fingerprint,
      relocation: { source: plan.source, destination: final, fields: [...pathKeys] },
      needsReauthentication: true,
    });
    await validate(stage);
    return stage;
  });
}
export async function validate(generation: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(generation, "manifest.json"), "utf8")) as {
    files: Fingerprint[];
    migrationId: string;
    sourceFingerprint: string;
    relocation: { source: string; destination: string };
  };
  for (const file of manifest.files) {
    if (!inside(resolve(generation), resolve(generation, file.path)))
      throw new Error("manifest path escapes generation");
    if ((await fileHash(join(generation, file.path))) !== file.sha256)
      throw new Error(`target fingerprint mismatch: ${file.path}`);
  }
  const plan = JSON.parse(await readFile(join(generation, "plan.json"), "utf8")) as MigrationPlan;
  if (manifest.migrationId !== plan.migrationId || manifest.sourceFingerprint !== plan.fingerprint)
    throw new Error("manifest does not match plan");
  await checkPlan(plan);
  const relocate = (value: unknown) =>
    rewritePaths(value, plan.source, manifest.relocation.destination, plan.files);
  const db = new DatabaseSync(join(generation, "state.sqlite"), { readOnly: true });
  try {
    const tasks = db
      .prepare("SELECT id,data,json_extract(data,'$.sessionFile') AS session_file FROM tasks")
      .all();
    if (tasks.length !== plan.sessions.length) throw new Error("task count differs from plan");
    for (const item of plan.sessions) {
      const task = tasks.find((row) => row.id === item.id);
      if (!task || task.session_file !== item.path) throw new Error("task transcript ownership mismatch");
      const legacy = await readLegacySession(join(plan.source, item.path));
      try {
        const expectedTask = migratedTask(legacy, item);
        const actualTask = JSON.parse(String(task.data));
        delete expectedTask.running;
        // Group assignment is normalized into columns separately by StateStore.
        for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(expectedTask))))
          if (!isDeepStrictEqual(actualTask[key], value))
            throw new Error(`task state mismatch: ${item.id}:${key}`);
        const draft = await optionalJson(plan.source, join("drafts", `${item.id}.json`));
        if (draft !== undefined) {
          const saved = db.prepare("SELECT data FROM drafts WHERE task_id=?").get(item.id);
          if (!saved || !isDeepStrictEqual(JSON.parse(String(saved.data)), relocate(draft)))
            throw new Error("draft migration mismatch");
        }
        const expected = cleanEntries(legacy, plan);
        let ordinal = -1;
        for await (const { value } of lines(join(generation, item.path))) {
          if (ordinal === -1) {
            const header = validateTranscriptHeader(value);
            if (header.id !== item.id || header.generation !== plan.migrationId)
              throw new Error("transcript header mismatch");
          } else {
            decodeTranscriptEntry(value);
            const next = expected.next();
            if (
              next.done ||
              !isDeepStrictEqual(
                value,
                encodeTranscriptEntry(relocate(next.value) as unknown as SessionEntry, ordinal + 1),
              )
            )
              throw new Error(`transcript semantic mismatch: ${item.path}:${ordinal + 2}`);
          }
          ordinal++;
        }
        if (!expected.next().done) throw new Error("transcript count mismatch");
        const queue = db.prepare("SELECT data FROM queue_state WHERE task_id=?").get(item.id);
        if (
          !queue ||
          !isDeepStrictEqual(
            {
              ...JSON.parse(String(queue.data)),
              items: db
                .prepare("SELECT data FROM queue_items WHERE task_id=? ORDER BY position")
                .all(item.id)
                .map((row) => JSON.parse(String(row.data))),
            },
            relocate(recoveredQueue(legacy)),
          )
        )
          throw new Error("queue recovery mismatch");
      } finally {
        legacy.close();
      }
    }
    const settings = await optionalJson(plan.source, "settings.json");
    if (settings !== undefined) {
      const app = db.prepare("SELECT data FROM app_settings WHERE key='app'").get();
      if (!app || !isDeepStrictEqual(JSON.parse(String(app.data)), migrateLegacySettings(settings)))
        throw new Error("settings migration mismatch");
    }
    const profiles = await optionalJson(plan.source, "agents-state.json");
    if (profiles !== undefined) {
      const saved = db.prepare("SELECT data FROM app_settings WHERE key='subagentProfiles'").get();
      if (!saved || !isDeepStrictEqual(JSON.parse(String(saved.data)), profiles))
        throw new Error("subagent profile state mismatch");
    }
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (
      integrity.length !== 1 ||
      Object.values(integrity[0])[0] !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("database validation failed");
  } finally {
    db.close();
  }
}
export async function activate(plan: MigrationPlan, target: string, stopped = false): Promise<string> {
  return withMaintenance(plan.source, target, stopped, async () => {
    await checkPlan(plan);
    const ready = generationDirectory(target, plan.migrationId),
      stage = `${ready}.staging`;
    let active: unknown;
    try {
      active = JSON.parse(await readFile(join(target, "active-generation.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (object(active) && active.generationId === plan.migrationId) {
      await validate(ready);
      return ready;
    }
    const exists = await stat(ready).then(
      () => true,
      () => false,
    );
    const directory = exists ? ready : stage;
    await validate(directory);
    const manifestHash = await fileHash(join(directory, "manifest.json"));
    const marker: StorageGeneration = {
      generationId: plan.migrationId,
      format: 2,
      schemaVersion: 1,
      transcriptVersion: 2,
    };
    await durableJson(join(directory, "ready.json"), { ...marker, manifestHash });
    if (!exists) await rename(stage, ready);
    await syncDirectory(dirname(ready));
    activateStorageGeneration(target, marker);
    return ready;
  });
}
