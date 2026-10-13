import { expect, it } from "vitest";
import { createAssistantMessageEventStream, emptyAssistant } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";

it("drains a backlog in order while new events arrive and preserves the final result", async () => {
  const stream = createAssistantMessageEventStream();
  const partial = emptyAssistant(fakeModel(""));
  const push = (i: number) => stream.push({ type: "text_delta", contentIndex: 0, delta: String(i), partial });
  for (let i = 0; i < 5000; i++) push(i);
  let received = 0;
  for await (const event of stream) {
    if (event.type === "text_delta") {
      expect(event.delta).toBe(String(received++));
      if (received === 2500) {
        for (let i = 5000; i < 10000; i++) push(i);
        stream.end(partial);
      }
    } else expect(event.type).toBe("done");
  }
  expect(received).toBe(10000);
  expect(await stream.result()).toBe(partial);
});

it("resumes after draining the queue and settles without requiring a consumer", async () => {
  const stream = createAssistantMessageEventStream();
  const partial = emptyAssistant(fakeModel(""));
  const iterator = stream[Symbol.asyncIterator]();
  for (const delta of ["first", "second"]) {
    const waiting = iterator.next();
    stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
    expect((await waiting).value).toMatchObject({ delta });
  }
  partial.stopReason = "aborted";
  stream.end(partial);
  stream.push({ type: "text_delta", contentIndex: 0, delta: "ignored", partial });
  expect(await stream.result()).toBe(partial);
  expect((await iterator.next()).value).toMatchObject({ type: "error", reason: "aborted" });
  expect((await iterator.next()).done).toBe(true);
});
