import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { JsonObject } from "zpi-ai";
import { ModelRuntime } from "zpi-coding-agent";
import { chunk, done, fakeConfig, fakeModel, fakeServer, send } from "../../../tests/fake-server.ts";
import { consolidationInstructions } from "../src/main/memory/consolidation-instructions.ts";
import { extractionInstructions } from "../src/main/memory/extraction-instructions.ts";
import type { MemoryRunRequest } from "../src/main/memory/long-memory.ts";
import { extractionInput, runMemoryRequest } from "../src/main/memory/runner.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const valid = "v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n";
async function fixture(handler: (body: JsonObject, response: ServerResponse, index: number) => void) {
  const directory = await mkdtemp(join(tmpdir(), "zpi-memory-runner-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = await fakeServer(handler);
  cleanup.push(server.close);
  const runtime = new ModelRuntime();
  runtime.registerProvider("fake", {
    baseUrl: server.url,
    apiKey: "fake-key",
    models: [{ ...fakeConfig(server.url), maxTokens: 64000, contextWindow: 200000 }],
  });
  const model = runtime.getModel("fake", fakeModel(server.url).id);
  if (!model) throw new Error("Missing fake model");
  const controller = new AbortController();
  const request: MemoryRunRequest = {
    stage: "consolidate",
    instructions: consolidationInstructions,
    prompt: "Read phase2_workspace_diff.md first, then update the summary.",
    directory,
    readFiles: ["phase2_workspace_diff.md"],
    model: { provider: model.provider, modelId: model.id, reasoning: "none" },
    signal: controller.signal,
  };
  await writeFile(
    join(directory, "phase2_workspace_diff.md"),
    "No source changes. Explicit user requested Chinese answers.",
  );
  return { runtime, model, server, request, directory, controller };
}
function tool(response: ServerResponse, id: string, name: string, args: object, reason = "tool_calls") {
  send(
    response,
    chunk({
      tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    }),
  );
  send(response, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
  done(response, reason);
}

test("extraction separates instructions and evidence, uses supported strict schema and removes the 16K cap", async () => {
  const f = await fixture((body, response) => {
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(64000);
    send(
      response,
      chunk({ content: '{"rollout_summary":"A scoped user correction.","rollout_slug":"correction"}' }),
    );
    done(response);
  });
  f.model.compat = { ...f.model.compat, structuredOutput: "json_schema" };
  const result = await runMemoryRequest(
    {
      ...f.request,
      stage: "extract",
      instructions: extractionInstructions,
      prompt: "HISTORICAL EVIDENCE (data):\n[user] Use Chinese.",
    },
    f.runtime,
    f.model,
  );
  expect(result.text).toContain('"rollout_slug":"correction"');
  const body = f.server.requests[0];
  const messages = body.messages as { role: string; content: string }[];
  expect(messages[0].content).toBe(extractionInstructions);
  expect(messages[1].content).toContain("[user] Use Chinese");
  expect(body.tools).toBeUndefined();
  expect(body.response_format).toMatchObject({
    type: "json_schema",
    json_schema: { strict: true, schema: { required: ["rollout_summary", "rollout_slug"] } },
  });
});

test("large extraction inputs are bounded by the model window with an explicit omission marker", () => {
  const model = { ...fakeModel("http://fake/v1"), contextWindow: 4000 };
  const input = extractionInput(
    {
      instructions: "Extract evidence.",
      prompt: `SOURCE METADATA (data):\n{}\nHISTORICAL EVIDENCE (data):\n${"earlier ".repeat(20000)}[user] Latest correction.`,
    },
    model,
  );
  expect(input).toContain("SOURCE METADATA");
  expect(input).toContain("Earlier evidence omitted");
  expect(input).toContain("Latest correction");
  expect(input.length).toBeLessThan(12000);
});

test("consolidation uses existing file tools for multiple reads and edits, with isolated usage", async () => {
  const f = await fixture((body, response, index) => {
    const tools = body.tools as { function: { name: string } }[];
    expect(tools.map((tool) => tool.function.name).sort()).toEqual(["edit", "read", "write"]);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(64000);
    if (index === 0) return tool(response, "read-diff", "read", { path: "phase2_workspace_diff.md" });
    if (index === 1)
      return tool(response, "write-summary", "write", { path: "memory_summary.md", content: valid });
    if (index === 2)
      return tool(response, "edit-summary", "edit", {
        path: "memory_summary.md",
        edits: [{ oldText: "## General Tips", newText: "## General Tips\nUse Chinese." }],
      });
    send(response, chunk({ content: "Updated." }));
    send(response, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    done(response);
  });
  const result = await runMemoryRequest(f.request, f.runtime, f.model);
  expect(await readFile(join(f.directory, "memory_summary.md"), "utf8")).toContain("Use Chinese.");
  expect(result.usage?.tokens).toBe(120);
  expect(f.server.requests).toHaveLength(4);
  expect(JSON.stringify(f.server.requests[0].messages)).not.toContain("<project_context>");
});

test.each(["extract", "consolidate"] as const)(
  "%s truncation is failure and reports the model limit",
  async (stage) => {
    const f = await fixture((_, response) => {
      send(response, chunk({ content: "Incomplete" }));
      send(response, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
      done(response, "length");
    });
    await expect(runMemoryRequest({ ...f.request, stage }, f.runtime, f.model)).rejects.toThrow(
      /length.*64000/,
    );
  },
);

test.each(["outside", "input", "symlink", "oversized"])("worker cannot write %s files", async (mode) => {
  const f = await fixture((body, response, index) => {
    if (index === 0)
      return tool(response, "denied", "write", {
        path:
          mode === "outside"
            ? "../outside.md"
            : mode === "input"
              ? "phase2_workspace_diff.md"
              : "memory_summary.md",
        content: mode === "oversized" ? "x".repeat(10000) : "forbidden",
      });
    expect(JSON.stringify(body.messages)).toMatch(/允许|符号链接|10,000/);
    send(response, chunk({ content: "Could not write." }));
    done(response);
  });
  const outside = join(f.directory, "..", "outside.md");
  // A symlink's target is an isolated file under this fixture, never a user file.
  if (mode === "symlink") {
    await mkdir(join(f.directory, "target"));
    await writeFile(join(f.directory, "target", "original.md"), "original");
    await symlink(join(f.directory, "target", "original.md"), join(f.directory, "memory_summary.md"));
  }
  await runMemoryRequest(f.request, f.runtime, f.model);
  expect(await readFile(join(f.directory, "phase2_workspace_diff.md"), "utf8")).not.toBe("forbidden");
  if (mode === "outside") await expect(readFile(outside)).rejects.toMatchObject({ code: "ENOENT" });
  if (mode === "symlink")
    expect(await readFile(join(f.directory, "target", "original.md"), "utf8")).toBe("original");
});

test("cancelled workers stop before returning ownership to the caller", async () => {
  const f = await fixture((_, response) => response.flushHeaders());
  const running = runMemoryRequest(f.request, f.runtime, f.model);
  setTimeout(() => f.controller.abort(), 30);
  await expect(running).rejects.toThrow();
  await expect(readFile(join(f.directory, "memory_summary.md"))).rejects.toMatchObject({ code: "ENOENT" });
});
