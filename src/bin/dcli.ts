#!/usr/bin/env node

import { Command } from "commander"
import { DayOfWeekClient } from "../client.js"
import { getToken, getApiUrl, saveConfig, loadConfig } from "../config.js"
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"))

const program = new Command()
  .name("dcli")
  .description("CLI for the Day of Week AgTech platform")
  .version(pkg.version)
  .option("--token <token>", "Auth token (overrides DCLI_AUTH_TOKEN)")
  .option("--api-url <url>", "API base URL (overrides DCLI_API_URL)")
  .option("--json", "Output JSON (default for non-interactive use)")

function getClient(): DayOfWeekClient {
  const opts = program.opts()
  const token = opts.token ?? getToken()
  const apiUrl = opts.apiUrl ?? getApiUrl()
  return new DayOfWeekClient(token, apiUrl)
}

function output(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

// ── Auth Commands ────────────────────────────────────────────────────────────

const auth = program.command("auth").description("Authentication commands")

auth
  .command("login")
  .description("Authenticate via browser")
  .action(async () => {
    const apiUrl = program.opts().apiUrl ?? getApiUrl()
    const baseUrl = apiUrl.replace("/api/dcli", "")
    const authUrl = `${baseUrl}/dcli/auth`
    console.log(`Opening browser for authentication...`)
    console.log(`If the browser doesn't open, visit: ${authUrl}`)
    const open = (await import("open")).default
    await open(authUrl)
    console.log("\nAfter authenticating, copy the token and run:")
    console.log("  export DCLI_AUTH_TOKEN=<your-token>")
    console.log("  # or")
    console.log("  dcli auth set-token <your-token>")
  })

auth
  .command("set-token <token>")
  .description("Save a token to local config")
  .action((token: string) => {
    saveConfig({ authToken: token })
    console.log("Token saved to ~/.config/dayofweek/dcli.json")
  })

auth
  .command("status")
  .description("Check token health")
  .action(async () => {
    try {
      const client = getClient()
      const result = await client.checkAuth()
      // Persist isAdmin so the next CLI invocation can register admin
      // subcommands in --help without a network round-trip. Stale cache
      // is harmless: admin commands still reject non-admin tokens at the
      // API boundary, and admin demotion is rare.
      if (result.authenticated && typeof result.isAdmin === "boolean") {
        saveConfig({ isAdmin: result.isAdmin, roleCachedAt: Date.now() })
      }
      output(result)
    } catch (err: any) {
      console.error(`Auth check failed: ${err.message}`)
      process.exit(1)
    }
  })

auth
  .command("devices")
  .description("List your agent tokens")
  .action(async () => {
    const client = getClient()
    const devices = await client.listDevices()
    output(devices)
  })

auth
  .command("create-token <name>")
  .description("Create an agent token")
  .action(async (name: string) => {
    const client = getClient()
    const result = await client.createDevice(name)
    console.log("\nToken created — copy it now, it won't be shown again:\n")
    console.log(`  ${result.secret}\n`)
    console.log("Set it as DCLI_AUTH_TOKEN in your agent's environment.")
  })

auth
  .command("revoke <deviceId>")
  .description("Revoke an agent token")
  .action(async (deviceId: string) => {
    const client = getClient()
    await client.revokeDevice(deviceId)
    console.log("Token revoked.")
  })

// ── Read Commands ────────────────────────────────────────────────────────────

const read = program.command("read").description("Read platform data")

read
  .command("entities")
  .description("List entities in your organization")
  .option("--type <entityType>", "Filter by type (Farm, Producer, Restaurant, ...)")
  .option("--parent <entityId>", "List children of an entity")
  .option("--limit <count>", "Max results", parseInt)
  .action(async (opts) => {
    const client = getClient()
    const result = await client.listEntities(opts)
    output(result)
  })

read
  .command("entity <entityId>")
  .description("Get entity details")
  .action(async (entityId: string) => {
    const client = getClient()
    const result = await client.getEntity(entityId)
    output(result)
  })

read
  .command("produce")
  .description("List produce profiles")
  .option("--entity <entityId>", "Filter by entity")
  .option("--limit <count>", "Max results", parseInt)
  .action(async (opts) => {
    const client = getClient()
    const result = await client.listProduce(opts)
    output(result)
  })

read
  .command("contacts")
  .description("List contacts and memberships")
  .option("--entity <entityId>", "Filter by entity")
  .option("--limit <count>", "Max results", parseInt)
  .action(async (opts) => {
    const client = getClient()
    const result = await client.listContacts(opts)
    output(result)
  })

read
  .command("entity-types")
  .description("List available entity types")
  .action(async () => {
    const client = getClient()
    const result = await client.listEntityTypes()
    output(result)
  })

read
  .command("catalog")
  .description("Search or browse the produce catalog (selectable items only by default)")
  .option("--search <query>", "Search by name")
  .option("--parent <conceptId>", "List children of a category")
  .option("--type <nodeType>", "Filter by type (category, produce, variety)")
  .option("--include-categories", "Include non-selectable categories in results")
  .option("--limit <count>", "Max results", parseInt)
  .action(async (opts) => {
    const client = getClient()
    const result = await client.searchCatalog(opts)
    output(result)
  })

// ── Agent Commands ───────────────────────────────────────────────────────────

const agent = program.command("agent").description("Submit and view proposals")

agent
  .command("propose")
  .description("Submit a proposal for review")
  .requiredOption("--op <operation>", "Operation: create, update, or delete")
  .requiredOption("--table <table>", "Target table (e.g. hierarchyEntities)")
  .requiredOption("--title <title>", "Human-readable title")
  .option("--description <text>", "Reasoning/evidence")
  .option("--source <agent>", "Agent identifier")
  .option("--source-url <url>", "Evidence URL")
  .option("--confidence <score>", "Confidence 0-1", parseFloat)
  .option("--parent <entityId>", "Parent entity ID")
  .option("--entity-type <type>", "Entity type (Farm, Producer, ...)")
  .option("--target-id <id>", "Target record ID (for update/delete)")
  .option("--file <path>", "Read payload from JSON file (- for stdin)")
  .option("--payload <json>", "Inline JSON payload")
  .action(async (opts) => {
    let payload = opts.payload ? JSON.parse(opts.payload) : {}
    if (opts.file) {
      const content = opts.file === "-"
        ? await readStdin()
        : readFileSync(opts.file, "utf-8")
      payload = JSON.parse(content)
    }

    const client = getClient()
    const result = await client.submitProposal({
      operation: opts.op,
      targetTable: opts.table,
      title: opts.title,
      description: opts.description,
      payload,
      targetRecordId: opts.targetId,
      sourceAgent: opts.source,
      sourceUrl: opts.sourceUrl,
      confidence: opts.confidence,
      proposedParentId: opts.parent,
      proposedEntityType: opts.entityType,
    })
    output(result)
  })

agent
  .command("propose-batch")
  .description("Submit multiple proposals")
  .requiredOption("--label <label>", "Batch label")
  .option("--source <agent>", "Agent identifier")
  .requiredOption("--file <path>", "JSON file with proposals array (- for stdin)")
  .action(async (opts) => {
    const content = opts.file === "-"
      ? await readStdin()
      : readFileSync(opts.file, "utf-8")
    const proposals = JSON.parse(content)

    const client = getClient()
    const result = await client.submitBatch({
      batchLabel: opts.label,
      sourceAgent: opts.source,
      proposals: Array.isArray(proposals) ? proposals : [proposals],
    })
    output(result)
  })

agent
  .command("proposals")
  .description("List proposals")
  .option("--status <status>", "Filter: pending, approved, rejected, failed")
  .option("--source <source>", "Filter: discovery, agent, manual")
  .option("--limit <count>", "Max results", parseInt)
  .action(async (opts) => {
    const client = getClient()
    const result = await client.listProposals(opts)
    output(result)
  })

agent
  .command("show <proposalId>")
  .description("Show proposal details")
  .action(async (proposalId: string) => {
    const client = getClient()
    const result = await client.getProposal(proposalId)
    output(result)
  })

// ── Skill Commands ───────────────────────────────────────────────────────────

const skill = program.command("skill").description("Manage the Day of Week agent skill")

type SkillTarget = "agents" | "claude" | "all"

function resolveTargetDirs(target: SkillTarget, bundleName: string, customDir?: string): string[] {
  if (customDir) return [customDir]
  const agentsDir = join(homedir(), ".agents", "skills", bundleName)
  const claudeDir = join(homedir(), ".claude", "skills", bundleName)
  const claudeRootExists = existsSync(join(homedir(), ".claude"))
  switch (target) {
    case "agents":
      return [agentsDir]
    case "claude":
      return [claudeDir]
    case "all":
      return claudeRootExists ? [agentsDir, claudeDir] : [agentsDir]
  }
}

function writeBundle(bundle: { files: Array<{ path: string; content: string }> }, targetDir: string): number {
  let filesWritten = 0
  for (const file of bundle.files) {
    const filePath = join(targetDir, file.path)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, file.content, "utf-8")
    filesWritten++
  }
  return filesWritten
}

