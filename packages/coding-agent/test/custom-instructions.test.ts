import { join } from "node:path";
import { expect, test } from "vitest";
import { createAssistantMessageEventStream, emptyAssistant } from "zpi-ai";
import { createAgentSession, ModelRuntime, type ResourceLoader, SessionManager } from "zpi-coding-agent";
import { fakeConfig } from "../../../tests/fake-server.ts";
import { directory } from "./helpers/session-fixture.ts";

test("session instructions refresh after resources, replace prior additions and survive reopening", async () => {
  const cwd = await directory();
  const runtime = new ModelRuntime();
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = emptyAssistant(model);
      message.content = [{ type: "text", text: "done" }];
      stream.push({ type: "start", partial: message });
      stream.end(message);
      return stream;
    },
  });
  let revision = "FIRST";
  let loaded = "";
  const resourceLoader: ResourceLoader = {
    reload: async () => {
      loaded = revision;
    },
    getInstructions: () => [`RESOURCE ${loaded}`],
  };
  const customInstructions = () => [`CUSTOM ${loaded}`];
  const options = { cwd, agentDir: cwd, modelRuntime: runtime, resourceLoader, customInstructions };
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const { session } = await createAgentSession({ ...options, sessionManager: manager });
  try {
    expect(session.systemPrompt).toContain("RESOURCE FIRST\n\nCUSTOM FIRST");
    await session.prompt("first");
    revision = "SECOND";
    await session.prompt("second");
    expect(session.systemPrompt).toContain("RESOURCE SECOND\n\nCUSTOM SECOND");
    expect(session.systemPrompt).not.toContain("CUSTOM FIRST");
    expect(session.systemPrompt.match(/CUSTOM SECOND/g)).toHaveLength(1);
  } finally {
    session.dispose();
  }
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Missing saved session");
  const reopened = await createAgentSession({
    ...options,
    sessionManager: SessionManager.open(sessionFile),
  });
  try {
    expect(reopened.session.systemPrompt).toBe(session.systemPrompt);
    await reopened.session.prompt("continue");
    expect(reopened.session.systemPrompt.match(/CUSTOM SECOND/g)).toHaveLength(1);
    expect(reopened.session.state.tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
  } finally {
    reopened.session.dispose();
  }
});
