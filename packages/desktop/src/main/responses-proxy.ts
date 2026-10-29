/** Chromium has already evaluated system/PAC settings. Node's WebSocket needs the resolved proxy URL. */
export function responsesProxyUrl(rules: string): string | undefined {
  const first = rules.split(";")[0].trim();
  if (first === "DIRECT") return undefined;
  const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/i.exec(first);
  if (!match) throw new Error("Unsupported system WebSocket proxy configuration");
  const scheme = { PROXY: "http", HTTPS: "https", SOCKS: "socks4a", SOCKS4: "socks4a", SOCKS5: "socks5h" }[
    match[1].toUpperCase()
  ];
  return `${scheme}://${match[2]}`;
}
