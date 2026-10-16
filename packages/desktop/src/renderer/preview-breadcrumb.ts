// Adapted from ZCode PreviewPane.tsx (Apache-2.0).
export function previewBreadcrumb(path: string, workspace?: string) {
  const normalized = path.replaceAll("\\", "/");
  const cwd = workspace?.replaceAll("\\", "/").replace(/\/+$/, "");
  const inside = cwd && (normalized === cwd || normalized.startsWith(`${cwd}/`));
  const segments = (inside ? normalized.slice(cwd.length).replace(/^\//, "") : normalized)
    .split("/")
    .filter(Boolean);
  const file = segments.at(-1) ?? normalized.split("/").at(-1) ?? path;
  return inside
    ? { root: cwd.split("/").at(-1), parents: segments.slice(0, -1), file }
    : {
        root: normalized.startsWith("/") ? "/" : segments[0],
        parents: normalized.startsWith("/") ? segments.slice(0, -1) : segments.slice(1, -1),
        file,
      };
}
