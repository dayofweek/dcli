#!/usr/bin/env node

import { Command } from "commander"
import { ApiError, DayOfWeekClient, toArrayBuffer } from "../client.js"
import { getToken, getApiUrl, saveConfig, loadConfig, saveCredential, deleteCredential } from "../config.js"
import { browserLogin } from "../auth/login.js"
import { parseBrainResource } from "../uri.js"
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs"
import { join, basename, resolve, relative, sep } from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"
import pkg from "../../package.json" with { type: "json" }
import { createHash } from "node:crypto"
import { readInstalledSkill, validateSkillBundle, writeSkillBundle, type SkillBundle, type SkillOrigin } from "../skills.js"
import type { SharedSkillBundle } from "../client.js"

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
  .command("list")
  .description("List an area's sources, newest first (metadata only)")
  .requiredOption("--area <areaId>", "Area to inventory")
  .action(async (opts: { area: string }) => {
    output(await getClient().listBrainSources(opts.area))
  })

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

const brainActors = brain
  .command("actors")
  .description("Work with an area's actors (people and organizations)")

brainActors
  .command("list")
  .description("List an area's actors (active, sorted by name)")
  .requiredOption("--area <areaId>", "Area id (from `brain list`)")
  .action(async (opts: { area: string }) => {
    output(await getClient().listBrainActors(opts.area))
  })

brainActors
  .command("add")
  .description("Add an actor to an area (idempotent on name)")
  .requiredOption("--area <areaId>", "Area id (from `brain list`)")
  .requiredOption("--name <name>", "Actor name (person or organization)")
  .option("--kind <kind>", "person | organization", "organization")
  .option("--role <text>", "Role or relationship in the project")
  .option("--description <text>", "Longer free-text description")
  .action(async (opts: { area: string; name: string; kind: string; role?: string; description?: string }) => {
    if (opts.kind !== "person" && opts.kind !== "organization") {
      throw new Error(`--kind must be "person" or "organization", got "${opts.kind}"`)
    }
    output(await getClient().createBrainActor({
      areaId: opts.area,
      name: opts.name,
      kind: opts.kind,
      role: opts.role,
      description: opts.description,
    }))
  })

brainActors
  .command("matrix")
  .description("The interview matrix: guide questions × active actors")
  .requiredOption("--area <areaId>", "Area id (from `brain list`)")
  .action(async (opts: { area: string }) => {
    output(await getClient().getBrainActorMatrix(opts.area))
  })

brainActors
  .command("extract")
  .description("Trigger the platform's answer extraction (all active actors, or one)")
  .requiredOption("--area <areaId>", "Area id (from `brain list`)")
  .option("--actor <actorId>", "Only this actor")
  .action(async (opts: { area: string; actor?: string }) => {
    output(await getClient().extractBrainActorAnswers({ areaId: opts.area, actorId: opts.actor }))
  })

brainActors
  .command("answer")
  .description("Write one interview-matrix cell directly (marked capturedVia dcli, authoritative)")
  .requiredOption("--actor <actorId>", "Actor id (from `brain actors list`)")
  .requiredOption("--question <questionId>", "Question id (from `brain actors matrix`)")
  .requiredOption("--answer <text>", "The answer; cite the source material in the text")
  .option("--status <status>", "answered | partial | unknown", "answered")
  .action(async (opts: { actor: string; question: string; answer: string; status: string }) => {
    if (!["answered", "partial", "unknown"].includes(opts.status)) {
      throw new Error(`--status must be answered, partial or unknown, got "${opts.status}"`)
    }
    output(await getClient().setBrainActorAnswer({
      actorId: opts.actor,
      questionId: opts.question,
      answer: opts.answer,
      status: opts.status as "answered" | "partial" | "unknown",
    }))
  })

brainActors
  .command("scores")
  .description("Readiness scores: dimensions × active actors with full cells")
  .requiredOption("--area <areaId>", "Area id (from `brain list`)")
  .action(async (opts: { area: string }) => {
    output(await getClient().getBrainActorScores(opts.area))
  })

brainActors
  .command("score")
  .description("Trigger the platform's readiness scoring (all active actors, or one)")
  .requiredOption("--area <areaId>", "Area id (from `brain list`)")
  .option("--actor <actorId>", "Only this actor")
  .action(async (opts: { area: string; actor?: string }) => {
    output(await getClient().scoreBrainActors({ areaId: opts.area, actorId: opts.actor }))
  })

