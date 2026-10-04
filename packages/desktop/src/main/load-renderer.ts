import type { BrowserWindow } from "electron";

/** A reload can cancel the initial navigation before loadURL's promise settles. */
export function loadRenderer(window: BrowserWindow, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const contents = window.webContents;
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      contents.removeListener("did-finish-load", loaded);
      contents.removeListener("did-fail-load", failed);
      contents.removeListener("destroyed", closed);
      if (error) reject(error);
      else resolve();
    };
    const loaded = () => {
      if (contents.getURL().split("#")[0] === url.split("#")[0]) finish();
    };
    const failed = (_event: unknown, code: number, description: string, _url: string, main: boolean) => {
      if (main && code !== -3) finish(new Error(`${description} (${code}) loading '${url}'`));
    };
    const closed = () => finish();
    const timeout = setTimeout(() => finish(new Error(`页面加载超时：${url}`)), 30_000);
    contents.on("did-finish-load", loaded);
    contents.on("did-fail-load", failed);
    contents.once("destroyed", closed);
    void window.loadURL(url).catch((error: Error & { code?: string; errno?: number }) => {
      // Only cancellation is recoverable: the replacement navigation must still finish.
      if (error.code !== "ERR_ABORTED" && error.errno !== -3) finish(error);
    });
  });
}
