import { fuzzyScore } from "../fuzzy-search.ts";
import type { InputSuggestion } from "../types.ts";

const unavailableNames = new Set(["side", "btw"]);
const builtins = new Set(["init", "compact"]);

export function isCommandSuggestion(suggestion: InputSuggestion): boolean {
  return (
    suggestion.group === "命令" &&
    !unavailableNames.has(suggestion.name.toLowerCase()) &&
    (builtins.has(suggestion.name) || suggestion.customCommand === true)
  );
}

export function customCommandNames(suggestions: readonly InputSuggestion[]): string[] {
  return suggestions.filter(isCommandSuggestion).map((suggestion) => suggestion.name);
}

export function subagentNames(suggestions: readonly InputSuggestion[]): string[] {
  return suggestions
    .filter((suggestion) => suggestion.group === "子智能体")
    .map((suggestion) => suggestion.name);
}

export function slashSuggestionLabel(suggestion: InputSuggestion): string {
  const prefix = suggestion.group === "Skill" ? "$" : suggestion.group === "子智能体" ? "" : "/";
  return `${prefix}${suggestion.name}`;
}

function suggestionScore(suggestion: InputSuggestion, query: string): number {
  const label = slashSuggestionLabel(suggestion);
  return Math.min(
    fuzzyScore(suggestion.name, query),
    fuzzyScore(label + (suggestion.argumentHint ? ` ${suggestion.argumentHint}` : ""), query) + 50,
    fuzzyScore(suggestion.description, query) + 250,
    fuzzyScore(suggestion.argumentHint ?? "", query) + 450,
    fuzzyScore(
      suggestion.group === "子智能体" ? "subagent agent" : suggestion.group === "Skill" ? "skill skills" : "",
      query,
    ) + 450,
  );
}

export function slashSuggestions(suggestions: readonly InputSuggestion[], query: string) {
  const normalized = query.trim().toLowerCase().replaceAll(":", "/");
  const rank = (items: InputSuggestion[]) =>
    normalized
      ? items
          .map((suggestion, index) => ({ suggestion, index, score: suggestionScore(suggestion, normalized) }))
          .filter((item) => Number.isFinite(item.score))
          .sort((a, b) => a.score - b.score || a.index - b.index)
          .map((item) => item.suggestion)
      : items;
  const commands = rank(suggestions.filter(isCommandSuggestion));
  const skills = rank(suggestions.filter((suggestion) => suggestion.group === "Skill"));
  const subagents = rank(suggestions.filter((suggestion) => suggestion.group === "子智能体"));
  const sections = [
    { label: "指令", options: commands, offset: 0 },
    { label: "技能", options: skills, offset: commands.length },
    { label: "子智能体", options: subagents, offset: commands.length + skills.length },
  ];
  const options = [...commands, ...skills, ...subagents];
  let selectedIndex = 0;
  let best = Number.POSITIVE_INFINITY;
  if (normalized)
    options.forEach((suggestion, index) => {
      const score = suggestionScore(suggestion, normalized);
      if (score < best) {
        best = score;
        selectedIndex = index;
      }
    });
  return { commands, skills, subagents, sections, options, selectedIndex };
}

export function slashTokenEnd(text: string, end: number, query: string, name: string): number {
  if (!query || !name.toLowerCase().startsWith(query.toLowerCase().replaceAll(":", "/"))) return end;
  const tail = /^[^\s@$#¥￥]*/.exec(text.slice(end))?.[0] ?? "";
  const expected = name.slice(query.length);
  const comparable = tail.slice(0, expected.length);
  return comparable && expected.toLowerCase().startsWith(comparable.toLowerCase())
    ? end + comparable.length
    : end;
}
