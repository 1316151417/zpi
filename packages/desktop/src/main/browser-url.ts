import { fileURLToPath, pathToFileURL } from "node:url";

/** Address-bar input and navigation share the same protocol validation. */
export function browserUrl(input: string): string {
  const invalid = () => new Error("invalid_input: 浏览器支持 HTTP/HTTPS 或本地 file 地址");
  try {
    let address = input.trim();
    if (!address) throw invalid();
    if (address.startsWith("/")) return pathToFileURL(address).href;
    // Accept the missing-colon spelling from pasted local preview links.
    address = address.replace(/^file\/{3}/i, "file:///");
    if (
      !/^[a-z][a-z\d+.-]*:/i.test(address) ||
      /^(?:localhost|[a-z\d-]+(?:\.[a-z\d-]+)+):\d+(?:[/?#]|$)/i.test(address)
    )
      address = `https://${address}`;
    const url = new URL(address);
    if (!["http:", "https:", "file:"].includes(url.protocol) || url.username || url.password) throw invalid();
    if (url.protocol === "file:") fileURLToPath(url); // Reject remote hosts and encoded path separators.
    return url.href;
  } catch {
    throw invalid();
  }
}
