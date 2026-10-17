import { setWasmSource, XlsxViewer, type XlsxViewerController } from "@extend-ai/react-xlsx";
import xlsxWasmUrl from "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef } from "react";
import { useAppearance } from "zpi-ui";
import type { FilePreview } from "../shared/bridge.ts";
import DocxPreview from "./DocxPreview.tsx";
import { installDocumentLinkSafety } from "./office-preview-model.ts";
import { userErrorMessage } from "./user-error.ts";

const LegacyDocPreview = lazy(() => import("./LegacyDocPreview.tsx"));

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

export default function OfficePreview({
  preview,
  sessionId,
}: {
  preview: Extract<FilePreview, { bytes: Uint8Array }>;
  sessionId: string;
}) {
  const { theme } = useAppearance();
  const buffer = useMemo(() => new Uint8Array(preview.bytes).buffer, [preview]);
  const root = useRef<HTMLDivElement>(null);
  const openUrl = useCallback((url: string) => paneTask(openBrowser(url, sessionId)), [sessionId]);
  useEffect(() => {
    const element = root.current;
    return element && preview.kind === "xlsx" ? installDocumentLinkSafety(element, openUrl) : undefined;
  }, [openUrl, preview.kind]);
  return (
    <div
      ref={root}
      className="file-office-preview"
      data-office-preview-kind={preview.kind === "xlsx" ? "excel" : preview.kind}
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
          loadingState={<div aria-busy="true" className="h-full" data-office-preview-pending />}
          fileTooLargeState={() => (
            <p role="alert" className="run-error">
              无法预览此表格。
            </p>
          )}
          errorState={(error) => (
            <p role="alert" className="run-error">
              {userErrorMessage(error)}
            </p>
          )}
        />
      ) : preview.kind === "doc" ? (
        <Suspense fallback={<div aria-busy="true" data-office-preview-pending />}>
          <LegacyDocPreview
            buffer={buffer}
            sourcePath={preview.path}
            errorMessage="无法预览此 Word 文档。"
            onOpenBrowserUrl={openUrl}
          />
        </Suspense>
      ) : (
        <DocxPreview
          buffer={buffer}
          sourcePath={preview.path}
          errorMessage="无法预览此 Word 文档。"
          onOpenBrowserUrl={openUrl}
        />
      )}
    </div>
  );
}
