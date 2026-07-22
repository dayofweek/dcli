#!/usr/bin/env node

import { Command } from "commander"
import { ApiError, DayOfWeekClient } from "../client.js"
import { getToken, getApiUrl, saveConfig, loadConfig, saveCredential, deleteCredential } from "../config.js"
import { browserLogin } from "../auth/login.js"
import { parseBrainResource } from "../uri.js"
import { accessSync, constants, readFileSync, existsSync, statSync } from "node:fs"
import { join, basename, resolve, relative, sep } from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"
import pkg from "../../package.json" with { type: "json" }
import { createHash } from "node:crypto"
import { validateSkillBundle, writeSkillBundle } from "../skills.js"

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
  .option("--scopes <scopes>", "Comma-separated scopes", "brain:read,brain:write")
  .option("--source-app <sourceApp>", "Authorization client", "dcli")
  .action(async (opts: { scopes: string; sourceApp: string }) => {
    const apiUrl = program.opts().apiUrl ?? getApiUrl()
    const scopes = opts.scopes.split(",").map((scope) => scope.trim()).filter(Boolean)
    if (opts.sourceApp !== "dcli" && opts.sourceApp !== "dayofweek-desktop") throw new Error("Invalid authorization client")
    console.error("Opening Day of Week in your browser…")
    const result = await browserLogin({ apiUrl, scopes, sourceApp: opts.sourceApp })
    saveCredential(result.secret)
    output({ authenticated: true, scopes: result.scopes, bootstrap: result.bootstrap })
  })

auth
  .command("logout")
  .description("Revoke and remove the credential from this device")
  .action(async () => {
    if (program.opts().token || process.env.DCLI_AUTH_TOKEN || process.env.DCLI_TOKEN) {
      throw new Error("Unset the token override before logging out this device")
    }
    const client = new DayOfWeekClient(getToken(), getApiUrl())
    await client.revokeCurrentDevice()
    deleteCredential()
    output({ authenticated: false, loggedOut: true, revoked: true })
  })

auth
  .command("status")
  .description("Check token health")
  .action(async () => {
    try {
      const client = getClient()
      let result: unknown
      try {
        result = await client.brainBootstrap()
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "scope_denied") throw error
        result = await client.checkAuth()
      }
      // Persist isAdmin so the next CLI invocation can register admin
      // subcommands in --help without a network round-trip. Stale cache
      // is harmless: admin commands still reject non-admin tokens at the
      // API boundary, and admin demotion is rare.
      if (
        typeof result === "object" &&
        result !== null &&
        "authenticated" in result &&
        "isAdmin" in result &&
        typeof result.isAdmin === "boolean"
      ) {
        saveConfig({ isAdmin: result.isAdmin, roleCachedAt: Date.now() })
      }
      output(result)
    } catch (err: any) {
      console.error(`Auth check failed: ${err.message}`)
      process.exit(1)
    }
  })

program
  .command("doctor")
  .description("Run machine-readable Day of Week health checks")
  .action(async () => {
    const project = inspectWikiProject(process.cwd())
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [
      { name: "binary", ok: true, detail: pkg.version },
      { name: "credential", ok: false },
      { name: "api", ok: false },
      { name: "login", ok: false },
      { name: "areas", ok: false },
      project.manifest,
      project.launcher,
      project.skills,
      project.write,
      { name: "default_area", ok: false, detail: "manifest or API unavailable" },
    ]
    try {
      getToken()
      checks[1] = { name: "credential", ok: true }
      const bootstrap = await getClient().brainBootstrap()
      checks[2] = { name: "api", ok: true }
      checks[3] = { name: "login", ok: bootstrap.authenticated, detail: bootstrap.scopes.join(",") }
      checks[4] = { name: "areas", ok: bootstrap.areas.length > 0, detail: String(bootstrap.areas.length) }
      const defaultArea = checks.find((check) => check.name === "default_area")!
      defaultArea.ok = Boolean(project.defaultAreaId && bootstrap.areas.some((area) => area.id === project.defaultAreaId))
      defaultArea.detail = defaultArea.ok ? project.defaultAreaId : "configured area is no longer accessible"
      output({ ok: checks.every((check) => check.ok), checks, defaultAreaId: bootstrap.defaultAreaId })
    } catch (error) {
      output({ ok: false, checks, error: error instanceof Error ? error.message : "Health check failed" })
      process.exitCode = 2
    }
  })

