import { isAbsolute, relative, sep } from "node:path";

/** Both paths must already be resolved with the host filesystem's path rules. */
export function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
