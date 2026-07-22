import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(join(root, "dist", "standalone", "checksums.json"), "utf8"))
const artifact = join(root, "dist", "standalone", manifest.artifacts[0].name)

for (const args of [["--version"], ["--help"], ["brain", "--help"]]) {
  const result = spawnSync(artifact, args, { encoding: "utf8" })
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Standalone smoke failed for ${args.join(" ")}: ${result.stderr}`)
  }
}
const doctor = spawnSync(artifact, ["doctor", "--json"], {
  encoding: "utf8",
  env: { ...process.env, DCLI_AUTH_TOKEN: "", DCLI_TOKEN: "" },
})
const parsed = JSON.parse(doctor.stdout)
if (parsed.ok !== false || !Array.isArray(parsed.checks)) throw new Error("Offline doctor did not return stable JSON")
console.log(JSON.stringify({ ok: true, artifact }))
