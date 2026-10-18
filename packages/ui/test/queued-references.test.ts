import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Attachment } from "zpi-coding-agent";
import { ConversationQueuePanel, type QueueActions } from "../src/components/ConversationQueuePanel.tsx";
import type { InputQueue } from "../src/types.ts";

const actions: QueueActions = {
  remove: async () => {},
  edit: async () => {},
  sendNow: async () => {},
  move: async () => {},
  resume: async () => {},
};
const image: Attachment = {
  id: "attachment-1",
  name: "shot.png",
  mimeType: "image/png",
  width: 1,
  height: 1,
  size: 70,
};

function renderQueue(text: string, attachments: Attachment[] = []) {
  const queue: InputQueue = {
    autoDrain: true,
    items: [
      {
        id: "queue-1",
        text,
        fileReferences: [],
        attachments,
        selection: { provider: "fake", modelId: "fake", reasoning: "high" },
        state: "queued",
      },
    ],
  };
  return renderToStaticMarkup(createElement(ConversationQueuePanel, { queue, actions, onError: () => {} }));
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

test("queued image attachments stay visible next to the text", () => {
  const html = renderQueue("看这张图", [image]);

  expect(html).toContain("看这张图");
  expect(html).toContain('<span class="queue-attachments">shot.png</span>');
});

test("image-only queued messages show the attachment name alone", () => {
  const html = renderQueue("", [image]);

  expect(html).toContain('<span class="queue-attachments">shot.png</span>');
  expect(html).not.toContain('class="queue-text');
});

test("mentions, commands and dollar amounts keep their visible text", () => {
  const cases = [
    ["看下 [demo.txt](/tmp/demo.txt)", "看下 demo.txt"],
    ["用 [$review](/tmp/review/SKILL.md) 检查", "用 $review 检查"],
    ["接着 [#会话](#sess_abc123) 继续", "接着 #会话 继续"],
    ["/init", "/init"],
    ["成本 $100 左右，占比 $5", "成本 $100 左右，占比 $5"],
  ];

  for (const [input, visible] of cases) {
    const html = renderQueue(input);
    expect(html).toContain(visible);
    expect(html).not.toContain("](");
  }
});
