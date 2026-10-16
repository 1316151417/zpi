export interface PdfJsDocumentOptions {
  cMapPacked: true;
  cMapUrl: string;
  standardFontDataUrl: string;
  wasmUrl: string;
}

export function createPdfJsDocumentOptions(viteBaseUrl: string, documentUrl: string): PdfJsDocumentOptions {
  const applicationBaseUrl = new URL(viteBaseUrl, documentUrl);
  return {
    cMapPacked: true,
    standardFontDataUrl: new URL("pdfjs/standard_fonts/", applicationBaseUrl).href,
    wasmUrl: new URL("pdfjs/wasm/", applicationBaseUrl).href,
    cMapUrl: new URL("pdfjs/cmaps/", applicationBaseUrl).href,
  };
}
