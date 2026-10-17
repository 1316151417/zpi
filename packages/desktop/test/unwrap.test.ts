import { expect, test } from "vitest";
import { unwrap } from "../src/renderer/unwrap.ts";

test.each([undefined, null, false, 0, "", "value", { id: "result" }, [1, 2]])(
  "returns the original successful result value: %j",
  (value) => {
    expect(unwrap({ ok: true, value })).toBe(value);
  },
);

test("throws the bridge error message", () => {
  expect(() => unwrap({ ok: false, error: { code: "storage", message: "无法读取结果" } })).toThrowError(
    new Error("无法读取结果"),
  );
});

test("preserves the store's unwrap export for existing callers", async () => {
  expect((await import("../src/renderer/store.ts")).unwrap).toBe(unwrap);
});
