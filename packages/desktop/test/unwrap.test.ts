import { afterEach, expect, test, vi } from "vitest";
import { logRendererError } from "../src/renderer/error-log.ts";
import { unwrap } from "../src/renderer/unwrap.ts";
import { userErrorMessage } from "../src/renderer/user-error.ts";

test.each([undefined, null, false, 0, "", "value", { id: "result" }, [1, 2]])(
  "returns the original successful result value: %j",
  (value) => {
    expect(unwrap({ ok: true, value })).toBe(value);
  },
);

test("throws safe bridge copy without an Error prefix", () => {
  const error = { code: "storage" as const, message: "storage: 无法读取结果" };
  try {
    unwrap({ ok: false, error });
    expect.unreachable("expected a failed bridge result to throw");
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("无法读取结果");
    expect(String(thrown)).toBe("无法读取结果");
    expect((thrown as Error).cause).toBe(error);
  }
});

afterEach(() => vi.unstubAllGlobals());

test("keeps raw IPC diagnostics in the cause and renderer log, never in displayed copy", () => {
  const error = {
    code: "storage" as const,
    message: "storage: Missing transcript index /private/session.json",
  };
  const logError = vi.fn();
  vi.stubGlobal("window", { zpi: { logError } });
  try {
    unwrap({ ok: false, error });
    expect.unreachable("expected a failed bridge result to throw");
  } catch (thrown) {
    const friendly = userErrorMessage(error);
    expect((thrown as Error).message).toBe(friendly);
    expect(String(thrown)).toBe(friendly);
    expect((thrown as Error).cause).toBe(error);
    expect(userErrorMessage(thrown)).toBe(friendly);
    logRendererError("test", thrown);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "test",
        message: expect.stringContaining(error.message),
        stack: expect.any(String),
      }),
    );
  }
});

test("logging retains nested exception stacks and tolerates cyclic causes", () => {
  const original = new TypeError("Cannot read private field");
  const outer = new Error("无法读取结果", { cause: original });
  original.cause = outer;
  const logError = vi.fn();
  vi.stubGlobal("window", { zpi: { logError } });
  logRendererError("test", outer);
  expect(logError).toHaveBeenCalledOnce();
  expect(logError.mock.calls[0]?.[0].message).toContain(original.message);
  expect(logError.mock.calls[0]?.[0].stack).toContain(original.stack);
});

test("preserves the store's unwrap export for existing callers", async () => {
  expect((await import("../src/renderer/store.ts")).unwrap).toBe(unwrap);
});