// ── Shared Brain Commands ───────────────────────────────────────────────────

const brain = program.command("brain").description("Work with shared Day of Week knowledge")

const brainCompany = brain.command("company").description("Connect the idempotent company knowledge space")

brainCompany
  .command("status")
  .description("Check whether the current hierarchy membership can connect a company space")
  .action(async () => output(await getClient().companyBrainStatus()))

brainCompany
  .command("ensure")
  .description("Create or connect the one company brain for the current entity")
  .action(async () => output(await getClient().ensureCompanyBrain()))

brain
  .command("list")
  .description("List accessible company and project spaces")
  .action(async () => output(await getClient().listBrainAreas()))

brain
  .command("search <query>")
  .description("Search accessible shared knowledge")
  .option("--area <areaId>", "Restrict to one accessible area")
  .option("--limit <count>", "Maximum results", (value) => Number.parseInt(value, 10), 10)
  .action(async (query: string, opts: { area?: string; limit?: number }) => {
    output(await getClient().searchBrain(query, { areaId: opts.area, limit: opts.limit }))
  })

brain
  .command("get <uri>")
  .description("Resolve a Day of Week brain URI")
  .option("--markdown", "Print note markdown only")
  .action(async (uri: string, opts: { markdown?: boolean }) => {
    parseBrainResource(uri)
    const result = await getClient().resolveBrain(uri)
    if (opts.markdown) {
      if (result.resourceType !== "note") throw new Error("--markdown requires a note URI")
      process.stdout.write(result.note.markdown)
      if (!result.note.markdown.endsWith("\n")) process.stdout.write("\n")
      return
    }
    output(result)
  })

brain
  .command("share")
  .description("Explicitly share a markdown note")
  .requiredOption("--area <areaId>", "Destination area")
  .requiredOption("--title <title>", "Shared note title")
  .option("--file <path>", "Markdown file")
  .option("--stdin", "Read markdown from standard input")
  .requiredOption("--intent <intent>", "interactive or autonomous")
  .action(async (opts: { area: string; title: string; file?: string; stdin?: boolean; intent: string }) => {
    if (Boolean(opts.file) === Boolean(opts.stdin)) throw new Error("Use exactly one of --file or --stdin")
    if (opts.intent !== "interactive" && opts.intent !== "autonomous") throw new Error("Invalid --intent")
    const markdown = opts.stdin ? await readStdin() : readFileSync(opts.file!, "utf8")
    output(await getClient().shareBrainNote({
      areaId: opts.area,
      title: opts.title,
      markdown,
      sourceName: opts.file ? basename(opts.file) : undefined,
      intent: opts.intent,
    }))
  })

brain
  .command("update <uri>")
  .description("Update a shared note with optimistic concurrency")
  .requiredOption("--file <path>", "Markdown file")
  .requiredOption("--if-version <version>", "Expected current version", (value) => Number.parseInt(value, 10))
  .option("--title <title>", "Updated title")
  .action(async (uri: string, opts: { file: string; ifVersion: number; title?: string }) => {
    const parsed = parseBrainResource(uri)
    if (parsed.resourceType !== "note" || !parsed.resourceId) throw new Error("A note URI is required")
    const note = await getClient().updateBrainNote(parsed.resourceId, {
      title: opts.title,
      markdown: readFileSync(opts.file, "utf8"),
      expectedVersion: opts.ifVersion,
    })
    if (note.areaId !== parsed.areaId) throw new Error("Server returned a mismatched area")
    output(note)
  })