function parseTarget(value: string | undefined): SkillTarget {
  const v = (value ?? "all").toLowerCase()
  if (v !== "agents" && v !== "claude" && v !== "all") {
    console.error(`Invalid --target: ${value}. Use agents, claude, or all.`)
    process.exit(1)
  }
  return v
}

skill
  .command("install")
  .description("Install the agent skill (requires valid auth)")
  .option("--dir <path>", "Custom install directory (overrides --target)")
  .option("--target <target>", "Install target: agents, claude, or all (default: all)")
  .action(async (opts) => {
    const client = getClient()
    const bundle = await client.getSkillBundle()
    const target = parseTarget(opts.target)
    const dirs = resolveTargetDirs(target, bundle.name, opts.dir)

    for (const dir of dirs) {
      const count = writeBundle(bundle, dir)
      console.log(`Installed ${count} files to ${dir}`)
    }
    console.log("Any compatible agent will discover the skill automatically.")
  })

skill
  .command("update")
  .description("Update the skill to the latest version")
  .option("--dir <path>", "Custom install directory (overrides --target)")
  .option("--target <target>", "Install target: agents, claude, or all (default: all)")
  .action(async (opts) => {
    const client = getClient()
    const bundle = await client.getSkillBundle()
    const target = parseTarget(opts.target)
    const dirs = resolveTargetDirs(target, bundle.name, opts.dir)

    for (const dir of dirs) {
      const count = writeBundle(bundle, dir)
      console.log(`Updated ${count} files in ${dir}`)
    }
  })

