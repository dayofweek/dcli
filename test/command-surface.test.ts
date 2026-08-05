import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..")
const tsx = resolve(root, "node_modules/tsx/dist/cli.mjs")

function run(args: string[], options: { home?: string } = {}): string {
  return execFileSync(process.execPath, [tsx, "src/bin/dcli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DCLI_AUTH_TOKEN: undefined,
      DCLI_TOKEN: undefined,
      ...(options.home ? { HOME: options.home, USERPROFILE: options.home } : {}),
    },
  })
}

function help(...args: string[]): string {
  return run([...args, "--help"])
}

function helpAsAdmin(home: string, ...args: string[]): string {
  return run([...args, "--help"], { home })
}

/**
 * A HOME whose dcli config claims admin, so the hidden admin-only groups
 * register. The endpoints still enforce admin auth server-side — this only
 * controls what the local --help surface advertises.
 */
function adminHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dcli-admin-home-"))
  mkdirSync(join(home, ".config", "dayofweek"), { recursive: true })
  writeFileSync(
    join(home, ".config", "dayofweek", "dcli.json"),
    JSON.stringify({ isAdmin: true, roleCachedAt: Date.now() }),
  )
  return home
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
    const skillHelp = help("skill")
    expect(skillHelp).toContain("bundle")
    expect(skillHelp).toContain("publish")
    expect(skillHelp).toContain("archive")
    expect(help("skill", "install")).toContain("--area")
    expect(help("skill", "status")).toContain("--check")
    expect(help("skill", "publish")).toContain("--visibility")
  }, 60_000)

  // The server has always accepted an org on both proposal endpoints. While the
  // CLI didn't send one, an admin's proposals were filed under their own org but
  // applied to whatever entity the payload named, so the review queue and the
  // affected data pointed at different customers.
  it("lets admins target another org when proposing", () => {
    expect(help("agent", "propose")).toContain("--org")
    expect(help("agent", "propose-batch")).toContain("--org")
  }, 60_000)
})

// The skill tells agents to reach the platform only through dcli, never with
// curl against /api/dcli. That promise only holds if every documented workflow
// actually has a command — the backlog and email loops used to be curl-only.
describe("every documented workflow has a dcli command", () => {
  it("exposes the feedback backlog loop", () => {
    expect(help()).toContain("feedback")
    const feedbackHelp = help("feedback")
    for (const command of ["list", "next", "show", "claim", "comment", "status"]) {
      expect(feedbackHelp).toContain(command)
    }
    expect(help("feedback", "status")).toContain("--priority")
  }, 60_000)

  it("exposes the customer email loop to admins", () => {
    const emailsHelp = helpAsAdmin(adminHome(), "emails")
    for (const command of ["list", "show", "reply", "compose"]) {
      expect(emailsHelp).toContain(command)
    }
  }, 60_000)

  it("keeps the email loop off a non-admin's command surface", () => {
    const home = mkdtempSync(join(tmpdir(), "dcli-plain-home-"))
    expect(run(["--help"], { home })).not.toContain("emails")
  }, 60_000)
})

describe("dataset reads are server-discovered", () => {
  it("exposes generic data commands", () => {
    const rootHelp = help()
    expect(rootHelp).toContain("data")
    const dataHelp = help("data")
    expect(dataHelp).toContain("list")
    expect(dataHelp).toContain("get")
  }, 60_000)

  // dcli is open source. The dataset catalog lives server-side precisely so
  // the public CLI reveals nothing about the platform's product surfaces —
  // a product name appearing in this repo is a leak, not a feature.
  it("ships no platform product or surface names", () => {
    const sources = readdirSync(join(root, "src"), { recursive: true }) as string[]
    const text = sources
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(root, "src", name), "utf8"))
      .join("\n")
    for (const name of ["foodfun", "food fun", "brandlab", "brand lab", "sproutlab", "yggdrasil", "blender"]) {
      expect(text.toLowerCase()).not.toContain(name)
    }
  })
})

// Sending mail to a customer is irreversible and outward-facing. Reading a
// thread must never be able to send one as a side effect, so the send paths
// refuse without an explicit approval flag — the mechanical backstop behind
// the skill's ask-before-send rule.
describe("email sending requires explicit approval", () => {
  it("refuses to reply without --approved", () => {
    const home = adminHome()
    expect(() =>
      run(["emails", "reply", "etx_abc", "--message", "hei"], { home }),
    ).toThrow(/Refusing to send/)
  }, 60_000)

  // Same shape of risk: `produce import` writes real Creator rows rather than
  // proposals, so it must not run off an unreviewed payload.
  it("refuses to import produce without --dry-run or --approved", () => {
    const home = adminHome()
    const payload = join(home, "items.json")
    writeFileSync(payload, JSON.stringify({ entityId: "abc", items: [] }))
    expect(() =>
      run(["produce", "import", "--file", payload], { home }),
    ).toThrow(/Refusing to write/)
  }, 60_000)

  it("refuses to compose without --approved", () => {
    const home = adminHome()
    expect(() =>
      run([
        "emails", "compose",
        "--entity", "abc",
        "--to", "person@example.com",
        "--subject", "Hei",
        "--message", "hei",
      ], { home }),
    ).toThrow(/Refusing to send/)
  }, 60_000)
})