brain
  .command("archive <uri>")
  .description("Soft-archive a shared note")
  .requiredOption("--if-version <version>", "Expected current version", (value) => Number.parseInt(value, 10))
  .action(async (uri: string, opts: { ifVersion: number }) => {
    const parsed = parseBrainResource(uri)
    if (parsed.resourceType !== "note" || !parsed.resourceId) throw new Error("A note URI is required")
    const note = await getClient().archiveBrainNote(parsed.resourceId, opts.ifVersion)
    if (note.areaId !== parsed.areaId) throw new Error("Server returned a mismatched area")
    output(note)
  })

brain
  .command("restore <uri>")
  .description("Restore an archived shared note")
  .requiredOption("--if-version <version>", "Expected current version", (value) => Number.parseInt(value, 10))
  .action(async (uri: string, opts: { ifVersion: number }) => {
    const parsed = parseBrainResource(uri)
    if (parsed.resourceType !== "note" || !parsed.resourceId) throw new Error("A note URI is required")
    const note = await getClient().restoreBrainNote(parsed.resourceId, opts.ifVersion)
    if (note.areaId !== parsed.areaId) throw new Error("Server returned a mismatched area")
    output(note)
  })

brain
  .command("audit")
  .description("List bounded audit metadata (area owner and brain:manage scope required)")
  .requiredOption("--area <areaId>", "Area to inspect")
  .option("--cursor <cursor>", "Pagination cursor")
  .option("--limit <count>", "Maximum events", (value) => Number.parseInt(value, 10), 50)
  .action(async (opts: { area: string; cursor?: string; limit?: number }) => {
    output(await getClient().listBrainAudit(opts.area, { cursor: opts.cursor, limit: opts.limit }))
  })

const brainSource = brain.command("source").description("Work with original shared files and recordings")

brainSource
  .command("get <uri>")
  .description("Read source metadata and derived text")
  .action(async (uri: string) => {
    const parsed = parseBrainResource(uri)
    if (parsed.resourceType !== "source" || !parsed.resourceId) throw new Error("A source URI is required")
    const source = await getClient().getBrainSource(parsed.resourceId)
    if (source.areaId !== parsed.areaId) throw new Error("Server returned a mismatched area")
    output(source)
  })

brainSource
  .command("upload")
  .description("Upload an original file or meeting recording")
  .requiredOption("--area <areaId>", "Destination area")
  .requiredOption("--file <path>", "File to upload")
  .option("--mime <mimeType>", "MIME type; inferred from extension when omitted")
  .option("--meeting", "Mark this source as a recorded meeting")
  .option("--consent-ack", "Confirm recorded participants were informed and consented")
  .action(async (opts: { area: string; file: string; mime?: string; meeting?: boolean; consentAck?: boolean }) => {
    if (opts.meeting && !opts.consentAck) {
      throw new Error("--consent-ack is required: you are attesting that recorded participants were informed and consented")
    }
    output(await getClient().uploadBrainSource({
      areaId: opts.area,
      path: opts.file,
      mimeType: opts.mime ?? inferMimeType(opts.file),
      isMeeting: opts.meeting ?? false,
      consentAcknowledged: opts.consentAck ?? false,
    }))
  })

