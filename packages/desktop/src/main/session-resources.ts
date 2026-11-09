import type { SessionBuiltinResources } from "@zpi-dev/builtin-plugins/runtime";
import {
  type FileResourceLoader,
  loadSkillFile,
  type ResourceLoader,
  type SkillMetadata,
} from "@zpi-dev/coding-agent";
import type { CustomCommandSummary, CustomCommandsList } from "../shared/custom-commands.ts";

/** Discovery results and injected text, persisted with the existing session configuration. */
export interface SessionResources {
  instructions: string[];
  skills: SkillMetadata[];
  diagnostics: { path: string; message: string }[];
  builtin: SessionBuiltinResources;
  commands: CustomCommandsList<CustomCommandSummary>;
}

export function captureSessionResources(
  loader: FileResourceLoader,
  builtin: SessionBuiltinResources,
  commands: CustomCommandsList,
): SessionResources {
  return {
    instructions: loader.getInstructions().filter((part) => !part.startsWith("<skills>")),
    skills: loader.listSkills().skills,
    diagnostics: [...loader.getDiagnostics(), ...builtin.diagnostics],
    builtin,
    commands: {
      ...commands,
      commands: commands.commands.map(
        ({ prompt: _, revision: _revision, skills: _skills, ...metadata }) => metadata,
      ),
    },
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
