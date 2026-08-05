import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type SkillBundle = {
  name: string
  version: string
  hash?: string
  files: Array<{ path: string; content: string; sha256?: string }>
}

/**
 * Where an installed skill came from — recorded in `.dayofweek-skill.json` so
 * `skill update` and `skill status --check` can go back to the same origin.
 * "platform" = a named bundle from the built-in endpoint; "shared" = a skill
 * another user published into a shared knowledge area.
 */
export type SkillOrigin =
  | { source: "platform" }
  | { source: "shared"; skillId: string; areaId: string; uri: string }

export type InstalledSkillMetadata = {
  name: string
  version: string
  hash: string
  files: Record<string, string>
  origin?: SkillOrigin
}

/** Parse `<dir>/.dayofweek-skill.json`; null when absent or malformed. */
export function readInstalledSkill(targetDir: string): InstalledSkillMetadata | null {
  const metadataPath = join(targetDir, ".dayofweek-skill.json")
  if (!existsSync(metadataPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as InstalledSkillMetadata
    if (typeof parsed.name !== "string" || typeof parsed.version !== "string") return null
    return parsed
  } catch {
    return null
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

export function validateSkillBundle(bundle: SkillBundle): SkillBundle {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(bundle.name) || !bundle.version.trim() || bundle.version.length > 64) {
    throw new Error("Skill bundle metadata is invalid")
  }
  if (bundle.files.length === 0 || bundle.files.length > 64) throw new Error("Skill bundle file count is invalid")
  const paths = new Set<string>()
  const files = bundle.files.map((file) => {
    const segments = file.path.split("/")
    if (
      !file.path ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      paths.has(file.path) ||
      Buffer.byteLength(file.content) > 1_000_000
    ) {
      throw new Error("Skill bundle contained an unsafe file")
    }
    paths.add(file.path)
    const actual = sha256(file.content)
    if (file.sha256 && file.sha256 !== actual) throw new Error("Skill bundle file checksum mismatch")
    return { ...file, sha256: actual }
  })
  const actualBundleHash = sha256(files.map((file) => `${file.path}\0${file.sha256}`).join("\0"))
  if (bundle.hash && bundle.hash !== actualBundleHash) throw new Error("Skill bundle manifest checksum mismatch")
  return { ...bundle, hash: actualBundleHash, files }
}

export function writeSkillBundle(
  input: SkillBundle,
  targetDir: string,
  origin?: SkillOrigin,
): { written: number; unchanged: number; conflicts: string[] } {
  const bundle = validateSkillBundle(input)
  let filesWritten = 0
  let unchanged = 0
  const conflicts: string[] = []
  const metadataPath = join(targetDir, ".dayofweek-skill.json")
  const previous = existsSync(metadataPath)
    ? JSON.parse(readFileSync(metadataPath, "utf8")) as { files?: Record<string, string> }
    : undefined
  const hashes: Record<string, string> = {}
  for (const file of bundle.files) {
    const filePath = join(targetDir, file.path)
    const nextHash = file.sha256!
    hashes[file.path] = nextHash
    mkdirSync(dirname(filePath), { recursive: true })
    if (existsSync(filePath)) {
      const currentHash = sha256(readFileSync(filePath))
      if (currentHash === nextHash) {
        unchanged++
        continue
      }
      if (previous?.files?.[file.path] !== currentHash) {
        let suffix = 0
        let conflictPath = `${filePath}.new`
        while (existsSync(conflictPath) && suffix < 999) {
          suffix++
          conflictPath = `${filePath}.new.${suffix}`
        }
        if (existsSync(conflictPath)) throw new Error("Too many unresolved skill update conflicts")
        writeFileSync(conflictPath, file.content, { encoding: "utf8", flag: "wx" })
        conflicts.push(suffix === 0 ? `${file.path}.new` : `${file.path}.new.${suffix}`)
        continue
      }
    }
    writeFileSync(filePath, file.content, "utf-8")
    filesWritten++
  }
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(
    metadataPath,
    JSON.stringify(
      { name: bundle.name, version: bundle.version, hash: bundle.hash, files: hashes, ...(origin ? { origin } : {}) },
      null,
      2,
    ),
    "utf8",
  )
  return { written: filesWritten, unchanged, conflicts }
}
