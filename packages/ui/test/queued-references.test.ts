import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ConversationQueuePanel, type QueueActions } from "../src/components/ConversationQueuePanel.tsx";
import type { InputQueue } from "../src/types.ts";

const actions: QueueActions = {
  remove: async () => {},
  edit: async () => {},
  sendNow: async () => {},
  move: async () => {},
  resume: async () => {},
};

function renderQueue(text: string) {
  const queue: InputQueue = {
    autoDrain: true,
    items: [
      {
        id: "queue-1",
        text,
        fileReferences: [],
        attachments: [],
        selection: { provider: "fake", modelId: "fake", reasoning: "high" },
        state: "queued",
      },
    ],
  };
  return renderToStaticMarkup(
    createElement(ConversationQueuePanel, { queue, actions, onError: () => {} }),
  );
}

test("queued messages render visible text and a reference chip instead of the wire format", () => {
  const html = renderQueue('Review\n\n# userselect:\n```userselect\n[{"text":"quoted original"}]\n```');

  expect(html).toContain("Review");
  expect(html).toContain('data-conversation-selection-reference-count="1"');
  expect(html).not.toContain("# userselect:");
  expect(html).not.toContain("userselect");
});

test("reference-only queued messages still show the chip", () => {
  const html = renderQueue('# userselect:\n```userselect\n[{"text":"quoted original"}]\n```');

  expect(html).toContain('data-conversation-selection-reference-count="1"');
  expect(html).not.toContain("# userselect:");
});

test("malformed selections stay verbatim", () => {
  const text = "# userselect:\n```userselect\n{broken}\n```";

  expect(renderQueue(text)).toContain("userselect");
});
