import { expect, it } from "vitest";
import { displayReferences, referenceStyle } from "../src/components/Reference.tsx";
import { filterSessionSuggestions } from "../src/components/session-suggestions.ts";
import type { SessionMentionSuggestion } from "../src/types.ts";

function item(name: string, workspaceKey = "current"): SessionMentionSuggestion {
  return {
    name,
    workspaceKey,
    sessionId: `sess_${name}`,
    description: workspaceKey,
    keywords: [`/projects/${workspaceKey}`],
    insert: `[#${name}](#sess_${name}) `,
    group: "对话",
  };
}
it("limits each workspace independently after searching the complete catalog", () => {
  const items = [...Array.from({ length: 25 }, (_, n) => item(`current-${n}`)), item("other", "other")];
  expect(filterSessionSuggestions(items, "")).toHaveLength(21);
  expect(filterSessionSuggestions(items, "current-24")).toEqual([items[24]]);
  expect(filterSessionSuggestions(items, "other")).toEqual([items[25]]);
});
it("matches title, identity and workspace, preserving stable ordering for ties and contiguous Chinese", () => {
  const items = [item("浏览器操作"), item("bravo"), item("beta", "remote")];
  expect(filterSessionSuggestions(items, "浏器")).toEqual([]);
  expect(filterSessionSuggestions(items, "浏览")).toEqual([items[0]]);
  expect(filterSessionSuggestions(items, "BRV")).toEqual([items[1]]);
  expect(filterSessionSuggestions(items, "sess_beta")).toEqual([items[2]]);
  expect(filterSessionSuggestions(items, "/projects/remote")).toEqual([items[2]]);
});
it("uses the same session decoration for editor and sent message references", () => {
  const [mention] = displayReferences("看 [#先前对话](#sess_prior) /compact");
  expect(mention).toMatchObject({ kind: "session", label: "先前对话", path: "#sess_prior" });
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { baseURI: "https://zpi.test/" },
  });
  try {
    expect(referenceStyle("session", "#sess_prior")).toHaveProperty(
      "--mention-mask",
      'url("https://zpi.test/mention-icons/session.svg")',
    );
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