brainActors
  .command("set-score")
  .description("Write one readiness band directly (marked capturedVia dcli, authoritative)")
  .requiredOption("--actor <actorId>", "Actor id (from `brain actors list`)")
  .requiredOption("--dimension <key>", "Dimension key (from `brain actors scores`)")
  .requiredOption("--band <band>", "red | orange | green")
  .requiredOption("--rationale <text>", "Grounds for the band — required")
  .option("--score <number>", "0..1 numeric backing (default derived from band)", parseFloat)
  .option("--gaps <items...>", "Identified gaps")
  .action(async (opts: { actor: string; dimension: string; band: string; rationale: string; score?: number; gaps?: string[] }) => {
    if (!["red", "orange", "green"].includes(opts.band)) {
      throw new Error(`--band must be red, orange or green, got "${opts.band}"`)
    }
    output(await getClient().setBrainActorScore({
      actorId: opts.actor,
      dimensionKey: opts.dimension,
      band: opts.band as "red" | "orange" | "green",
      score: opts.score,
      rationale: opts.rationale,
      gaps: opts.gaps,
    }))
  })

brainSource
  .command("scope <sourceId>")
  .description("Scope a source to an actor (feeds the readiness tables)")
  .option("--actor <actorId>", "Actor id (from `brain actors list`)")
  .option("--clear", "Return the source to area level")
  .action(async (sourceId: string, opts: { actor?: string; clear?: boolean }) => {
    if (Boolean(opts.actor) === Boolean(opts.clear)) {
      throw new Error("Pass exactly one of --actor <actorId> or --clear")
    }
    output(await getClient().scopeBrainSource(sourceId, opts.actor ?? null))
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
  .option("--org <org>", "Organization slug or id (admin only)")
  .action(async (opts) => {
    const client = getClient()
    const result = await client.listEntities(opts)
    output(result)
  })

read
  .command("entity <entityId>")
  .description("Get entity details")
  .option("--org <org>", "Organization slug or id (admin only)")
  .action(async (entityId: string, opts) => {
    const client = getClient()
    const result = await client.getEntity(entityId, opts.org)
    output(result)
  })

read
  .command("produce")
  .description("List produce profiles")
  .option("--entity <entityId>", "Filter by entity")
  .option("--limit <count>", "Max results", parseInt)
  .option("--org <org>", "Organization slug or id (admin only)")
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
  .option("--org <org>", "Organization slug or id (admin only)")
  .action(async (opts) => {
    const client = getClient()
    const result = await client.listContacts(opts)
    output(result)
  })

read
  .command("entity-types")
  .description("List available entity types")
  .option("--org <org>", "Organization slug or id (admin only)")
  .action(async (opts) => {
    const client = getClient()
    const result = await client.listEntityTypes(opts.org)
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
  .option("--org <org>", "Organization slug or id (admin only)")
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
  .option("--org <slug>", "File against another org (admin tokens only)")
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
      org: opts.org,
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
  .option("--org <slug>", "File against another org (admin tokens only)")
  .requiredOption("--file <path>", "JSON file with proposals array (- for stdin)")
  .action(async (opts) => {
    const content = opts.file === "-"
      ? await readStdin()
      : readFileSync(opts.file, "utf-8")
    const proposals = JSON.parse(content)

    const client = getClient()
    const result = await client.submitBatch({
      org: opts.org,
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

// ── Knowledge Commands ───────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

function guessMimeType(path: string): string {
  const dot = path.lastIndexOf(".")
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase()
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

/** Filesystem-safe name for an exported document, keeping it recognisable. */
function exportFileName(doc: { id?: string; title?: string; fileName?: string }): string {
  const base = (doc.fileName || doc.title || doc.id || "document").trim()
  const stripped = base.replace(/\.(md|txt)$/i, "")
  const safe = stripped.replace(/[/\\:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 120)
  return `${safe || doc.id || "document"}.md`
}

const knowledge = program
  .command("knowledge")
  .description("Read, add and export entity knowledge documents")

knowledge
  .command("list")
  .description("List knowledge documents on an entity")
  .requiredOption("--entity <entityId>", "Target entity id")
  .option("--full", "Include each document's full content, not an excerpt")
  .option("--org <org>", "Organization (admin only)")
  .action(async (opts) => {
    const client = getClient()
    output(await client.listKnowledge({ entity: opts.entity, full: opts.full, org: opts.org }))
  })

knowledge
  .command("get <documentId>")
  .description("Show one knowledge document with full content")
  .option("--org <org>", "Organization (admin only)")
  .action(async (documentId: string, opts) => {
    const client = getClient()
    output(await client.getKnowledge(documentId, opts.org))
  })

knowledge
  .command("search <query>")
  .description("Semantic search across knowledge documents")
  .option("--entity <entityId>", "Scope to one entity's org tree")
  .option("--types <types>", "Comma-separated sourceType filter")
  .option("--limit <count>", "Max hits", parseInt)
  .option("--all-orgs", "Search every org (admin only)")
  .option("--org <org>", "Organization (admin only)")
  .action(async (query: string, opts) => {
    const client = getClient()
    output(
      await client.searchKnowledge({
        query,
        entity: opts.entity,
        types: opts.types
          ? String(opts.types).split(",").map((t: string) => t.trim()).filter(Boolean)
          : undefined,
        limit: opts.limit,
        allOrgs: opts.allOrgs,
        org: opts.org,
      }),
    )
  })

knowledge
  .command("add")
  .description("Add a markdown knowledge note (proposal by default)")
  .requiredOption("--entity <entityId>", "Target entity id")
  .requiredOption("--title <title>", "Document title")
  .option("--file <path>", "Markdown file to read (- for stdin)")
  .option("--content <text>", "Inline content instead of --file")
  .option("--source-type <type>", "research | website | competitive_intel | …", "research")
  .option("--source-url <url>", "Where the content came from")
  .option("--source-description <text>", "Short provenance note")
  .option("--confidence <n>", "0-1, helps reviewers prioritize", parseFloat)
  .option("--source-agent <name>", "Attribution for the submitting agent")
  .option(
    "--direct",
    "Write immediately instead of proposing. Admin only — ask the operator first",
  )
  .option("--org <org>", "Organization (admin only)")
  .action(async (opts) => {
    let content: string
    if (opts.content) {
      content = String(opts.content)
    } else if (opts.file) {
      content = opts.file === "-" ? readFileSync(0, "utf8") : readFileSync(opts.file, "utf8")
    } else {
      throw new Error("Provide --file or --content")
    }
    if (!content.trim()) throw new Error("Content is empty")

    const client = getClient()
    output(
      await client.addKnowledge({
        entityId: opts.entity,
        title: opts.title,
        content,
        sourceType: opts.sourceType,
        sourceUrl: opts.sourceUrl,
        sourceDescription: opts.sourceDescription,
        confidence: opts.confidence,
        sourceAgent: opts.sourceAgent,
        direct: Boolean(opts.direct),
        org: opts.org,
      }),
    )
  })

knowledge
  .command("attach")
  .description("Attach a file (PDF, DOCX, XLSX …) as a source. Admin only")
  .requiredOption("--entity <entityId>", "Target entity id")
  .requiredOption("--file <path>", "File to upload")
  .option("--name <fileName>", "Stored file name (defaults to the file's own)")
  .option("--mime <mimeType>", "Content type (guessed from the extension)")
  .option("--source-type <type>", "research | website | contract | …", "other")
  .option("--source-url <url>", "Where the file came from")
  .option("--source-description <text>", "Short provenance note")
  .option("--org <org>", "Organization (admin only)")
  .action(async (opts) => {
    if (!existsSync(opts.file)) throw new Error(`File not found: ${opts.file}`)
    const data = readFileSync(opts.file)
    if (data.byteLength === 0) throw new Error("File is empty")

    const client = getClient()
    output(
      await client.attachKnowledgeFile({
        entityId: opts.entity,
        data: toArrayBuffer(data),
        fileName: opts.name ?? basename(opts.file),
        mimeType: opts.mime ?? guessMimeType(opts.file),
        sourceType: opts.sourceType,
        sourceUrl: opts.sourceUrl,
        sourceDescription: opts.sourceDescription,
        org: opts.org,
      }),
    )
  })

knowledge
  .command("export")
  .description("Write an entity's knowledge documents to disk as markdown")
  .requiredOption("--entity <entityId>", "Source entity id")
  .requiredOption("--out <dir>", "Directory to write into (created if missing)")
  .option("--org <org>", "Organization (admin only)")
  .action(async (opts) => {
    const client = getClient()
    const docs = await client.listKnowledge({ entity: opts.entity, full: true, org: opts.org })

    mkdirSync(opts.out, { recursive: true })

    const written: Array<{ id: string; file: string; bytes: number }> = []
    const skipped: Array<{ id: string; title?: string; reason: string }> = []

    for (const doc of docs) {
      const body = typeof doc.content === "string" ? doc.content : ""
      if (!body) {
        // A binary source whose text extraction hasn't finished has nothing to
        // mirror yet. Report it rather than writing an empty file.
        skipped.push({
          id: doc.id,
          title: doc.title,
          reason:
            doc.processingStatus && doc.processingStatus !== "completed"
              ? `processingStatus=${doc.processingStatus}`
              : "no extracted content",
        })
        continue
      }

      const frontMatter = [
        "---",
        `document_id: ${doc.id}`,
        `title: ${JSON.stringify(doc.title ?? "")}`,
        `source_type: ${doc.sourceType ?? "other"}`,
        ...(doc.sourceUrl ? [`source_url: ${doc.sourceUrl}`] : []),
        ...(doc.sourceDescription
          ? [`source_description: ${JSON.stringify(doc.sourceDescription)}`]
          : []),
        `entity_id: ${opts.entity}`,
        ...(doc.createdAt ? [`created_at: ${new Date(doc.createdAt).toISOString()}`] : []),
        "exported_from: dayofweek-platform",
        "---",
        "",
      ].join("\n")

      const target = join(opts.out, exportFileName(doc))
      writeFileSync(target, `${frontMatter}${body}\n`, "utf8")
      written.push({ id: doc.id, file: target, bytes: Buffer.byteLength(body, "utf8") })
    }

    output({ entity: opts.entity, out: opts.out, total: docs.length, written, skipped })
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

// A skill install/update can come from two origins: a named bundle served by
// the platform, or a skill another user published into a shared knowledge
// area ("shared"). Shared skills are addressed by a skill URI
// (dayofweek://brain/<areaId>/skill/<skillId>) or by name together with
// --area. The origin is recorded in `.dayofweek-skill.json` so updates and
// `status --check` go back to the same place.
type ResolvedSkillBundle = { bundle: SkillBundle; origin: SkillOrigin }

function sharedToBundle(shared: SharedSkillBundle): ResolvedSkillBundle {
  return {
    bundle: { name: shared.name, version: shared.version, hash: shared.hash, files: shared.files },
    origin: { source: "shared", skillId: shared.id, areaId: shared.areaId, uri: shared.uri },
  }
}

async function fetchSkillByOrigin(
  client: ReturnType<typeof getClient>,
  nameOrUri: string | undefined,
  areaId: string | undefined,
): Promise<ResolvedSkillBundle> {
  if (nameOrUri?.includes("://")) {
    const resource = parseBrainResource(nameOrUri)
    if (resource.resourceType !== "skill" || !resource.resourceId) throw new Error("A shared skill URI is required")
    const shared = await client.getSharedSkill(resource.resourceId)
    if (shared.areaId !== resource.areaId) throw new Error("Server returned a mismatched area")
    return sharedToBundle(shared)
  }
  if (areaId) {
    if (!nameOrUri) throw new Error("A skill name is required together with --area")
    const match = (await client.listSharedSkills()).find(
      (candidate) => candidate.areaId === areaId && candidate.name === nameOrUri,
    )
    if (!match) throw new Error("Shared skill not found in that area")
    return sharedToBundle(await client.getSharedSkill(match.id))
  }
  return { bundle: await client.getSkillBundle(nameOrUri), origin: { source: "platform" } }
}

async function installOrUpdateSkill(
  action: "install" | "update",
  name: string | undefined,
  opts: { dir?: string; target?: string; area?: string },
): Promise<void> {
  const client = getClient()
  let resolved: ResolvedSkillBundle | undefined
  if (action === "update" && !name && !opts.area && opts.dir) {
    // Bare `skill update --dir …`: go back to wherever this install came from.
    const installed = readInstalledSkill(opts.dir)
    if (installed) {
      resolved = installed.origin?.source === "shared"
        ? sharedToBundle(await client.getSharedSkill(installed.origin.skillId))
        : { bundle: await client.getSkillBundle(installed.name), origin: { source: "platform" } }
    }
  }
  resolved = resolved ?? await fetchSkillByOrigin(client, name, opts.area)
  const bundle = validateSkillBundle(resolved.bundle)
  const dirs = resolveTargetDirs(parseTarget(opts.target), bundle.name, opts.dir)

  const installations = []
  for (const dir of dirs) {
    const result = writeSkillBundle(bundle, dir, resolved.origin)
    installations.push({ directory: dir, ...result })
  }
  output({
    action,
    bundle: bundle.name,
    version: bundle.version,
    hash: bundle.hash,
    origin: resolved.origin.source,
    ...(resolved.origin.source === "shared" ? { uri: resolved.origin.uri } : {}),
    installations,
  })
}

/** Read a skill directory into bundle files: relative paths, utf-8 content. */
function collectSkillFiles(dir: string): Array<{ path: string; content: string }> {
  const root = resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("Skill directory not found")
  const files: Array<{ path: string; content: string }> = []
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      // Hidden entries (including the .dayofweek-skill.json install manifest)
      // and update-conflict artifacts never belong in a published bundle.
      if (entry.name.startsWith(".") || /\.new(\.\d+)?$/.test(entry.name)) continue
      if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in a skill directory")
      const full = join(current, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, relativePath)
      else if (entry.isFile()) files.push({ path: relativePath, content: readFileSync(full, "utf8") })
    }
  }
  walk(root, "")
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

skill
  .command("list")
  .description("List installable named skill bundles; --shared adds skills shared with you")
  .option("--shared", "Include skills other users shared with you")
  .action(async (opts: { shared?: boolean }) => {
    const client = getClient()
    type SkillListing = {
      name: string
      version: string
      hash: string
      source: "platform" | "shared"
      areaId?: string
      areaName?: string
      visibility?: "area" | "company" | "global"
      description?: string
      uri?: string
      updatedAt?: number
    }
    // The bare listing stays exactly the named bundles: managed installers
    // iterate it and fetch every entry by plain name, so shared skills (which
    // resolve by URI) only appear when explicitly asked for.
    const listings: SkillListing[] = (await client.listSkillBundles()).map((bundle) => ({
      ...bundle,
      source: "platform" as const,
    }))
    if (opts.shared) {
      try {
        for (const shared of await client.listSharedSkills()) {
          listings.push({
            name: shared.name,
            version: shared.version,
            hash: shared.hash,
            source: "shared",
            areaId: shared.areaId,
            areaName: shared.areaName,
            visibility: shared.visibility,
            description: shared.description,
            uri: shared.uri,
            updatedAt: shared.updatedAt,
          })
        }
      } catch (error) {
        // Older servers or tokens without knowledge scopes have no shared-skill
        // surface — the named bundles are still worth listing.
        console.error(`Shared skills unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    output(listings.sort((left, right) => left.name.localeCompare(right.name)))
  })

skill
  .command("bundle <nameOrUri>")
  .description("Fetch and verify a skill bundle (by name, or shared-skill URI) for a managed installer")
  .action(async (nameOrUri: string) => {
    if (nameOrUri.includes("://")) {
      const resource = parseBrainResource(nameOrUri)
      if (resource.resourceType !== "skill" || !resource.resourceId) throw new Error("A shared skill URI is required")
      const shared = await getClient().getSharedSkill(resource.resourceId)
      if (shared.areaId !== resource.areaId) throw new Error("Server returned a mismatched area")
      // Emit the plain bundle shape managed installers expect.
      output(validateSkillBundle({ name: shared.name, version: shared.version, hash: shared.hash, files: shared.files }))
      return
    }
    output(validateSkillBundle(await getClient().getSkillBundle(nameOrUri)))
  })

skill
  .command("install [name]")
  .description("Install a skill by bundle name, shared-skill URI, or name + --area")
  .option("--dir <path>", "Custom install directory (overrides --target)")
  .option("--target <target>", "Install target: agents, claude, or all (default: all)")
  .option("--area <areaId>", "Install a shared skill from this area")
  .action(async (name: string | undefined, opts) => installOrUpdateSkill("install", name, opts))

skill
  .command("update [name]")
  .description("Update a skill to the latest version from its origin")
  .option("--dir <path>", "Custom install directory (overrides --target)")
  .option("--target <target>", "Install target: agents, claude, or all (default: all)")
  .option("--area <areaId>", "Update a shared skill from this area")
  .action(async (name: string | undefined, opts) => installOrUpdateSkill("update", name, opts))

skill
  .command("publish")
  .description("Share a skill directory to a knowledge area so teammates can install it")
  .requiredOption("--area <areaId>", "Owning area (see: dcli brain list)")
  .requiredOption("--dir <path>", "Skill directory containing SKILL.md")
  .option("--name <name>", "Skill name (default: SKILL.md frontmatter, else the directory name)")
  .option("--skill-version <version>", "Version string (default: SKILL.md frontmatter version)")
  .option("--visibility <visibility>", "Who can discover it: area (members only), company, or global (admins; every user)")
  .option("--description <text>", "Short description shown in listings")
  .action(async (opts: { area: string; dir: string; name?: string; skillVersion?: string; visibility?: string; description?: string }) => {
    const visibility = (opts.visibility ?? "area").toLowerCase()
    if (visibility !== "area" && visibility !== "company" && visibility !== "global") {
      throw new Error("Invalid --visibility: use area, company, or global")
    }
    const files = collectSkillFiles(opts.dir)
    const skillMd = files.find((file) => file.path === "SKILL.md")
    if (!skillMd) throw new Error("The skill directory must contain SKILL.md")
    const name = opts.name
      ?? skillMd.content.match(/^name:\s*"?([a-z0-9][a-z0-9-]*)"?\s*$/m)?.[1]
      ?? basename(resolve(opts.dir))
    const version = opts.skillVersion ?? skillMd.content.match(/version:\s*"([^"]+)"/)?.[1] ?? "1.0.0"
    validateSkillBundle({ name, version, files })
    const result = await getClient().publishSharedSkill({
      areaId: opts.area,
      name,
      version,
      description: opts.description,
      visibility,
      files,
    })
    output({ action: "publish", ...result })
  })

skill
  .command("archive <uri>")
  .description("Archive a shared skill you own (removes it from listing and install)")
  .action(async (uri: string) => {
    const resource = parseBrainResource(uri)
    if (resource.resourceType !== "skill" || !resource.resourceId) throw new Error("A shared skill URI is required")
    const result = await getClient().archiveSharedSkill(resource.resourceId)
    if (result.areaId !== resource.areaId) throw new Error("Server returned a mismatched area")
    output({ action: "archive", ...result })
  })

skill
  .command("status [name]")
  .description("Check if the skill is installed; --check compares against its origin")
  .option("--dir <path>", "Custom install directory (overrides --target)")
  .option("--target <target>", "Check target: agents, claude, or all (default: all)")
  .option("--check", "Also ask the server whether a newer version exists")
  .action(async (name: string | undefined, opts) => {
    const bundleName = name ?? "dayofweek-platform"
    const target = parseTarget(opts.target)
    const dirs = opts.dir
      ? [opts.dir]
      : target === "all"
        ? [join(homedir(), ".agents", "skills", bundleName), join(homedir(), ".claude", "skills", bundleName)]
        : resolveTargetDirs(target, bundleName)

    let platformBundles: Array<{ name: string; version: string; hash: string }> | undefined
    const installations: Array<Record<string, unknown>> = []
    for (const dir of dirs) {
      const skillPath = join(dir, "SKILL.md")
      if (!existsSync(skillPath)) {
        installations.push({ installed: false, directory: dir, name: bundleName })
        continue
      }
      const metadata = readInstalledSkill(dir)
      const content = readFileSync(skillPath, "utf-8")
      const versionMatch = content.match(/version:\s*"([^"]+)"/)
      const entry: Record<string, unknown> = {
        installed: true,
        directory: dir,
        name: metadata?.name ?? bundleName,
        version: metadata?.version ?? versionMatch?.[1] ?? "unknown",
        sha256: sha256(content),
        origin: metadata?.origin?.source ?? "platform",
      }
      if (opts.check) {
        try {
          if (metadata?.origin?.source === "shared") {
            const latest = await getClient().getSharedSkill(metadata.origin.skillId)
            entry.latestVersion = latest.version
            entry.upToDate = metadata.hash === latest.hash
          } else {
            platformBundles ??= await getClient().listSkillBundles()
            const latest = platformBundles.find((candidate) => candidate.name === entry.name)
            if (latest) {
              entry.latestVersion = latest.version
              // Pre-origin installs have no recorded manifest hash; fall back
              // to comparing the declared versions.
              entry.upToDate = metadata ? metadata.hash === latest.hash : latest.version === entry.version
            }
          }
        } catch (error) {
          entry.checkError = error instanceof Error ? error.message : String(error)
        }
      }
      installations.push(entry)
    }
    const installed = installations.some((entry) => entry.installed)
    output({ installed, bundle: bundleName, installations })
    if (!installed) process.exitCode = 2
  })

// ── Data Commands ────────────────────────────────────────────────────────────
//
// Generic, name-blind reads of platform datasets. The server's catalog decides
// what exists and what the caller may see — this CLI ships no dataset names,
// so new platform surfaces appear in `data list` without a CLI release.

const data = program.command("data").description("Read platform datasets the server offers you")

data
  .command("list")
  .description("List the datasets your credential may read")
  .option("--org <org>", "Organization slug or id (admin only)")
  .action(async (opts) => {
    const client = getClient()
    output(await client.listDatasets(opts.org))
  })

data
  .command("get <dataset>")
  .description("Read one dataset's rows (names come from `data list`)")
  .option("--limit <count>", "Max rows (default 50, max 200)", parseInt)
  .option("--org <org>", "Organization slug or id (admin only)")
  .action(async (dataset: string, opts) => {
    const client = getClient()
    output(await client.readDataset(dataset, { limit: opts.limit, org: opts.org }))
  })

// ── Feedback Commands ────────────────────────────────────────────────────────
//
// The customer feedback backlog. Scope-gated rather than admin-gated:
// read:feedback for the reads, write:feedback to comment, admin:feedback for
// claim/status/priority. backOffice users implicitly hold every scope, so the
// group stays visible and the endpoint decides what the caller may do.

const feedback = program
  .command("feedback")
  .description("Read and work the customer feedback backlog")

feedback
  .command("list")
  .description("List backlog items")
  .option("--status <status>", "backlog | planned | in_progress | shipped | rejected | new")
  .option("--priority <priority>", "urgent | high | medium | low")
  .option("--category <category>", "Filter by category, e.g. studio")
  .option("--limit <count>", "Max results", parseInt)
  .action(async (opts) => {
    const client = getClient()
    output(await client.listFeedback({
      status: opts.status,
      priority: opts.priority,
      category: opts.category,
      limit: opts.limit,
    }))
  })

feedback
  .command("next")
  .description("What should I work on next — the prioritizer's top picks")
  .option("--limit <count>", "How many recommendations", parseInt)
  .action(async (opts) => {
    const client = getClient()
    output(await client.feedbackRecommendations(opts.limit))
  })

feedback
  .command("show <itemId>")
  .description("Show one backlog item in full")
  .action(async (itemId: string) => {
    const client = getClient()
    output(await client.getFeedbackItem(itemId))
  })

feedback
  .command("claim <itemId>")
  .description("Claim an item so humans see it is being worked on")
  .action(async (itemId: string) => {
    const client = getClient()
    output(await client.claimFeedbackItem(itemId))
  })

feedback
  .command("comment <itemId>")
  .description("Add a comment to a backlog item")
  .option("--body <text>", "Comment text")
  .option("--file <path>", "Read the comment from a file (- for stdin)")
  .action(async (itemId: string, opts) => {
    let body: string
    if (opts.body) {
      body = String(opts.body)
    } else if (opts.file) {
      body = opts.file === "-" ? readFileSync(0, "utf8") : readFileSync(opts.file, "utf8")
    } else {
      throw new Error("Provide --body or --file")
    }
    if (!body.trim()) throw new Error("Comment is empty")
    const client = getClient()
    output(await client.commentOnFeedbackItem(itemId, body))
  })

feedback
  .command("status <itemId>")
  .description("Set status and/or priority on a backlog item")
  .option("--status <status>", "backlog | planned | in_progress | shipped | rejected")
  .option("--priority <priority>", "urgent | high | medium | low")
  .option("--rejected-reason <text>", "Why it was rejected (with --status rejected)")
  .action(async (itemId: string, opts) => {
    if (!opts.status && !opts.priority) {
      throw new Error("Provide --status and/or --priority")
    }
    const client = getClient()
    output(await client.updateFeedbackItem(itemId, {
      status: opts.status,
      priority: opts.priority,
      rejectedReason: opts.rejectedReason,
    }))
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

  // ── Assortment import ──────────────────────────────────────────────────────
  //
  // These write real Creator rows rather than proposals, so the operator
  // approves the parsed result first. --dry-run rehearses the whole import
  // server-side and rolls it back; that response is what the review is built
  // from. Writing requires --approved for the same reason email does.

  const produce = program
    .command("produce", { hidden: true })
    .description("Assortment import and recipe refinement (DoW staff)")

  produce
    .command("import")
    .description("Import a producer's items into Creator. Requires --dry-run or --approved")
    .requiredOption("--file <path>", "JSON payload: { entityId, items[] } (- for stdin)")
    .option("--dry-run", "Rehearse server-side and roll back — build the review from this")
    .option("--skip-existing-names", "Skip items whose displayName already exists")
    .option("--approved", "The operator approved the dry-run result")
    .option("--org <org>", "Organization slug or id")
    .action(async (opts) => {
      if (!opts.dryRun && !opts.approved) {
        throw new Error(
          "Refusing to write: run with --dry-run first, show the operator the result, " +
          "then repeat with --approved. This creates real Creator rows, not proposals.",
        )
      }
      const raw = opts.file === "-" ? readFileSync(0, "utf8") : readFileSync(opts.file, "utf8")
      const payload = JSON.parse(raw)
      if (!payload?.entityId || !Array.isArray(payload.items)) {
        throw new Error("Payload needs { entityId, items: [...] }")
      }
      const client = getClient()
      output(await client.importProduce({
        entityId: payload.entityId,
        items: payload.items,
        dryRun: Boolean(opts.dryRun),
        skipExistingNames: opts.skipExistingNames ?? payload.skipExistingNames,
        org: opts.org ?? payload.org,
      }))
    })

  produce
    .command("add-concepts")
    .description("Add concepts to the shared produce catalog. Requires --approved")
    .requiredOption("--file <path>", "JSON: { concepts: [...] } or a bare array (- for stdin)")
    .option("--approved", "The operator approved these concepts")
    .option("--org <org>", "Organization slug or id")
    .action(async (opts) => {
      if (!opts.approved) {
        throw new Error(
          "Refusing to write: the produce catalog is shared by every customer. " +
          "Show the operator the concepts you want to add, then repeat with --approved.",
        )
      }
      const raw = opts.file === "-" ? readFileSync(0, "utf8") : readFileSync(opts.file, "utf8")
      const parsed = JSON.parse(raw)
      const concepts = Array.isArray(parsed) ? parsed : parsed?.concepts
      if (!Array.isArray(concepts) || concepts.length === 0) {
        throw new Error("Payload needs a non-empty `concepts` array")
      }
      const client = getClient()
      output(await client.createCatalogConcepts({ concepts, org: opts.org ?? parsed?.org }))
    })

  produce
    .command("ingredients")
    .description("Recipe ingredients still standing in for something vaguer")
    .requiredOption("--entity <entityId>", "Producer entity")
    .option("--org <org>", "Organization slug or id")
    .action(async (opts) => {
      const client = getClient()
      output(await client.listImpreciseIngredients(opts.entity, opts.org))
    })

  produce
    .command("refine")
    .description("Point an imprecise ingredient at what it actually is")
    .requiredOption("--process-input <id>", "processInputId from `produce ingredients`")
    .option("--concept <catalogConceptId>", "What it actually is")
    .option("--material <materialId>", "Material node instead of a catalog concept")
    .option("--role <role>", "e.g. seasoning, base")
    .option("--qty <n>", "Quantity", parseFloat)
    .option("--unit <unitCode>", "Unit code")
    .option("--still-imprecise", "Narrowed but not resolved — keeps it on the worklist")
    .option("--org <org>", "Organization slug or id")
    .action(async (opts) => {
      if (!opts.concept && !opts.material) {
        throw new Error("Provide --concept or --material")
      }
      const client = getClient()
      output(await client.refineIngredient({
        processInputId: opts.processInput,
        catalogConceptId: opts.concept,
        materialId: opts.material,
        role: opts.role,
        qty: opts.qty,
        unitCode: opts.unit,
        stillImprecise: Boolean(opts.stillImprecise),
        org: opts.org,
      }))
    })

  admin
    .command("customers-only")
    .description("Entities with a customer role and no investor/partner/producer role")
    .action(async () => {
      const client = getClient()
      output(await client.adminCustomersOnly())
    })

  admin
    .command("press-inbox")
    .description("Tips mailed to press@mail.dayofweek.com (Press Radar)")
    .option("--since <date>", "ISO date or epoch ms (default 45 days back)")
    .option("--limit <count>", "Max emails (max 200)", parseInt)
    .action(async (opts) => {
      const client = getClient()
      output(await client.adminPressInbox({ since: opts.since, limit: opts.limit }))
    })

  // ── Customer emails ────────────────────────────────────────────────────────
  //
  // Mail sent to a customer's own inbox address (<slug>@mail.dayofweek.com)
  // becomes a thread the agent can answer. Reading is free; sending is not:
  // `reply` and `compose` refuse to run without --approved, so an agent cannot
  // mail a customer as a side effect of "check the inbox". The human approves
  // the exact text first — that rule lives in the skill; --approved is the
  // mechanical backstop for it.

  const emails = program
    .command("emails", { hidden: true })
    .description("Customer email threads — read, reply, compose (DoW staff)")

  const APPROVAL_REQUIRED =
    "Refusing to send: pass --approved once the human has approved this exact text. " +
    "Never send an email the human has not seen."

  emails
    .command("list")
    .description("List customer email threads")
    .option("--status <status>", "needs_reply | manual_review | all (default all)")
    .option("--since <date>", "ISO date (2026-07-01) or epoch ms; default 30 days back")
    .option("--customer <entityId>", "One customer only")
    .option("--limit <count>", "Max threads (default 50, max 200)", parseInt)
    .option("--org <org>", "Organization slug or id")
    .action(async (opts) => {
      const client = getClient()
      output(await client.listEmailThreads({
        status: opts.status,
        since: opts.since,
        customer: opts.customer,
        limit: opts.limit,
        org: opts.org,
      }))
    })

  emails
    .command("show <threadKey>")
    .description("Full thread: messages, attachments, and reply hints")
    .action(async (threadKey: string) => {
      const client = getClient()
      output(await client.getEmailThread(threadKey))
    })

  emails
    .command("reply <threadKey>")
    .description("Reply in a thread. Requires --approved")
    .option("--message <text>", "Plain-text reply body")
    .option("--file <path>", "Read the body from a file (- for stdin)")
    .option("--subject <text>", "Override the subject (defaults to Re: …)")
    .option("--to <address>", "Override the recipient")
    .option("--cc <addresses>", "Comma-separated cc list")
    .option("--no-quote", "Do not quote the original underneath")
    .option("--approved", "The human approved this exact text")
    .action(async (threadKey: string, opts) => {
      if (!opts.approved) throw new Error(APPROVAL_REQUIRED)
      let message: string
      if (opts.message) {
        message = String(opts.message)
      } else if (opts.file) {
        message = opts.file === "-" ? readFileSync(0, "utf8") : readFileSync(opts.file, "utf8")
      } else {
        throw new Error("Provide --message or --file")
      }
      if (!message.trim()) throw new Error("Message is empty")
      const client = getClient()
      output(await client.replyToEmailThread(threadKey, {
        message,
        subject: opts.subject,
        to: opts.to,
        cc: splitList(opts.cc),
        quote: opts.quote,
      }))
    })

  emails
    .command("compose")
    .description("Start a new thread from a customer inbox. Requires --approved")
    .option("--entity <entityId>", "Customer entity whose inbox sends the mail")
    .option("--inbox <address>", "Inbox address instead of --entity")
    .requiredOption("--to <address>", "Recipient")
    .option("--cc <addresses>", "Comma-separated cc list")
    .requiredOption("--subject <text>", "Subject line")
    .option("--message <text>", "Plain-text body")
    .option("--file <path>", "Read the body from a file (- for stdin)")
    .option("--approved", "The human approved this exact text")
    .action(async (opts) => {
      if (!opts.approved) throw new Error(APPROVAL_REQUIRED)
      if (!opts.entity && !opts.inbox) throw new Error("Provide --entity or --inbox")
      let message: string
      if (opts.message) {
        message = String(opts.message)
      } else if (opts.file) {
        message = opts.file === "-" ? readFileSync(0, "utf8") : readFileSync(opts.file, "utf8")
      } else {
        throw new Error("Provide --message or --file")
      }
      if (!message.trim()) throw new Error("Message is empty")
      const client = getClient()
      output(await client.composeEmail({
        entityId: opts.entity,
        inbox: opts.inbox,
        to: opts.to,
        cc: splitList(opts.cc),
        subject: opts.subject,
        message,
      }))
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

/** Parse a comma-separated CLI option into a trimmed list, or undefined. */
function splitList(value?: string): string[] | undefined {
  if (!value) return undefined
  const items = String(value).split(",").map((entry) => entry.trim()).filter(Boolean)
  return items.length ? items : undefined
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
