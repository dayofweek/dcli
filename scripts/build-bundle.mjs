import { build } from "esbuild"
import { chmodSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * A single-file, dependency-free build of the CLI.
 *
 * `dist/bin/dcli.js` is the normal entry point and needs `node_modules` beside
 * it, which is fine when npm installed the package. It is not fine for anyone
 * who unpacks the published tarball directly — the Day of Week desktop app does
 * exactly that, so a customer with no npm and no Node still gets a working
 * dcli. Bundling the dependencies in removes that install step entirely.
 *
 * Shipped alongside the normal build, never instead of it.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const outfile = join(root, "dist", "bundle", "dcli.cjs")

await build({
  entryPoints: [join(root, "src", "bin", "dcli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: false,
  sourcemap: false,
  // No banner: the entry point already carries its own shebang and esbuild
  // keeps it, so adding one here produces two and breaks the file.
})

chmodSync(outfile, 0o755)
console.log(JSON.stringify({ outfile, version: pkg.version }))
