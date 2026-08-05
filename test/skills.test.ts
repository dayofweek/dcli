import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readInstalledSkill, validateSkillBundle, writeSkillBundle } from "../src/skills.js"

const bundle = {
  name: "dayofweek-brain",
  version: "2.0.0",
  files: [{ path: "SKILL.md", content: "---\nname: dayofweek-brain\nversion: \"2.0.0\"\n---\n" }],
}

describe("managed skill bundles", () => {
  it("rejects forged hashes and unsafe paths before installation", () => {
    expect(() => validateSkillBundle({
      ...bundle,
      files: [{ ...bundle.files[0], sha256: "0".repeat(64) }],
    })).toThrow(/checksum/i)
    expect(() => validateSkillBundle({
      ...bundle,
      files: [{ path: "../SKILL.md", content: "unsafe" }],
    })).toThrow(/unsafe/i)
  })

  it("never overwrites a locally edited skill during repeated updates", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcli-skill-"))
    writeSkillBundle(bundle, directory)
    const skillPath = join(directory, "SKILL.md")
    writeFileSync(skillPath, "customer instructions\n")
    const first = writeSkillBundle({ ...bundle, version: "2.1.0", files: [{ ...bundle.files[0], content: "new version\n" }] }, directory)
    const second = writeSkillBundle({ ...bundle, version: "2.1.0", files: [{ ...bundle.files[0], content: "new version\n" }] }, directory)

    expect(readFileSync(skillPath, "utf8")).toBe("customer instructions\n")
    expect(first.conflicts).toEqual(["SKILL.md.new"])
    expect(second.conflicts).toEqual(["SKILL.md.new.1"])
  })

  it("records a shared origin in the install manifest and reads it back", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcli-skill-"))
    const origin = {
      source: "shared" as const,
      skillId: "sk123",
      areaId: "area123",
      uri: "dayofweek://brain/area123/skill/sk123",
    }
    writeSkillBundle(bundle, directory, origin)

    const installed = readInstalledSkill(directory)
    expect(installed).toMatchObject({ name: bundle.name, version: bundle.version, origin })
    expect(installed?.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("omits origin for platform installs and tolerates a missing manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcli-skill-"))
    writeSkillBundle(bundle, directory)
    expect(readInstalledSkill(directory)?.origin).toBeUndefined()
    expect(readInstalledSkill(join(directory, "nope"))).toBeNull()
  })
})
