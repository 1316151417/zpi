import type { SessionBuiltinResources } from "@zpi-dev/builtin-plugins/runtime";
import {
  type FileResourceLoader,
  loadSkillFile,
  type ResourceLoader,
  type SkillMetadata,
} from "@zpi-dev/coding-agent";

/** Discovery results and injected text, persisted with the existing session configuration. */
export interface SessionResources {
  instructions: string[];
  skills: SkillMetadata[];
  diagnostics: { path: string; message: string }[];
  builtin: SessionBuiltinResources;
}

export function captureSessionResources(
  loader: FileResourceLoader,
  builtin: SessionBuiltinResources,
): SessionResources {
  return {
    instructions: loader.getInstructions().filter((part) => !part.startsWith("<skills>")),
    skills: loader.listSkills().skills,
    diagnostics: [...loader.getDiagnostics(), ...builtin.diagnostics],
    builtin,
  };
}

export function sessionResourceLoader(
  resources?: SessionResources,
): Required<Omit<ResourceLoader, "immutable">> & { immutable: true } {
  return {
    immutable: true,
    reload: async () => {},
    getBaseInstructions: () => undefined,
    getInstructions: () => [...(resources?.instructions ?? [])],
    getDiagnostics: () => structuredClone(resources?.diagnostics ?? []),
    listSkills: () => ({
      skills: structuredClone(resources?.skills ?? []),
      diagnostics: structuredClone(resources?.diagnostics ?? []),
    }),
    loadSkill: async (name) => {
      const skill = resources?.skills.find((skill) => skill.name === name);
      if (!skill) throw new Error(`invalid_input: Skill not found: ${name}`);
      return loadSkillFile(skill);
    },
  };
}
