import { expect, test } from "vitest";
import {
  previewPrintHostReady,
  previewPrintHostScript,
  previewPrintIsolationCss,
} from "../src/main/preview-print-host.ts";

function fixture() {
  const head = {};
  const body = {};
  const attributes = new Map([
    ["data-zpi-print-session", "session-a"],
    ["data-zpi-print-ready", "true"],
  ]);
  const host = {
    parentElement: body,
    children: [{ hasAttribute: (name: string) => name === "data-zcode-pptx-print-page" }],
    getAttribute: (name: string) => attributes.get(name) ?? null,
  };
  const properties: Record<string, string> = { display: "none", size: "1280px 720px", margin: "0px" };
  const declarations = {
    getPropertyValue: (key: string) => properties[key] ?? "",
    getPropertyPriority: () => "important",
  };
  const media = {
    conditionText: "print",
    cssRules: [
      { selectorText: "body > :not([data-zcode-pptx-print-host])", style: declarations, cssText: "body {}" },
      { cssText: "@page { size: 1280px 720px; margin: 0px; }", style: declarations },
    ],
  };
  const style = { parentElement: head, sheet: { disabled: false, cssRules: [media] } };
  const hosts = [host];
  const styles = [style];
  const document = {
    head,
    body,
    querySelectorAll: (selector: string) => (selector.startsWith("style") ? styles : hosts),
  } as unknown as Document;
  return { document, host, style, hosts, styles, attributes, properties, media };
}
test("permits only one ready slide host for the matching session with parsed print protection", () => {
  const state = fixture();
  expect(previewPrintHostReady(state.document, "session-a")).toBe(true);
  expect(previewPrintHostReady(state.document, "session-b")).toBe(false);
  expect(previewPrintIsolationCss).toContain("display: none !important");
});
test("fails closed for missing, duplicate, unready or empty hosts", () => {
  for (const modify of [
    (state: ReturnType<typeof fixture>) => {
      state.hosts.length = 0;
    },
    (state: ReturnType<typeof fixture>) => {
      state.hosts.push(state.host);
    },
    (state: ReturnType<typeof fixture>) => {
      state.attributes.delete("data-zpi-print-ready");
    },
    (state: ReturnType<typeof fixture>) => {
      state.host.children.length = 0;
    },
    (state: ReturnType<typeof fixture>) => {
      state.host.parentElement = {};
    },
  ]) {
    const state = fixture();
    modify(state);
    expect(previewPrintHostReady(state.document, "session-a")).toBe(false);
  }
});
test("fails closed for duplicate, disabled or incomplete print CSS", () => {
  for (const modify of [
    (state: ReturnType<typeof fixture>) => {
      state.styles.length = 0;
    },
    (state: ReturnType<typeof fixture>) => {
      state.styles.push(state.style);
    },
    (state: ReturnType<typeof fixture>) => {
      state.style.sheet.disabled = true;
    },
    (state: ReturnType<typeof fixture>) => {
      state.media.conditionText = "screen";
    },
    (state: ReturnType<typeof fixture>) => {
      state.properties.display = "block";
    },
    (state: ReturnType<typeof fixture>) => {
      state.properties.size = "";
    },
    (state: ReturnType<typeof fixture>) => {
      state.properties.margin = "20px";
    },
  ]) {
    const state = fixture();
    modify(state);
    expect(previewPrintHostReady(state.document, "session-a")).toBe(false);
  }
});
test("serialized main-frame readiness check contains no external closure and quotes the session safely", () => {
  const state = fixture();
  const session = 'session"); throw new Error("injected") //';
  state.attributes.set("data-zpi-print-session", session);
  const run = new Function("document", `return ${previewPrintHostScript(session)}`);
  expect(run(state.document)).toBe(true);
});