skill
  .command("status")
  .description("Check if the skill is installed")
  .option("--dir <path>", "Custom install directory (overrides --target)")
  .option("--target <target>", "Check target: agents, claude, or all (default: all)")
  .action(async (opts) => {
    const bundleName = "dayofweek-platform"
    const target = parseTarget(opts.target)
    const dirs = opts.dir
      ? [opts.dir]
      : target === "all"
        ? [join(homedir(), ".agents", "skills", bundleName), join(homedir(), ".claude", "skills", bundleName)]
        : resolveTargetDirs(target, bundleName)

    let anyInstalled = false
    for (const dir of dirs) {
      const skillPath = join(dir, "SKILL.md")
      if (!existsSync(skillPath)) {
        console.log(`Not installed at: ${dir}`)
        continue
      }
      anyInstalled = true
      const content = readFileSync(skillPath, "utf-8")
      const versionMatch = content.match(/version:\s*"([^"]+)"/)
      console.log(`Installed at: ${dir}`)
      console.log(`  Version: ${versionMatch?.[1] ?? "unknown"}`)
    }

    if (!anyInstalled) {
      console.log("\nRun: dcli skill install")
      process.exit(1)
    }
    console.log("\nTo update: dcli skill update")
  })

// ── Admin Commands ───────────────────────────────────────────────────────────
//
// These are admin-only. They're registered as hidden subcommands when the
// cached role from the last `dcli auth status` says the caller is admin —
// otherwise they're not advertised in --help at all and customers never
// learn the commands exist. The endpoints themselves enforce admin auth
// independently, so stale or absent cache can't grant access.
//
// New admin agents should run `dcli auth status` once after install to
// populate the cache; the admin skill bundle (ADMIN_MD) documents this.

function registerAdminCommands() {
  const cfg = loadConfig()
  if (!cfg.isAdmin) return

  const admin = program
    .command("admin", { hidden: true })
    .description("Admin-only cross-org operations (DoW staff)")

  admin
    .command("entities")
    .description("List entities across all orgs with admin filters")
    .option("--type <entityType>", "Filter by entity type")
    .option("--missing-location", "Only entities lacking metadata.places[].lat/lng")
    .option("--search <query>", "Substring match on name")
    .option("--org <slug>", "Restrict to a single org slug or ID")
    .option("--limit <count>", "Max results (default 200)", parseInt)
    .action(async (opts) => {
      const client = getClient()
      const result = await client.adminListEntities({
        org: opts.org,
        type: opts.type,
        missingLocation: opts.missingLocation,
        search: opts.search,
        limit: opts.limit,
      })
      output(result)
    })

  admin
    .command("proposals")
    .description("List agent proposals across all orgs")
    .option("--status <status>", "Filter: pending, approved, rejected, failed")
    .option("--source-agent <name>", "Filter by sourceAgent identifier")
    .option("--limit <count>", "Max results (default 100)", parseInt)
    .action(async (opts) => {
      const client = getClient()
      const result = await client.adminListProposals({
        status: opts.status,
        sourceAgent: opts.sourceAgent,
        limit: opts.limit,
      })
      output(result)
    })
}

registerAdminCommands()

// ── Helpers ──────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: string[] = []
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) {
    chunks.push(line)
  }
  return chunks.join("\n")
}

// ── Run ──────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})
