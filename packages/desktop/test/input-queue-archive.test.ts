import type { InputQueue } from "ZPI-ui";
import { expect, it, vi } from "vitest";
import { SessionInputQueue } from "../src/main/input-queue.ts";

it("a failed archive never persists an empty queue or discards accepted input", async () => {
  const runtime: ConstructorParameters<typeof SessionInputQueue>[0] = {
    check: () => {},
    running: () => false,
    prepare: vi.fn(),
    retain: vi.fn(),
    discard: vi.fn(),
    withdraw: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    save: vi.fn(),
    publish: vi.fn(),
  };
  const queue = new SessionInputQueue(runtime);
  const saved: InputQueue = {
    items: [
      {
        id: "item",
        state: "queued",
        text: "keep",
        attachments: [],
        fileReferences: [],
        selection: { provider: "p", modelId: "m", reasoning: "none" },
      },
    ],
    autoDrain: false,
  };
  queue.restore("session", saved);
  await expect(
    queue.archive("session", () => {
      throw new Error("archive failed");
    }),
  ).rejects.toThrow("archive failed");
  expect(queue.get("session").items).toEqual(saved.items);
  expect(runtime.save).not.toHaveBeenCalled();
  expect(runtime.discard).not.toHaveBeenCalled();
  runtime.save = vi.fn(() => {
    throw new Error("queue write failed");
  });
  const persist = vi.fn();
  await expect(queue.archive("session", persist)).rejects.toThrow("queue write failed");
  expect(persist).toHaveBeenCalledOnce();
  expect(queue.get("session").items).toEqual(saved.items);
  expect(runtime.discard).not.toHaveBeenCalled();
});