brainSource
  .command("download <uri>")
  .description("Download exact original bytes to an explicit path")
  .requiredOption("--output <path>", "Explicit output file")
  .option("--overwrite", "Replace an existing output file")
  .action(async (uri: string, opts: { output: string; overwrite?: boolean }) => {
    const parsed = parseBrainResource(uri)
    if (parsed.resourceType !== "source" || !parsed.resourceId) throw new Error("A source URI is required")
    const source = await getClient().getBrainSource(parsed.resourceId)
    if (source.areaId !== parsed.areaId) throw new Error("Server returned a mismatched area")
    output(await getClient().downloadBrainSource({
      sourceId: source.id,
      outputPath: opts.output,
      expectedSha256: source.sha256,
      overwrite: opts.overwrite,
    }))
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

type DoctorCheck = { name: string; ok: boolean; detail?: string }

function inspectWikiProject(directory: string): {
  manifest: DoctorCheck
  launcher: DoctorCheck
  skills: DoctorCheck
  write: DoctorCheck
  defaultAreaId?: string
} {
  const root = resolve(directory)
  const manifestPath = join(root, ".dayofweek", "manifest.json")
  const missing = {
    manifest: { name: "project_manifest", ok: false, detail: "not found in current directory" },
    launcher: { name: "project_launcher", ok: false, detail: "manifest unavailable" },
    skills: { name: "project_skills", ok: false, detail: "manifest unavailable" },
    write: { name: "project_write", ok: false, detail: "manifest unavailable" },
  }
  if (!existsSync(manifestPath)) return missing

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schemaVersion?: number
      dcliVersion?: string
      dcliRuntimePath?: string
      managedFiles?: Record<string, string>
      skillVersions?: Record<string, string>
      defaultAreaId?: string
    }
    if (
      manifest.schemaVersion !== 1 ||
      typeof manifest.dcliRuntimePath !== "string" ||
      !manifest.managedFiles ||
      typeof manifest.managedFiles !== "object"
    ) {
      return {
        manifest: { name: "project_manifest", ok: false, detail: "invalid schema" },
        launcher: missing.launcher,
        skills: missing.skills,
        write: missing.write,
      }
    }

    const runtime = resolve(manifest.dcliRuntimePath)
    const runtimeOk = existsSync(runtime) && statSync(runtime).isFile()
    const launcherPaths = process.platform === "win32"
      ? [".dayofweek/bin/dcli.cmd"]
      : [".dayofweek/bin/dcli"]
    const launcherOk = runtimeOk && launcherPaths.every((path) => managedFileMatches(root, path, manifest.managedFiles!))
    const skillNames = ["personal-llm-wiki", "dayofweek-brain"]
    const skillPaths = skillNames.flatMap((name) => [
      `.agents/skills/${name}/SKILL.md`,
      `.claude/skills/${name}/SKILL.md`,
    ])
    const skillsOk = skillPaths.every((path) => managedFileMatches(root, path, manifest.managedFiles!))
    let writeOk = false
    try {
      accessSync(root, constants.W_OK)
      writeOk = true
    } catch {
      writeOk = false
    }
    return {
      manifest: {
        name: "project_manifest",
        ok: true,
        detail: `schema=1 dcli=${manifest.dcliVersion ?? "unknown"}`,
      },
      launcher: {
        name: "project_launcher",
        ok: launcherOk,
        detail: runtimeOk ? (launcherOk ? "managed launcher verified" : "launcher modified or missing") : "managed runtime missing",
      },
      skills: {
        name: "project_skills",
        ok: skillsOk,
        detail: skillsOk ? Object.entries(manifest.skillVersions ?? {}).map(([name, version]) => `${name}@${version}`).join(",") : "managed skill modified or missing",
      },
      write: { name: "project_write", ok: writeOk, detail: writeOk ? "folder is writable" : "folder is not writable" },
      defaultAreaId: manifest.defaultAreaId,
    }
  } catch {
    return {
      manifest: { name: "project_manifest", ok: false, detail: "unreadable or malformed" },
      launcher: missing.launcher,
      skills: missing.skills,
      write: missing.write,
    }
  }
}

