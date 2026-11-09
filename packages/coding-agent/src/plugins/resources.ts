import type { LoadedSkill } from "../core/resources.ts";
import type { ResourceLoader } from "../core/types.ts";
import type { PluginSkill } from "./types.ts";

/** Adds explicit frozen plugin skills without changing filesystem discovery. */
export function withPluginResources(loader: ResourceLoader, skills: readonly PluginSkill[]): ResourceLoader {
  if (!skills.length) return loader;
  const metadata = skills.map(({ body: _body, ...skill }) => ({ ...skill, source: "plugin" as const }));
  return {
    immutable: loader.immutable,
    reload: () => loader.reload?.() ?? Promise.resolve(),
    getBaseInstructions: () => loader.getBaseInstructions?.(),
    getInstructions: () => loader.getInstructions?.() ?? [],
    getDiagnostics: () => loader.getDiagnostics?.() ?? [],
    listSkills: () => {
      const existing = loader.listSkills?.() ?? { skills: [], diagnostics: [] };
      if (existing.skills.some((skill) => metadata.some((plugin) => plugin.name === skill.name)))
        throw new Error("Duplicate resource skill");
      return { ...existing, skills: [...existing.skills, ...structuredClone(metadata)] };
    },
    loadSkill: async (name) => {
      const skill = skills.find((entry) => entry.name === name);
      if (skill) return { ...structuredClone(skill), source: "plugin" } satisfies LoadedSkill;
      if (!loader.loadSkill) throw new Error(`Skill not found: ${name}`);
      return loader.loadSkill(name);
    },
  };
}
