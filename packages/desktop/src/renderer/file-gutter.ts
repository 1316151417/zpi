// Adapted from ZCode code-viewer.tsx (Apache-2.0).
export const fileGutterLabel = "点击或拖拽添加评论";
// A pseudo-element stays attached to the gutter button. Unlike a portal, it cannot
// flash at the viewport origin while its line is moved, replaced or detached.
export const fileGutterCSS = [
  "[data-gutter-utility-slot]{left:auto;right:4px;justify-content:flex-end;align-items:center;}",
  "[data-utility-button]{margin-left:0;margin-right:0;}",
  "@media (hover:hover) and (pointer:fine){",
  `[data-utility-button]::after{content:${JSON.stringify(fileGutterLabel)};position:absolute;left:calc(100% + 6px);top:50%;transform:translateY(-50%);max-width:16rem;white-space:nowrap;pointer-events:none;opacity:0;z-index:5;border:1px solid var(--color-border);border-radius:8px;background:var(--color-tooltip);color:var(--color-tooltip-foreground);padding:4px 8px;font-family:var(--diffs-header-font-family,var(--diffs-header-font-fallback));font-size:12px;line-height:16px;box-shadow:0 4px 12px rgb(0 0 0 / 0.14);}`,
  "[data-utility-button]:hover::after,[data-utility-button]:focus-visible::after{opacity:1;}",
  "}",
].join("");

export function observeFileGutterLabels(root: HTMLElement): () => void {
  const observed = new WeakSet<Node>();
  const observers: MutationObserver[] = [];
  let frame = 0;
  let disposed = false;
  const patch = (target: ParentNode) => {
    if (!observed.has(target)) {
      observed.add(target);
      const observer = new MutationObserver(schedule);
      observer.observe(target, { childList: true, subtree: true });
      observers.push(observer);
    }
    for (const button of target.querySelectorAll("button[data-utility-button]")) {
      button.setAttribute("aria-label", fileGutterLabel);
      // The CSS bubble already provides the visual hint; a native title would
      // appear a second time after the browser hover delay.
      button.removeAttribute("title");
    }
    for (const element of target.querySelectorAll("*")) {
      if (element.shadowRoot) patch(element.shadowRoot);
    }
  };
  function schedule() {
    if (disposed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!disposed && root.isConnected) patch(root);
    });
  }
  patch(root);
  schedule();
  return () => {
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    for (const observer of observers) observer.disconnect();
  };
}