function managedFileMatches(root: string, relativePath: string, managedFiles: Record<string, string>): boolean {
  const expected = managedFiles[relativePath]
  const target = resolve(root, relativePath)
  const pathFromRoot = relative(root, target)
  const insideRoot = pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !pathFromRoot.startsWith(sep)
  return Boolean(expected && insideRoot && existsSync(target) && sha256(readFileSync(target)) === expected)
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
  .command("list")
  .description("List authenticated named skill bundles")
  .action(async () => output(await getClient().listSkillBundles()))

skill
  .command("bundle <name>")
  .description("Fetch and verify a named skill bundle for a managed installer")
  .action(async (name: string) => output(validateSkillBundle(await getClient().getSkillBundle(name))))

skill
  .command("install [name]")
  .description("Install the agent skill (requires valid auth)")
  .option("--dir <path>", "Custom install directory (overrides --target)")
  .option("--target <target>", "Install target: agents, claude, or all (default: all)")
  .action(async (name: string | undefined, opts) => {
    const client = getClient()
    const bundle = await client.getSkillBundle(name)
    const target = parseTarget(opts.target)
    const dirs = resolveTargetDirs(target, bundle.name, opts.dir)

    const installations = []
    for (const dir of dirs) {
      const result = writeSkillBundle(bundle, dir)
      installations.push({ directory: dir, ...result })
    }
    output({ action: "install", bundle: bundle.name, version: bundle.version, hash: bundle.hash, installations })
  })

skill
  .command("update [name]")
  .description("Update the skill to the latest version")
  .option("--dir <path>", "Custom install directory (overrides --target)")
  .option("--target <target>", "Install target: agents, claude, or all (default: all)")
  .action(async (name: string | undefined, opts) => {
    const client = getClient()
    const bundle = await client.getSkillBundle(name)
    const target = parseTarget(opts.target)
    const dirs = resolveTargetDirs(target, bundle.name, opts.dir)

    const installations = []
    for (const dir of dirs) {
      const result = writeSkillBundle(bundle, dir)
      installations.push({ directory: dir, ...result })
    }
    output({ action: "update", bundle: bundle.name, version: bundle.version, hash: bundle.hash, installations })
  })

skill
  .command("status [name]")
  .description("Check if the skill is installed")
  .option("--dir <path>", "Custom install directory (overrides --target)")
  .option("--target <target>", "Check target: agents, claude, or all (default: all)")
  .action(async (name: string | undefined, opts) => {
    const bundleName = name ?? "dayofweek-platform"
    const target = parseTarget(opts.target)
    const dirs = opts.dir
      ? [opts.dir]
      : target === "all"
        ? [join(homedir(), ".agents", "skills", bundleName), join(homedir(), ".claude", "skills", bundleName)]
        : resolveTargetDirs(target, bundleName)

    const installations: Array<{ installed: boolean; directory: string; name: string; version?: string; sha256?: string }> = []
    for (const dir of dirs) {
      const skillPath = join(dir, "SKILL.md")
      if (!existsSync(skillPath)) {
        installations.push({ installed: false, directory: dir, name: bundleName })
        continue
      }
      const content = readFileSync(skillPath, "utf-8")
      const versionMatch = content.match(/version:\s*"([^"]+)"/)
      installations.push({ installed: true, directory: dir, name: bundleName, version: versionMatch?.[1] ?? "unknown", sha256: sha256(content) })
    }
    const installed = installations.some((entry) => entry.installed)
    output({ installed, bundle: bundleName, installations })
    if (!installed) process.exitCode = 2
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

function inferMimeType(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1)
  const types: Record<string, string> = {
    pdf: "application/pdf",
    md: "text/markdown",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    mp4: "video/mp4",
  }
  const mime = extension ? types[extension] : undefined
  if (!mime) throw new Error("Could not infer MIME type; pass --mime")
  return mime
}

// ── Run ──────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err)
  if (err instanceof ApiError) {
    const code = err.code
    process.exit(
      code === "unauthenticated" ? 2 :
      code === "scope_denied" || code === "not_found" ? 3 :
      code === "conflict" ? 4 :
      code === "quarantined" ? 7 :
      err.status >= 500 ? 6 : 5,
    )
  }
  process.exit(5)
})
