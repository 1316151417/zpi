import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { emptyAssistant } from "@zpi-dev/ai";
import { expect, it } from "vitest";
import { fakeModel } from "../../../tests/fake-server.ts";
import { Footer } from "../src/tui/footer.ts";
import { failure, resourceTitle } from "../src/tui/theme.ts";

it("keeps the current model right-aligned and shows the provider only when it disambiguates", () => {
  const footer = new Footer("~/sample");
  footer.model = "team/org/coder";
  footer.window = 32768;
  footer.providerCount = 1;
  expect(stripTerminalSequences(footer.render(52)[1])).toMatch(/^0\.0%\/33k\s+org\/coder$/);
  footer.providerCount = 2;
  expect(stripTerminalSequences(footer.render(52)[1])).toMatch(/ {2}\(team\) org\/coder$/);
  expect(stripTerminalSequences(footer.render(24)[1])).toMatch(/ {2}org\/coder$/);
  const narrow = footer.render(9)[1];
  expect(visibleWidth(narrow)).toBe(9);
  expect(stripTerminalSequences(narrow).trim()).toBe("0.0%/33k");
});

it("formats cache totals, prices and context thresholds with the reported values", () => {
  const footer = new Footer("~/sample");
  const context = {
    source: "server usage" as const,
    inputTokens: 25_000,
    contextWindow: 32768,
    percent: 77 as number | null,
    timestamp: null,
  };
  const usage = {
    inputTokens: 3000,
    outputTokens: 1000,
    cacheReadTokens: 8,
    cacheWriteTokens: 12,
    cacheHitRate: 0,
  };
  footer.refresh({ getContext: () => context, getPerformance: () => usage });
  const message = emptyAssistant(fakeModel(""));
  message.usage.cost.total = 0.008;
  footer.recordCost(message);
  expect(footer.render(66)[1]).toContain(resourceTitle("77.0%/33k"));
  expect(stripTerminalSequences(footer.render(66)[1]).trim()).toBe(
    "↑3.0k ↓1.0k R8 W12 CH0.0% $0.008 77.0%/33k",
  );
  context.percent = 91;
  expect(footer.render(66)[1]).toContain(failure("91.0%/33k"));

  footer.restoreCost([message, message]);
  expect(stripTerminalSequences(footer.render(66)[1])).toContain("$0.016");
  footer.restoreCost([]);
  footer.subscription = true;
  expect(stripTerminalSequences(footer.render(66)[1])).toContain("$0.000 (sub)");
  footer.subscription = false;
  usage.cacheReadTokens = usage.cacheWriteTokens = 0;
  context.percent = null;
  expect(stripTerminalSequences(footer.render(66)[1]).trim()).toBe("↑3.0k ↓1.0k ?/33k");
});
