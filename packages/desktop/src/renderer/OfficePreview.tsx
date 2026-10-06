import { setWasmSource, XlsxViewer, type XlsxViewerController } from "@extend-ai/react-xlsx";
import xlsxWasmUrl from "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url";
import { renderAsync } from "docx-preview";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppearance } from "zpi-ui";
import type { FilePreview } from "../shared/bridge.ts";
import { logRendererError } from "./error-log.ts";
import { openBrowser, paneTask } from "./pane-store.ts";

setWasmSource(xlsxWasmUrl);

function SheetTabs({ tabs, activeTabIndex, setActiveTabIndex }: XlsxViewerController) {
  if (tabs.length <= 1) return null;
  return (
    <div role="tablist" aria-label="工作表" className="file-sheet-tabs">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          role="tab"
          title={tab.name}
          aria-selected={index === activeTabIndex}
          tabIndex={index === activeTabIndex ? 0 : -1}
          onClick={() => setActiveTabIndex(index)}
          onKeyDown={(event) => {
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : event.key === "ArrowLeft"
                    ? (index - 1 + tabs.length) % tabs.length
                    : event.key === "ArrowRight"
                      ? (index + 1) % tabs.length
                      : undefined;
            if (next !== undefined) {
              event.preventDefault();
              setActiveTabIndex(next);
              event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
            }
          }}
        >
          {tab.name}
        </button>
      ))}
    </div>
  );
}

function DocxPreview({ buffer }: { buffer: ArrayBuffer }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const container = viewport.current;
    if (!container) return;
    const content = document.createElement("div");
    content.className = "file-docx-content";
    let active = true;
    const resize = new ResizeObserver(() => {
      const sheet = content.querySelector<HTMLElement>("section.docx");
      if (sheet && container.clientWidth)
        content.style.zoom = String(Math.min(1, (container.clientWidth - 32) / sheet.offsetWidth));
    });
    void renderAsync(buffer, content, undefined, {
      className: "docx",
      inWrapper: true,
      useBase64URL: true,
      renderAltChunks: false,
      ignoreLastRenderedPageBreak: true,
      renderComments: false,
      renderChanges: false,
    })
      .then(() => {
        if (!active) return;
        container.replaceChildren(content);
        resize.observe(container);
      })
      .catch((error) => {
        logRendererError("docx-preview", error);
        if (active) setError(String(error));
      });
    return () => {
      active = false;
      resize.disconnect();
      content.remove();
    };
  }, [buffer]);
  return (
    <div className="file-docx-preview">
      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
      <div ref={viewport} />
    </div>
  );
}

export default function OfficePreview({ preview }: { preview: Extract<FilePreview, { bytes: Uint8Array }> }) {
  const { theme } = useAppearance();
  const buffer = useMemo(() => new Uint8Array(preview.bytes).buffer, [preview]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const navigate = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const target = anchor.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(target)) paneTask(openBrowser(target));
    };
    element.addEventListener("click", navigate, true);
    element.addEventListener("auxclick", navigate, true);
    return () => {
      element.removeEventListener("click", navigate, true);
      element.removeEventListener("auxclick", navigate, true);
    };
  }, []);
  return (
    <div
      ref={root}
      className="file-office-preview"
      data-office-preview-kind={preview.kind === "xlsx" ? "excel" : "docx"}
    >
      {preview.kind === "xlsx" ? (
        <XlsxViewer
          file={buffer}
          fileName={preview.path}
          height="100%"
          isDark={theme === "dark"}
          readOnly
          rounded={false}
          showDefaultToolbar={false}
          toolbar={(controller) => <SheetTabs {...controller} />}
          loadingState={<p className="pane-empty">正在加载表格…</p>}
          errorState={(error) => (
            <p role="alert" className="run-error">
              {error.message}
            </p>
          )}
        />
      ) : (
        <DocxPreview buffer={buffer} />
      )}
    </div>
  );
}
