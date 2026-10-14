/** Remove configured credentials before provider errors enter the durable transcript. */
export function redactProviderError(
  message: string,
  secrets: readonly (string | null | undefined)[],
): string {
  const values = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    values.add(secret);
    // Providers may echo only the token, rather than the complete Authorization header.
    const bearer = /^\s*Bearer\s+(.+?)\s*$/i.exec(secret);
    if (bearer?.[1]) values.add(bearer[1]);
  }
  for (const secret of [...values].sort((a, b) => b.length - a.length))
    message = message.split(secret).join("[redacted]");
  return message;
}
