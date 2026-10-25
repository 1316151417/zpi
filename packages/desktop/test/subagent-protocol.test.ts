import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as protocol from "../src/main/plugins/subagents/protocol.ts";

// Evaluated from the checked-out ZCode implementations, including the runner's
// SendMessage success objects. Tests need no access to that checkout.
const reference = JSON.parse(
  readFileSync(new URL("./fixtures/zcode-subagent-results.json", import.meta.url), "utf8"),
) as { revision: string; cases: { name: string; args: unknown[]; expected: unknown }[] };
const formatters = protocol as unknown as Record<string, (...args: unknown[]) => unknown>;
test.each(reference.cases.map((item, index) => ({ ...item, index })))(
  "ZCode result $index: $name",
  ({ name, args, expected }) => {
    expect(formatters[name](...args)).toEqual(expected);
  },
);
