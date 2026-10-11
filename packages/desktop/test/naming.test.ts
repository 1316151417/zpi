import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const manifest = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

describe("project naming", () => {
  it("uses lowercase package names and workspace dependencies in manifests and the lockfile", () => {
    const lock = manifest("package-lock.json");
    expect(manifest("package.json").name).toBe("zpi");
    expect(lock.name).toBe("zpi");
    expect(lock.packages[""].name).toBe("zpi");
    for (const name of ["ai", "agent", "coding-agent", "desktop", "ui"]) {
      const path = `packages/${name}`;
      const pkg = manifest(`${path}/package.json`);
      expect(pkg.name).toBe(`zpi-${name}`);
      expect(lock.packages[path].name).toBe(pkg.name);
      expect(lock.packages[`node_modules/${pkg.name}`]).toEqual({ resolved: path, link: true });
      for (const dependency of Object.keys(pkg.dependencies ?? {})) {
        if (/^zpi-/i.test(dependency)) {
          expect(dependency).toBe(dependency.toLowerCase());
          expect(lock.packages[path].dependencies[dependency]).toBe(pkg.dependencies[dependency]);
        }
      }
    }
  });

  it("keeps product display names uppercase and application IDs lowercase for release and Preview", () => {
    const pkg = manifest("package.json");
    expect(pkg.build.productName).toBe("ZPI");
    expect(pkg.build.extraMetadata.productName).toBe("ZPI");
    expect(pkg.build.appId).toBe("local.zpi.desktop");
    for (const platform of ["mac", "win"]) {
      const script = pkg.scripts[`package:${platform}:preview`];
      expect(script).toContain('-c.productName="ZPI Preview"');
      expect(script).toContain("-c.appId=local.zpi.desktop.preview");
      expect(script).toContain('-c.extraMetadata.productName="ZPI Preview"');
    }
  });
});
