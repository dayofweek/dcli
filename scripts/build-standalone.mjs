import { build } from "esbuild"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const work = join(root, "build", "sea")
const outputDir = join(root, "dist", "standalone")
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
mkdirSync(outputDir, { recursive: true })

const bundle = join(work, "dcli.cjs")
await build({
  entryPoints: [join(root, "src", "bin", "dcli.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  minify: false,
  sourcemap: false,
})

const blob = join(work, "sea-prep.blob")
const config = join(work, "sea-config.json")
writeFileSync(config, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2))

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`)
  }
}

run(process.execPath, ["--experimental-sea-config", config])
const os = process.platform === "win32" ? "windows" : process.platform
const extension = process.platform === "win32" ? ".exe" : ""
const artifactName = `dcli-v${pkg.version}-${os}-${process.arch}${extension}`
const artifact = join(outputDir, artifactName)
copyFileSync(process.execPath, artifact)
if (process.platform !== "win32") chmodSync(artifact, 0o755)
if (process.platform === "darwin") run("codesign", ["--remove-signature", artifact])

const postject = join(root, "node_modules", "postject", "dist", "cli.js")
const postjectArgs = [
  artifact,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
]
if (process.platform === "darwin") postjectArgs.push("--macho-segment-name", "NODE_SEA")
run(process.execPath, [postject, ...postjectArgs])
if (process.platform === "darwin") run("codesign", ["--sign", "-", artifact])

const bytes = readFileSync(artifact)
const sha256 = createHash("sha256").update(bytes).digest("hex")
const manifest = {
  version: pkg.version,
  artifacts: [{ name: artifactName, os, arch: process.arch, sha256, bytes: bytes.byteLength }],
}
writeFileSync(join(outputDir, "checksums.json"), `${JSON.stringify(manifest, null, 2)}\n`)
writeFileSync(join(outputDir, "SHA256SUMS"), `${sha256}  ${artifactName}\n`)
console.log(JSON.stringify({ artifact, sha256, bytes: bytes.byteLength }))
