import { basename } from "node:path";

export const maxPreviewPdfBytes = 50 * 1024 * 1024;
export const previewPdfOptions = {
  printBackground: true,
  preferCSSPageSize: true,
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
};

interface PdfExportServices {
  ready(sessionId: string): Promise<boolean>;
  print(): Promise<Uint8Array>;
  chooseFile(suggestedName: string): Promise<{ canceled: boolean; filePath?: string }>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export class PreviewPdfExporter {
  private busy = false;
  private pending: Buffer | undefined;

  private readonly services: PdfExportServices;

  constructor(services: PdfExportServices) {
    this.services = services;
  }

  async print(sessionId: string): Promise<Uint8Array> {
    if (this.busy) throw new Error("busy: 正在导出 PDF");
    this.busy = true;
    this.pending = undefined;
    try {
      if (!(await this.services.ready(sessionId))) throw new Error("invalid_input: 演示文稿打印页面尚未就绪");
      const data = await this.services.print();
      this.validate(data);
      this.pending = Buffer.from(data);
      return new Uint8Array(data);
    } finally {
      this.busy = false;
    }
  }

  async save(data: unknown, suggestedName: string): Promise<{ canceled: boolean; path?: string }> {
    if (this.busy) throw new Error("busy: 正在导出 PDF");
    this.validate(data);
    // 只允许保存该窗口刚生成的 PDF，不将打印接口变成任意文件写入能力。
    if (!this.pending?.equals(data)) throw new Error("invalid_input: PDF 与当前导出结果不匹配，请重新导出");
    if (typeof suggestedName !== "string" || /[\0\r\n]/.test(suggestedName))
      throw new Error("invalid_input: PDF 文件名无效");
    const name = basename(suggestedName.replaceAll("\\", "/")).trim().slice(0, 120);
    const filename = `${name.replace(/\.pdf$/i, "") || "presentation"}.pdf`;
    this.busy = true;
    const bytes = this.pending;
    this.pending = undefined;
    try {
      const choice = await this.services.chooseFile(filename);
      if (choice.canceled || !choice.filePath) return { canceled: true };
      await this.services.write(choice.filePath, bytes);
      return { canceled: false, path: choice.filePath };
    } finally {
      this.busy = false;
    }
  }

  private validate(data: unknown): asserts data is Uint8Array {
    if (!(data instanceof Uint8Array) || data.byteLength < 8 || data.byteLength > maxPreviewPdfBytes)
      throw new Error("invalid_input: PDF 内容无效或超过 50 MiB");
    if (Buffer.from(data.buffer, data.byteOffset, 5).toString("ascii") !== "%PDF-")
      throw new Error("invalid_input: 只允许保存 PDF");
  }
}
