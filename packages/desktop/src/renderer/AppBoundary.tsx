import { Component, type ReactNode } from "react";
import { logRendererError } from "./error-log.ts";
import { userErrorMessage } from "./user-error.ts";

export class AppBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: userErrorMessage(error) };
  }
  componentDidCatch(error: Error) {
    logRendererError("app-render", error);
  }
  render() {
    return this.state.error ? (
      <main className="pane-empty" role="alert">
        <p>无法显示窗口：{this.state.error}</p>
        <button onClick={() => window.location.reload()}>重新加载</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
