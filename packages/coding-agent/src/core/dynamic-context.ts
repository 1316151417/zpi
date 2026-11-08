import type { Message, SystemMessage } from "zpi-ai";

function sdkBlock(name: string): boolean {
  return name.startsWith("zpi.") || name.startsWith('["plugin",');
}

/** Full desired SDK state in, only changed blocks out. Foreign system state is never withdrawn. */
export function contextUpdate(
  messages: readonly Message[],
  current: Readonly<Record<string, string>>,
): SystemMessage | undefined {
  const previous = new Map<string, string | null>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const [name, value] of Object.entries(message.sections ?? {}))
      if (sdkBlock(name)) previous.set(name, value || null);
  }
  const sections: Record<string, string | null> = Object.create(null);
  for (const [name, value] of Object.entries(current)) {
    if (!sdkBlock(name) || typeof value !== "string") throw new Error(`Invalid SDK context block: ${name}`);
    const next = value || null;
    if (next !== (previous.get(name) ?? null)) sections[name] = next;
  }
  for (const [name, value] of previous)
    if (!Object.hasOwn(current, name) && value !== null) sections[name] = null;
  return Object.keys(sections).length
    ? { role: "system", content: "", sections, timestamp: Date.now() }
    : undefined;
}
