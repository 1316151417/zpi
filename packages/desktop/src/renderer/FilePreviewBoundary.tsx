import { Component, type ReactNode } from "react";
import type { FilePreview } from "../shared/bridge.ts";
import { logRendererError } from "./error-log.ts";

export class FilePreviewBoundary extends Component<
  { preview: FilePreview; children: ReactNode },
  { preview: FilePreview | null; failed: boolean }
> {
  state: { preview: FilePreview | null; failed: boolean } = { preview: null, failed: false };
  static getDerivedStateFromProps(
    { preview }: { preview: FilePreview },
    state: { preview: FilePreview | null },
  ) {
    return preview === state.preview ? null : { preview, failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    logRendererError("file-preview", error);
  }
  render() {
    return this.state.failed ? (
      <p className="run-error" role="alert">
        无法预览此文件，请在外部应用中打开。
      </p>
    ) : (
      this.props.children
    );
  }
}
