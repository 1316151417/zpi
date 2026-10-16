// This function is serialized into the already-authorized main frame.
// Keep it self-contained: no module closures or privileged operations.
export function previewPrintHostReady(document: Document, sessionId: string): boolean {
  const hosts = document.querySelectorAll("[data-zcode-pptx-print-host]");
  const styles = document.querySelectorAll("style[data-zcode-pptx-print-style]");
  if (hosts.length !== 1 || styles.length !== 1) return false;
  const host = hosts[0];
  const style = styles[0] as HTMLStyleElement;
  if (
    host.parentElement !== document.body ||
    host.getAttribute("data-zpi-print-session") !== sessionId ||
    host.getAttribute("data-zpi-print-ready") !== "true" ||
    host.children.length === 0 ||
    !Array.from(host.children).every((page) => page.hasAttribute("data-zcode-pptx-print-page")) ||
    style.parentElement !== document.head ||
    !style.sheet ||
    style.sheet.disabled
  )
    return false;
  const print = Array.from(style.sheet.cssRules).find(
    (rule) => "conditionText" in rule && rule.conditionText === "print",
  ) as CSSMediaRule | undefined;
  if (!print) return false;
  const rules = Array.from(print.cssRules);
  const hide = rules.find(
    (rule) =>
      "selectorText" in rule &&
      String(rule.selectorText).replace(/\s/g, "") === "body>:not([data-zcode-pptx-print-host])",
  ) as CSSStyleRule | undefined;
  const page = rules.find((rule) => rule.cssText.startsWith("@page")) as CSSPageRule | undefined;
  return Boolean(
    hide?.style.getPropertyValue("display") === "none" &&
      hide.style.getPropertyPriority("display") === "important" &&
      page?.style.getPropertyValue("size") &&
      page.style.getPropertyValue("margin") === "0px",
  );
}

// Native user-origin !important CSS protects chat content even if the renderer
// removes its temporary style after readiness validation but before Chromium prints.
export const previewPrintIsolationCss = `@media print {
  body > :not([data-zcode-pptx-print-host]) { display: none !important; }
}`;

export function previewPrintHostScript(sessionId: string): string {
  return `(${previewPrintHostReady.toString()})(document, ${JSON.stringify(sessionId)})`;
}
