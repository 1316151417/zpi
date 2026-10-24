import { expect, test } from "vitest";
import { emptyAssistant, type JsonObject } from "zpi-ai";
import { type SessionEntry, SessionManager } from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
import { memoryEvidence } from "../src/main/memory/evidence.ts";

const assistant = emptyAssistant(fakeModel("http://localhost"));
function human(manager: SessionManager, text: string) {
  manager.appendCustomEntry("zpi.run", { phase: "start", text });
}
function prose(manager: SessionManager, text: string) {
  manager.appendMessage({ ...assistant, content: [{ type: "text", text }] });
}
function call(manager: SessionManager, id: string, name: string, args: JsonObject) {
  manager.appendMessage({ ...assistant, content: [{ type: "toolCall", id, name, arguments: args }] });
}
function result(manager: SessionManager, id: string, name: string, text: string) {
  manager.appendMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  });
}
function evidence(manager: SessionManager) {
  return memoryEvidence("Source title", "sess_source", manager.getEntries().reverse());
}

test("retains original human input while excluding system, prepared context, reasoning and metadata", () => {
  const manager = SessionManager.inMemory();
  human(manager, "请记住我明确要求中文回复");
  manager.appendMessage({ role: "user", content: "prepared user: recalled preference", timestamp: 1 });
  manager.appendMessage({
    role: "system",
    content: "system memory injection",
    sections: { "zpi.instructions": "injected short and long memories" },
    timestamp: 1,
  });
  manager.appendMessage({
    ...assistant,
    content: [
      { type: "thinking", thinking: "private thinking" },
      { type: "text", text: "I suggest using tabs; awaiting your decision." },
      { type: "text", text: "<system-reminder>old memory reminder</system-reminder>" },
    ],
  });
  manager.appendCustomEntry("zpi.configuration", { text: "configuration detail" });
  const text = evidence(manager);
  expect(text).toMatch(/## User[^\n]*\n请记住我明确要求中文回复/);
  expect(text).toMatch(/## Assistant[^\n]*\nI suggest using tabs; awaiting your decision\./);
  for (const excluded of [
    "prepared user",
    "system memory injection",
    "injected short and long memories",
    "private thinking",
    "old memory reminder",
    "configuration detail",
  ])
    expect(text).not.toContain(excluded);
});

test.each([
  ["read", { path: "/home/.zpi/MEMORY.md" }],
  ["read", { path: "MEMORY.md" }],
  ["write", { path: "/project/MEMORY.md", content: "DERIVATIVE PREFERENCE" }],
  ["edit", { path: "C:\\workspace\\MEMORY.md", oldText: "x", newText: "DERIVATIVE PREFERENCE" }],
  ["read", { file_path: "/storage/memories/memory_summary.md" }],
  ["read", { path: "/storage/memories/raw_memories.md" }],
  ["read", { path: "/storage/memories/rollout_summaries/source.md" }],
  ["bash", { command: "cat ~/.zpi/MEMORY.md" }],
  ["bash", { command: "rg preference /storage/memories/rollout_summaries/source.md" }],
] satisfies [string, JsonObject][])("omits memory operation %s %j and its result", (name, args) => {
  const manager = SessionManager.inMemory();
  human(manager, "Inspect the project.");
  call(manager, "memory-call", name, args);
  result(manager, "memory-call", name, "DERIVATIVE PREFERENCE from previous memory");
  call(manager, "code-call", "read", { path: "package.json" });
  result(manager, "code-call", "read", "OBSERVED PROJECT FACT");
  const text = evidence(manager);
  expect(text).not.toContain("DERIVATIVE PREFERENCE");
  expect(text).not.toContain("memory-call");
  expect(text).toContain("package.json");
  expect(text).toContain("OBSERVED PROJECT FACT");
});

test("does not mistake source code mentioning memory files for a memory-file operation", () => {
  const manager = SessionManager.inMemory();
  human(manager, "Implement short memory.");
  call(manager, "code", "write", { path: "short-memory.ts", content: 'const path = "MEMORY.md";' });
  result(manager, "code", "write", "Wrote the implementation.");
  expect(evidence(manager)).toContain("short-memory.ts");
  expect(evidence(manager)).toContain("Wrote the implementation.");
});

test("preserves genuine question answers even when the question discusses a memory filename", () => {
  const manager = SessionManager.inMemory();
  human(manager, "Clarify my preferences.");
  call(manager, "question", "AskUserQuestion", {
    questions: [{ question: "What should MEMORY.md remember?", options: ["English", "Chinese"] }],
  });
  result(
    manager,
    "question",
    "AskUserQuestion",
    'User answers: {"answers":{"What should MEMORY.md remember?":"Always Chinese"}}.',
  );
  const text = evidence(manager);
  expect(text).toContain("Tool AskUserQuestion");
  expect(text).toContain("Always Chinese");
  expect(text).toContain("Suggested options, skipped questions and timeouts are not answers");
});

test("excludes the entire background notification run and resumes at the next real user turn", () => {
  const manager = SessionManager.inMemory();
  human(manager, "First user request.");
  prose(manager, "First assistant response.");
  manager.appendCustomEntry("zpi.run", { phase: "end" });
  manager.appendCustomEntry("zpi.run", {
    phase: "start",
    text: "BACKGROUND USER-LIKE TEXT",
    subagentNotification: { agentId: "child" },
  });
  prose(manager, "BACKGROUND ASSISTANT OUTPUT");
  call(manager, "background", "read", { path: "background-source.ts" });
  result(manager, "background", "read", "BACKGROUND TOOL OUTPUT");
  manager.appendCustomEntry("zpi.run", { phase: "end" });
  human(manager, "Second real user request.");
  prose(manager, "Second assistant response.");
  const text = evidence(manager);
  for (const expected of [
    "First user request",
    "First assistant response",
    "Second real user request",
    "Second assistant response",
  ])
    expect(text).toContain(expected);
  for (const excluded of ["BACKGROUND", "background-source.ts"]) expect(text).not.toContain(excluded);
});

test("drops a partial oldest run at the 4000-record boundary and reads at most one lookahead record", () => {
  const manager = SessionManager.inMemory();
  human(manager, "EXPIRED USER INPUT");
  prose(manager, "ORPHANED ASSISTANT EVIDENCE");
  for (let i = 0; i < 3998; i++) manager.appendCustomEntry("noise", { i });
  human(manager, "Current intact user input");
  prose(manager, "Current intact response");
  let reads = 0;
  function* records(): Iterable<SessionEntry> {
    for (const entry of manager.getEntries().reverse()) {
      reads++;
      yield entry;
    }
  }
  const text = memoryEvidence("Title", "sess_source", records());
  expect(reads).toBe(4001);
  expect(text).toContain("Evidence limited to the latest 4000 history records");
  expect(text).toContain("Current intact user input");
  expect(text).toContain("Current intact response");
  expect(text).not.toContain("EXPIRED USER INPUT");
  expect(text).not.toContain("ORPHANED ASSISTANT EVIDENCE");
});

test("bounds long individual messages and total history with explicit truncation markers", () => {
  const manager = SessionManager.inMemory();
  for (let i = 0; i < 15; i++) {
    human(manager, `User ${i}`);
    prose(manager, `Response ${i}: ${"x".repeat(20000)}`);
  }
  const text = memoryEvidence("t".repeat(20000), "i".repeat(20000), manager.getEntries().reverse());
  expect(text).toContain("[Message truncated]");
  expect(text).toContain("[Earlier history omitted; recent transcript follows]");
  expect(text).toContain("Response 14");
  expect(text.length).toBeLessThan(130000);
});

test("redacts common credential values in human, assistant, tool and title evidence", () => {
  const manager = SessionManager.inMemory();
  human(manager, 'apiKey="private-api-value"; OPENAI_API_KEY=private-env-value; password: private-password');
  prose(manager, "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789");
  call(manager, "credentials", "bash", { command: "echo token diagnostics" });
  result(
    manager,
    "credentials",
    "bash",
    "https://name:private-url-password@example.com/path sk-privateSecret123 ghp_123456789012345678901234567890 eyJsecret.payload.signature",
  );
  const text = memoryEvidence(
    "github_pat_123456789012345678901234",
    "session",
    manager.getEntries().reverse(),
  );
  for (const secret of [
    "private-api-value",
    "private-env-value",
    "private-password",
    "abcdefghijklmnopqrstuvwxyz0123456789",
    "private-url-password",
    "sk-privateSecret123",
    "ghp_123456789012345678901234567890",
    "eyJsecret.payload.signature",
    "github_pat_123456789012345678901234",
  ])
    expect(text).not.toContain(secret);
  expect(text).toContain("[REDACTED]");
  expect(text).toContain("example.com/path");
});

test("preserves ordinary user discussion of keys, tokens, passwords and Basic authentication", () => {
  const manager = SessionManager.inMemory();
  const original =
    "Use Basic authentication in this test. The token budget is 2000. API keys stay local. Password rules: use a password manager.";
  human(manager, original);
  expect(evidence(manager)).toContain(original);
});

test("redacts private key material, including a key cut off by message truncation", () => {
  const manager = SessionManager.inMemory();
  human(manager, "-----BEGIN PRIVATE KEY-----\nPRIVATE KEY CONTENT\n-----END PRIVATE KEY-----");
  expect(evidence(manager)).not.toContain("PRIVATE KEY CONTENT");
  human(manager, `-----BEGIN RSA PRIVATE KEY-----\nSECRET KEY START${"A".repeat(20000)}`);
  expect(evidence(manager)).not.toContain("SECRET KEY START");
});
