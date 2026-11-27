import { describe, expect, it } from "vitest";
import { parseInvocation, printPrompt } from "../src/args.ts";

describe("terminal invocations", () => {
  it.each([
    [["auth"], "auth", []],
    [["auth", "login", "anthropic", "--method", "key"], "auth", ["login", "anthropic", "--method", "key"]],
    [["auth", "switch", "anthropic", "work"], "auth", ["switch", "anthropic", "work"]],
    [["models", "--default", "service/org/model"], "models", ["--default", "service/org/model"]],
  ] as const)("delegates %j", (input, command, args) => {
    expect(parseInvocation([...input])).toEqual({ kind: "accounts", command, args });
  });
  it("distinguishes a picker, an ID and a literal positional", () => {
    expect(parseInvocation(["-r"])).toMatchObject({ resume: true, print: false });
    expect(parseInvocation(["-c", "-p", "go"])).toMatchObject({ latest: true, print: true, prompt: "go" });
    expect(
      parseInvocation(["-r", "id", "-m", "team/org/model", "--effort", "high", "--", "--resume"]),
    ).toMatchObject({ resume: "id", model: "team/org/model", effort: "high", prompt: "--resume" });
  });
  it.each([
    ["解释", "--print", "--model=team/coder", "--continue", "--", "--help", "-r"],
    ["-c", "-m", "team/coder", "解释", "-p", "--", "--help", "-r"],
  ])("accepts reordered flags and preserves option-like prompt text: %s", (...args) => {
    expect(parseInvocation(args)).toMatchObject({
      kind: "session",
      latest: true,
      print: true,
      model: "team/coder",
      prompt: "解释 --help -r",
    });
  });
  it.each([["-c", "-r"], ["-r", "-p"], ["--model"], ["-m", "name"], ["--mcp"], ["--effort="]])(
    "rejects invalid options %s",
    (...args) => expect(() => parseInvocation(args)).toThrow(),
  );
  it("retains whitespace in the original input and inserts one blank line between sources", () => {
    expect(printPrompt("read", "  a\nb\n")).toBe("read\n\n  a\nb\n");
    expect(printPrompt("", "/compact")).toBe("/compact");
    expect(() => printPrompt("", " \n ")).toThrow();
  });
  it("keeps the original prompt when piped input contains only whitespace", () => {
    const prompt = "  第一行\n第二行  ";
    expect(printPrompt(prompt, " \t\r\n")).toBe(prompt);
  });
});
