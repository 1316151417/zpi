export function previewText(text: string): string {
  // The 100-code-unit preview can end halfway through a surrogate pair.
  return text.slice(0, 100).replace(/[\uD800-\uDBFF]$/u, "");
}
