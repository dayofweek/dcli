import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..")

/**
 * The Day of Week desktop app installs dcli by unpacking the published tarball
 * — no npm, so no node_modules. That only works because the package ships a
 * bundle with its dependencies compiled in. These tests guard that contract:
 * if the bundle stops being built or stops being published, dcli updates break
 * for every desktop customer, and nothing else in the suite would notice.
 */
describe("published package shape", () => {
  it("builds a dependency-free bundle that runs on its own", () => {
    execFileSync(process.execPath, ["scripts/build-bundle.mjs"], { cwd: root, timeout: 120_000 })
    const bundle = resolve(root, "dist/bundle/dcli.cjs")
    expect(existsSync(bundle)).toBe(true)

    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }
    const version = execFileSync(process.execPath, [bundle, "--version"], {
      encoding: "utf8",
      // An empty node_modules lookup path proves nothing is resolved at runtime.
      cwd: "/",
      env: { ...process.env, DCLI_AUTH_TOKEN: undefined, DCLI_TOKEN: undefined },
    }).trim()
    expect(version).toBe(pkg.version)
  }, 180_000)

  it("keeps the bundle in the published files and the default build", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      files: string[]
      scripts: Record<string, string>
    }
    // `dist/` covers dist/bundle; a narrower list would have to name it.
    expect(pkg.files.some((entry) => entry === "dist/" || entry.startsWith("dist/bundle"))).toBe(true)
    expect(pkg.scripts.build).toContain("build-bundle.mjs")
  })
})
