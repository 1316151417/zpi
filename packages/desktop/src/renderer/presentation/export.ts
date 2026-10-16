import type { PresentationPreviewDocument } from "./types.ts";

let exportInProgress = false;

export async function exportPresentationPdf(options: {
  document: PresentationPreviewDocument;
  fileName: string;
  prepare: (document: PresentationPreviewDocument) => Promise<{ dispose(): void }>;
  print: () => Promise<Uint8Array>;
  save: (data: Uint8Array, suggestedName: string) => Promise<{ canceled: boolean; path?: string }>;
}) {
  if (exportInProgress) throw new Error("正在导出 PDF，请稍后重试。");
  exportInProgress = true;
  try {
    const host = await options.prepare(options.document);
    let bytes: Uint8Array;
    try {
      bytes = await options.print();
    } finally {
      host.dispose();
    }
    const suggestedName = (options.fileName.split(/[\\/]/).at(-1) ?? "presentation.pptx").replace(
      /\.pptx?$/i,
      ".pdf",
    );
    return await options.save(bytes, suggestedName);
  } finally {
    exportInProgress = false;
  }
}
