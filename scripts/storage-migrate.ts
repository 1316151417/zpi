/** Standalone, offline migration. Never called by application startup. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  activate,
  convert,
  inspect,
  type MigrationPlan,
  savePlan,
  validate,
} from "./storage-migration/workflow.ts";

export async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const flags = new Map<string, string>();
  let offline = false;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === "--offline-confirmed") {
      offline = true;
      continue;
    }
    if (
      !["--source", "--target", "--plan", "--generation"].includes(rest[index]) ||
      !rest[index + 1] ||
      rest[index + 1].startsWith("--")
    )
      throw new Error("unknown or incomplete option");
    flags.set(rest[index], rest[++index]);
  }
  const required = (name: string) => {
    const value = flags.get(name);
    if (!value) throw new Error(`${name} required`);
    return resolve(value);
  };
  if (command === "inspect") console.log(JSON.stringify(await inspect(required("--source")), null, 2));
  else if (command === "plan")
    console.log(JSON.stringify(await savePlan(required("--source"), required("--plan")), null, 2));
  else if (command === "validate") {
    await validate(required("--generation"));
    console.log("Validated");
  } else if (command === "convert" || command === "activate") {
    const plan = JSON.parse(await readFile(required("--plan"), "utf8")) as MigrationPlan;
    console.log(await (command === "convert" ? convert : activate)(plan, required("--target"), offline));
  } else
    throw new Error(
      "Usage: storage-migrate inspect|plan|convert|validate|activate --source DIR --plan FILE --target DIR --generation DIR [--offline-confirmed]",
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "Migration failed");
    process.exitCode = 1;
  });
}
