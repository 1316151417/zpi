import { expect, it } from "vitest";
import {
  expandCustomCommandPrompt,
  expandCustomCommandPromptWithShell,
  parseCustomCommandInvocation,
  prepareCustomCommandPrompt,
  splitCustomCommandArguments,
} from "../src/main/custom-command-expansion.ts";

it("recognizes only leading canonical command invocations and preserves raw argument quoting", () => {
  expect(parseCustomCommandInvocation('  /Frontend:Review "auth flow" high\npriority  ')).toEqual({
    name: "frontend/review",
    args: '"auth flow" high\npriority',
  });
  expect(parseCustomCommandInvocation("/tools/review scope")).toEqual({
    name: "tools/review",
    args: "scope",
  });
  for (const text of [
    "ordinary /review",
    "/",
    "/../review",
    "/init",
    "/compact",
    "/side",
    "/BTW",
    `/${"a".repeat(1025)}`,
  ])
    expect(parseCustomCommandInvocation(text)).toBeUndefined();
  for (const name of ["_review", "-review"])
    expect(parseCustomCommandInvocation(`/${name} scope`)).toEqual({ name, args: "scope" });
});

it("prepares shell segments without executing and runs only original snippets sequentially", async () => {
  const command = { name: "/review", prompt: "Before !`echo $1`\n```!\nprintf done\n```\n$ARGUMENTS @file" };
  const plan = prepareCustomCommandPrompt(command, '"scope" !`injected`');
  expect(plan.parts.filter((part) => part.kind === "shell")).toEqual([
    { kind: "shell", command: "echo scope" },
    { kind: "shell", command: "printf done" },
  ]);
  const calls: string[] = [];
  const prompt = await expandCustomCommandPromptWithShell(command, '"scope" !`injected`', async (shell) => {
    calls.push(shell);
    return `${calls.length}\n`;
  });
  expect(calls).toEqual(["echo scope", "printf done"]);
  expect(prompt).toContain('Before 1\n2\n"scope" !`injected` @file');
});

it("stops shell interpolation on runner rejection and ignores empty snippets", async () => {
  const calls: string[] = [];
  await expect(
    expandCustomCommandPromptWithShell(
      { name: "review", prompt: "!`` !`first` !`never`" },
      "",
      async (shell) => {
        calls.push(shell);
        throw new Error("denied");
      },
    ),
  ).rejects.toThrow("denied");
  expect(calls).toEqual(["first"]);
});

it("normalizes catalog names and accepts the host's source label", () => {
  expect(expandCustomCommandPrompt({ name: "/tools/review", prompt: "Review." }, "", "project/zpi")).toBe(
    "Run custom command /tools/review.\nCommand source: project/zpi.\n\nReview.",
  );
});

it("expands all and positional arguments without a shell", () => {
  expect(
    expandCustomCommandPrompt(
      { name: "review", prompt: "Review $ARGUMENTS; first=$1, second=$2, absent=$3." },
      ' "auth flow" high ',
    ),
  ).toBe(
    'Run custom command /review.\nCommand source: user/zpi.\n\nReview "auth flow" high; first=auth flow, second=high, absent=.',
  );
  expect(splitCustomCommandArguments("'one two' three\\ four trailing\\")).toEqual([
    "one two",
    "three four",
    "trailing\\",
  ]);
});

it("appends arguments only if the original template has no placeholders", () => {
  expect(expandCustomCommandPrompt({ name: "review", prompt: "Review.\n" }, "src/auth.ts")).toContain(
    "Review.\n\nUser arguments:\nsrc/auth.ts",
  );
  expect(expandCustomCommandPrompt({ name: "review", prompt: "Review $9" }, "one")).not.toContain(
    "User arguments:",
  );
});

it("does not re-expand dollar placeholders introduced by arguments", () => {
  expect(
    expandCustomCommandPrompt({ name: "review", prompt: "$ARGUMENTS / $1 / $2" }, '"$1" $ARGUMENTS'),
  ).toContain('"$1" $ARGUMENTS / $1 / $ARGUMENTS');
});

it("rejects dynamic shell templates, while file references remain literal", () => {
  for (const prompt of ["Status !`git status`", "```!\ngit diff\n```", "```!\r\ngit diff\r\n```"])
    expect(() => expandCustomCommandPrompt({ name: "review", prompt }, "")).toThrow(/不支持自动 Shell/);
  expect(expandCustomCommandPrompt({ name: "review", prompt: "Read @secrets.txt and $1" }, "file")).toContain(
    "Read @secrets.txt and file",
  );
});
