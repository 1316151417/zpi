// Adapted from ZCode assistantPathQuotes.ts (Apache-2.0), commit 872ad960.
// See THIRD_PARTY_NOTICES.md and docs/specs/assistant-previews-and-sidebar.md.
const ASSISTANT_PATH_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”",
  "‘": "’",
};
const ASSISTANT_PATH_ENCODED_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  "%22": "%22",
  "%27": "%27",
  "%60": "%60",
  "%E2%80%98": "%E2%80%99",
  "%E2%80%9C": "%E2%80%9D",
};

export function isBalancedAssistantPathQuotePair(opening: string, closing: string): boolean {
  return ASSISTANT_PATH_QUOTE_PAIRS[opening] === closing;
}

export function isAssistantPathQuoteCharacter(character: string | undefined): boolean {
  return (
    character === '"' ||
    character === "'" ||
    character === "`" ||
    character === "“" ||
    character === "”" ||
    character === "‘" ||
    character === "’"
  );
}

export function stripBalancedAssistantPathQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  if (trimmed.startsWith("/")) {
    const protectedRelative = stripBalancedAssistantPathQuotes(trimmed.slice(1));
    if (protectedRelative !== trimmed.slice(1)) {
      return protectedRelative.startsWith("./") || protectedRelative.startsWith("/")
        ? protectedRelative
        : `/${protectedRelative}`;
    }
  }

  const relativePrefix = trimmed.startsWith("./") ? "./" : "";
  const candidate = relativePrefix ? trimmed.slice(2) : trimmed;
  if (candidate.length < 2) return trimmed;

  const closingQuote = ASSISTANT_PATH_QUOTE_PAIRS[candidate.charAt(0)];
  if (
    closingQuote &&
    isBalancedAssistantPathQuotePair(candidate.charAt(0), candidate.charAt(candidate.length - 1))
  ) {
    return `${relativePrefix}${candidate.slice(1, -1).trim()}`;
  }

  const upperCandidate = candidate.toUpperCase();
  for (const [encodedOpening, encodedClosing] of Object.entries(ASSISTANT_PATH_ENCODED_QUOTE_PAIRS)) {
    if (
      upperCandidate.startsWith(encodedOpening) &&
      upperCandidate.endsWith(encodedClosing) &&
      candidate.length > encodedOpening.length + encodedClosing.length
    ) {
      return `${relativePrefix}${candidate.slice(encodedOpening.length, -encodedClosing.length).trim()}`;
    }
  }
  return trimmed;
}
