import type { ModelPerformance as Performance } from "@zpi-dev/coding-agent";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelPerformance } from "../src/renderer/ModelPerformance.tsx";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (value: Performance) =>
  act(async () => root.render(createElement(ModelPerformance, { value })));
const rows = () =>
  Object.fromEntries(
    [...document.querySelectorAll("dt")].map((e) => [e.textContent, e.nextElementSibling?.textContent]),
  );

it("keeps speeds out of the dock and separates latest timing, unmeasurable speed and qualified averages", async () => {
  await render({
    turns: 2,
    steps: 3,
    inputTokens: 100,
    outputTokens: 600,
    modelLabel: "Terra",
    requestMs: 20200,
    ttftMs: 17300,
    firstTextMs: 20100,
    tokensPerSecond: 100,
    speedSampleCount: 1,
  });
  expect(container.textContent).toContain("2 轮 3 步");
  expect(container.textContent).toContain("700 tok");
  expect(container.textContent).not.toContain("tok/s");
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="会话统计"]');
  if (!button) throw new Error("Missing statistics button");
  await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(rows()).toMatchObject({
    统计模型: "Terra",
    最近成功请求耗时: "20.2秒",
    首段内容等待: "17.3秒",
    正文开始等待: "20.1秒",
    本次估算输出速度: "—",
    同模型平均输出速度: "100 tok/s",
    合格速度样本: "1",
  });
  await render({
    turns: 3,
    steps: 4,
    modelLabel: "Domestic",
    requestMs: 2000,
    ttftMs: 200,
    firstTextMs: 600,
    requestTokensPerSecond: 80,
    tokensPerSecond: 90,
    speedSampleCount: 2,
  });
  expect(rows()).toMatchObject({
    统计模型: "Domestic",
    首段内容等待: "0.2秒",
    正文开始等待: "0.6秒",
    本次估算输出速度: "80 tok/s",
    同模型平均输出速度: "90 tok/s",
    合格速度样本: "2",
  });
  expect(container.textContent).not.toContain("tok/s");
  // A model selection without its own samples must clear the previous model's detail rows.
  await render({ turns: 3, steps: 4 });
  expect(rows().统计模型).toBeUndefined();
  expect(rows().同模型平均输出速度).toBeUndefined();
});
