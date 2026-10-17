// Adapted from ZCode previewPaneOfficeLegacyDocContent.tsx (Apache-2.0).

import {
  type DocModel,
  DocxEditorViewer,
  type DocxPageVirtualizationOptions,
  setWasmSource,
  useDocxEditor,
  useDocxModel,
} from "@extend-ai/react-docx";
import docxWasmUrl from "@extend-ai/react-docx/docx_wasm_bg.wasm?url";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { logRendererError } from "./error-log.ts";
import { installDocumentLinkSafety } from "./office-preview-model.ts";
import { useDocxPreviewFit } from "./use-docx-preview-fit.ts";

setWasmSource(docxWasmUrl);

let nextDocxModelRenderKey = 0;
const docxModelRenderKeys = new WeakMap<DocModel, number>();

function getDocxModelRenderKey(model: DocModel): number {
  const existingKey = docxModelRenderKeys.get(model);
  if (existingKey !== undefined) {
    return existingKey;
  }
  nextDocxModelRenderKey += 1;
  docxModelRenderKeys.set(model, nextDocxModelRenderKey);
  return nextDocxModelRenderKey;
}

function ResponsiveDocxEditorViewer({
  model,
  onOpenBrowserUrl,
  sourcePath,
}: {
  model: DocModel;
  onOpenBrowserUrl?: (url: string) => void;
  sourcePath: string;
}) {
  // 轻量 ReactDocxViewer 不走编辑器的完整分页与排版链路，预览结果会和编辑画布不一致。
  // 使用同一个 editor controller 驱动文档画布，但固定为只读模式，避免暴露任何编辑能力。
  const editor = useDocxEditor({
    starterModel: model,
    initialFileName: sourcePath,
    initialDocumentTheme: "light",
  });
  const { viewportRef, contentRef, fit, frameStyle, contentStyle } = useDocxPreviewFit(sourcePath);
  // 外层使用 transform 缩放页面，但 react-docx 的虚拟列表不会自动识别 transform。
  // 必须同步传入相同 zoomScale，否则滚动坐标会按未缩放页高计算，导致闪白或末页无法挂载。
  const pageVirtualization = useMemo<DocxPageVirtualizationOptions>(
    () => ({ zoomScale: fit?.scale ?? 1 }),
    [fit?.scale],
  );

  useLayoutEffect(() => {
    const content = contentRef.current;
    return content ? installDocumentLinkSafety(content, onOpenBrowserUrl) : undefined;
  }, [contentRef, onOpenBrowserUrl, sourcePath]);

  return (
    <div ref={viewportRef} className="w-full min-w-0" data-docx-fit-viewport>
      <div className="relative mx-auto" data-docx-fit-frame style={frameStyle}>
        {/* react-docx 按纸张原始像素宽度渲染，窄 Preview Pane 会被 794px 页面撑破。
            只缩小不放大，并同步包装层宽高，避免单独 transform 后仍保留未缩放的横向滚动区。 */}
        <div
          ref={contentRef}
          className="theme-zai-light min-w-max text-foreground"
          data-docx-fit-content
          style={contentStyle}
        >
          <DocxEditorViewer
            className="min-w-max"
            editor={editor}
            mode="read-only"
            pageGapBackgroundColor="transparent"
            pageVirtualization={pageVirtualization}
          />
        </div>
      </div>
    </div>
  );
}

export default function LegacyDocPreview({
  buffer,
  errorMessage,
  onOpenBrowserUrl,
  sourcePath,
}: {
  buffer: ArrayBuffer;
  errorMessage: string;
  onOpenBrowserUrl?: (url: string) => void;
  sourcePath: string;
}) {
  const { model, isLoading, error } = useDocxModel(buffer);

  useEffect(() => {
    if (!error) {
      return;
    }
    logRendererError("doc-preview", error);
  }, [error, sourcePath]);

  if (isLoading) {
    return (
      <div aria-busy="true" className="h-full min-h-0 w-full bg-background" data-office-preview-pending />
    );
  }

  if (error || !model) {
    return (
      <div className="p-3 text-ui-base text-destructive" role="alert">
        {errorMessage}
      </div>
    );
  }

  return (
    <div
      className="h-full min-h-0 w-full min-w-0 overflow-auto bg-background p-4 max-sm:p-2"
      data-office-preview-kind="doc"
    >
      <ResponsiveDocxEditorViewer
        key={getDocxModelRenderKey(model)}
        model={model}
        onOpenBrowserUrl={onOpenBrowserUrl}
        sourcePath={sourcePath}
      />
    </div>
  );
}
