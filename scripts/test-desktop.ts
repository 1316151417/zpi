import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { assertBackgroundCommand } from "../tests/helpers/test-command.ts";

const args = process.argv.slice(2);
assertBackgroundCommand(args);
// The HTML reporter otherwise opens an external browser after a failed test.
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
process.argv = [process.execPath, cli, "test", ...args];
await import(pathToFileURL(cli).href);
