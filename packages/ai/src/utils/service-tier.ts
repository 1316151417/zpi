import type { Model } from "../types.ts";

export function fastServiceTier(model: Pick<Model, "api" | "serviceTiers">): string | undefined {
  if (model.api !== "openai-responses" && model.api !== "openai-completions") return undefined;
  return model.serviceTiers?.find((tier) => tier === "priority" || tier === "fast");
}
