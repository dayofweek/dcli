import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..")
const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs")

function help(...args: string[]): string {
  return execFileSync(process.execPath, [tsx, "src/bin/dcli.ts", ...args, "--help"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DCLI_AUTH_TOKEN: undefined, DCLI_TOKEN: undefined },
  })
}

describe("documented v1 command surface", () => {
  it("exposes auth, doctor, skills, and brain without network access", () => {
    const rootHelp = help()
    expect(rootHelp).toContain("auth")
    expect(rootHelp).toContain("doctor")
    expect(rootHelp).toContain("skill")
    expect(rootHelp).toContain("brain")
    expect(help("brain")).toMatch(/list[\s\S]*search[\s\S]*get[\s\S]*share[\s\S]*update[\s\S]*archive[\s\S]*source/)
    const authHelp = help("auth")
    expect(authHelp).toContain("login")
    expect(authHelp).toContain("status")
    expect(authHelp).toContain("logout")
    expect(help("brain", "source")).toContain("get")
    expect(help("skill")).toContain("bundle")
  }, 15_000)
})
