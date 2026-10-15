import { expect, test } from "vitest";
import { assertBackgroundCommand } from "../../../tests/helpers/test-command.ts";
import safetyCheck, { sourceViolations } from "../../../tests/safety-check.ts";

test("repository entry points obey desktop isolation constraints", safetyCheck);
test.each(["--ui", "--ui-port=9001", "--debug", "--headed", "--config=other.ts", "-cother.ts"])(
  "rejects %s before loading Playwright",
  (arg) => expect(() => assertBackgroundCommand([arg], {})).toThrow("Default tests"),
);
test.each(["PWDEBUG", "ZPI_TEST_INTERACTIVE", "ZPI_TEST_SHOW_WINDOW"])("rejects ambient %s", (key) =>
  expect(() => assertBackgroundCommand([], { [key]: "1" })).toThrow("Default tests"),
);
test("accepts ordinary background runner options", () => {
  expect(() => assertBackgroundCommand(["hidden-window", "--list", "--repeat-each=2"], {})).not.toThrow();
});
test.each([
  ["tests/desktop/bypass.spec.ts", 'import { test } from "@playwright/test";'],
  ["scripts/bypass.mjs", 'import { _electron as runner } from "@playwright/test";'],
  ["scripts/bypass.mjs", "electron.launch({ args: [] })"],
  ["tests/desktop/paste.spec.ts", 'page.keyboard.press("Meta+v")'],
  ["packages/desktop/src/main/popup.ts", "new BrowserWindow({ show: true })"],
  ["packages/desktop/test/unsafe.test.ts", 'import { app } from "electron";'],
])("reports unsafe entry %s", (path, source) => expect(sourceViolations(path, source)).not.toEqual([]));
test("allows renderer focus and CDP input without OS automation", () => {
  expect(
    sourceViolations(
      "tests/desktop/composer.spec.ts",
      'await editor.focus(); await page.keyboard.press("Enter");',
    ),
  ).toEqual([]);
});
