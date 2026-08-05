/**
 * HTTP client for the Day of Week platform REST API.
 * All calls go through the proxy at field.dayofweek.com/app/api/dcli.
 */

import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream, existsSync, fsyncSync, linkSync, openSync, closeSync, renameSync, statSync, unlinkSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

const DEFAULT_BASE_URL = "https://field.dayofweek.com/app/api/dcli"

/**
 * Node's Buffer is a Uint8Array view over a possibly-larger, possibly-shared
 * backing store, which is not assignable to BodyInit. Copy out the exact bytes.
 */
export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength)
  new Uint8Array(out).set(view)
  return out
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public requestId?: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export class DayOfWeekClient {
  private baseUrl: string
  private token: string

  constructor(token: string, baseUrl?: string) {
    this.token = token
    this.baseUrl = baseUrl ?? process.env.DCLI_API_URL ?? DEFAULT_BASE_URL
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async checkAuth(): Promise<{ status: string; authenticated: boolean; isAdmin?: boolean }> {
    return this.get("/auth/status")
  }

  async listDevices(): Promise<Array<{ _id: string; name: string; secretPreview: string; lastUsedAt: number; createdAt: number }>> {
    return this.get("/auth/devices")
  }

  async createDevice(name: string): Promise<{ secret: string }> {
    return this.post("/auth/devices", { name })
  }

  async revokeDevice(deviceId: string): Promise<{ success: boolean }> {
    return this.delete(`/auth/devices/${deviceId}`)
  }

  async revokeCurrentDevice(): Promise<{ revoked: true }> {
    return this.delete("/auth/current-device")
  }

  // ── Shared brain ─────────────────────────────────────────────────────────

  async brainBootstrap(): Promise<{
    authenticated: true
    scopes: string[]
    entitled: boolean
    areas: BrainArea[]
    defaultAreaId?: string
  }> {
    return this.get("/brain/bootstrap")
  }

  async listBrainAreas(): Promise<BrainArea[]> {
    return this.get("/brain/areas")
  }

  async companyBrainStatus(): Promise<{
    eligible: boolean
    canEnsure: boolean
    entityName?: string
    existingArea: BrainArea | null
  }> {
    return this.get("/brain/company-area")
  }

  async ensureCompanyBrain(): Promise<BrainArea> {
    return this.post("/brain/company-area", {})
  }

  async resolveBrain(uri: string): Promise<BrainResolvedResource> {
    return this.get(`/brain/resolve?uri=${encodeURIComponent(uri)}`)
  }

  async getBrainNote(id: string): Promise<BrainNote> {
    return this.get(`/brain/notes/${encodeURIComponent(id)}`)
  }

  async getBrainSource(id: string): Promise<BrainSource> {
    return this.get(`/brain/sources/${encodeURIComponent(id)}`)
  }

  async uploadBrainSource(input: {
    areaId: string
    path: string
    mimeType: string
    isMeeting: boolean
    consentAcknowledged: boolean
  }): Promise<{
    sourceId: string
    uri: string
    httpsUrl: string
    filename: string
    byteSize: number
    sha256: string
    scanState: "pending" | "clean"
    processingState: string
  }> {
    const info = statSync(input.path)
    if (!info.isFile()) throw new Error("Upload path is not a regular file")
    const sha256 = await hashFile(input.path)
    const idempotencyKey = `up_${createHash("sha256")
      .update(`${input.areaId}:${sha256}:${input.isMeeting}`)
      .digest("base64url")}`
    const session = await this.post("/brain/source-uploads", {
      areaId: input.areaId,
      filename: basename(input.path),
      mimeType: input.mimeType,
      byteSize: info.size,
      sha256,
      isMeeting: input.isMeeting,
      consentAcknowledged: input.consentAcknowledged,
      idempotencyKey,
    }) as { uploadId: string; uploadUrl: string }
    const upload = await fetch(session.uploadUrl, {
      method: "POST",
      headers: { "Content-Type": input.mimeType },
      body: createReadStream(input.path) as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" })
    if (!upload.ok) throw new ApiError(upload.status, "Source byte upload failed", "network_error")
    const stored = await upload.json() as { storageId?: string }
    if (!stored.storageId) throw new Error("Upload did not return a storage ID")
    const completed = await this.post(`/brain/source-uploads/${encodeURIComponent(session.uploadId)}/complete`, {
      storageId: stored.storageId,
    }) as {
      sourceId: string
      uri: string
      httpsUrl: string
      filename: string
      byteSize: number
      sha256: string
      scanState: "pending" | "clean"
      processingState: string
    }
    if (completed.sha256 !== sha256) throw new Error("Server checksum does not match the uploaded file")
    return completed
  }

  async downloadBrainSource(input: {
    sourceId: string
    outputPath: string
    expectedSha256?: string
    overwrite?: boolean
  }): Promise<{ outputPath: string; byteSize: number; sha256: string }> {
    if (!input.overwrite && existsSync(input.outputPath)) throw new Error("Output already exists; use --overwrite")
    const response = await fetch(`${this.baseUrl}/brain/sources/${encodeURIComponent(input.sourceId)}/download`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!response.ok) throw await apiErrorFromResponse(response)
    if (!response.body) throw new Error("Download response had no body")
    const expected = response.headers.get("x-dayofweek-sha256") ?? input.expectedSha256
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Download response omitted its checksum")
    const tempPath = join(dirname(input.outputPath), `.${basename(input.outputPath)}.dcli-${randomUUID()}.tmp`)
    const hash = createHash("sha256")
    let byteSize = 0
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        byteSize += chunk.length
        callback(null, chunk)
      },
    })
    try {
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        hasher,
        createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
      )
      const descriptor = openSync(tempPath, "r")
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      const actual = hash.digest("hex")
      if (actual !== expected || (input.expectedSha256 && actual !== input.expectedSha256)) {
        throw new Error("Downloaded source checksum mismatch")
      }
      if (input.overwrite) {
        renameSync(tempPath, input.outputPath)
      } else {
        linkSync(tempPath, input.outputPath)
        unlinkSync(tempPath)
      }
      return { outputPath: input.outputPath, byteSize, sha256: actual }
    } catch (error) {
      if (existsSync(tempPath)) unlinkSync(tempPath)
      throw error
    }
  }

  async searchBrain(query: string, options?: { areaId?: string; limit?: number }): Promise<unknown> {
    return this.post("/brain/search", {
      query,
      areaId: options?.areaId,
      limit: options?.limit,
    })
  }

  async shareBrainNote(input: {
    areaId: string
    title: string
    markdown: string
    sourceName?: string
    intent: "interactive" | "autonomous"
  }): Promise<BrainNote> {
    return this.post("/brain/notes", input)
  }

  async updateBrainNote(
    id: string,
    input: { title?: string; markdown: string; expectedVersion: number },
  ): Promise<BrainNote> {
    return this.patch(`/brain/notes/${encodeURIComponent(id)}`, input)
  }

  async archiveBrainNote(id: string, expectedVersion: number): Promise<BrainNote> {
    return this.delete(`/brain/notes/${encodeURIComponent(id)}?expectedVersion=${expectedVersion}`)
  }

  async restoreBrainNote(id: string, expectedVersion: number): Promise<BrainNote> {
    return this.post(`/brain/notes/${encodeURIComponent(id)}/restore`, { expectedVersion })
  }

  async listBrainAudit(areaId: string, options?: { cursor?: string; limit?: number }): Promise<unknown> {
    const query = new URLSearchParams({ areaId })
    if (options?.cursor) query.set("cursor", options.cursor)
    if (options?.limit) query.set("limit", String(options.limit))
    return this.get(`/brain/audit?${query}`)
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  // Every read endpoint accepts ?org=<slug|id> for admin tokens. Exposing it as
  // --org is what keeps admins from dropping to curl for cross-org reads.

  async listEntities(opts?: { type?: string; parent?: string; limit?: number; org?: string }): Promise<any[]> {
    const params = new URLSearchParams()
    if (opts?.type) params.set("type", opts.type)
    if (opts?.parent) params.set("parent", opts.parent)
    if (opts?.limit) params.set("limit", String(opts.limit))
    if (opts?.org) params.set("org", opts.org)
    const qs = params.toString()
    return this.get(`/entities${qs ? `?${qs}` : ""}`)
  }

  async getEntity(entityId: string, org?: string): Promise<any> {
    const qs = org ? `?org=${encodeURIComponent(org)}` : ""
    return this.get(`/entities/${entityId}${qs}`)
  }

  async listProduce(opts?: { entity?: string; limit?: number; org?: string }): Promise<any[]> {
    const params = new URLSearchParams()
    if (opts?.entity) params.set("entity", opts.entity)
    if (opts?.limit) params.set("limit", String(opts.limit))
    if (opts?.org) params.set("org", opts.org)
    const qs = params.toString()
    return this.get(`/produce${qs ? `?${qs}` : ""}`)
  }

  async listContacts(opts?: { entity?: string; limit?: number; org?: string }): Promise<any[]> {
    const params = new URLSearchParams()
    if (opts?.entity) params.set("entity", opts.entity)
    if (opts?.limit) params.set("limit", String(opts.limit))
    if (opts?.org) params.set("org", opts.org)
    const qs = params.toString()
    return this.get(`/contacts${qs ? `?${qs}` : ""}`)
  }

  async listEntityTypes(org?: string): Promise<any[]> {
    const qs = org ? `?org=${encodeURIComponent(org)}` : ""
    return this.get(`/entity-types${qs}`)
  }

  async searchCatalog(opts?: { search?: string; parent?: string; type?: string; includeCategories?: boolean; limit?: number; org?: string }): Promise<any[]> {
    const params = new URLSearchParams()
    if (opts?.search) params.set("search", opts.search)
    if (opts?.parent) params.set("parent", opts.parent)
    if (opts?.type) params.set("type", opts.type)
    if (opts?.includeCategories) params.set("includeCategories", "true")
    if (opts?.limit) params.set("limit", String(opts.limit))
    if (opts?.org) params.set("org", opts.org)
    const qs = params.toString()
    return this.get(`/catalog${qs ? `?${qs}` : ""}`)
  }

  // ── Proposals ─────────────────────────────────────────────────────────────

  async listProposals(opts?: { status?: string; source?: string; limit?: number }): Promise<any[]> {
    const params = new URLSearchParams()
    if (opts?.status) params.set("status", opts.status)
    if (opts?.source) params.set("source", opts.source)
    if (opts?.limit) params.set("limit", String(opts.limit))
    const qs = params.toString()
    return this.get(`/proposals${qs ? `?${qs}` : ""}`)
  }

  async getProposal(proposalId: string): Promise<any> {
    return this.get(`/proposals/${proposalId}`)
  }

  async submitProposal(proposal: Record<string, unknown>): Promise<any> {
    return this.post("/proposals", proposal)
  }

  async submitBatch(batch: {
    org?: string
    batchLabel: string
    sourceAgent?: string
    proposals: any[]
  }): Promise<any> {
    return this.post("/proposals/batch", batch)
  }

  // ── Admin (cross-org) ─────────────────────────────────────────────────────
  // These endpoints reject non-admin tokens with 401 "Admin access required".

  async adminListEntities(opts?: {
    org?: string
    type?: string
    missingLocation?: boolean
    search?: string
    limit?: number
  }): Promise<{ results: any[]; truncated: boolean; total: number }> {
    const params = new URLSearchParams()
    if (opts?.org) params.set("org", opts.org)
    if (opts?.type) params.set("type", opts.type)
    if (opts?.missingLocation) params.set("missing-location", "1")
    if (opts?.search) params.set("search", opts.search)
    if (opts?.limit) params.set("limit", String(opts.limit))
    const qs = params.toString()
    return this.get(`/admin/entities${qs ? `?${qs}` : ""}`)
  }

  async adminListProposals(opts?: {
    status?: string
    sourceAgent?: string
    limit?: number
  }): Promise<{ results: any[]; truncated: boolean; total: number }> {
    const params = new URLSearchParams()
    if (opts?.status) params.set("status", opts.status)
    if (opts?.sourceAgent) params.set("source-agent", opts.sourceAgent)
    if (opts?.limit) params.set("limit", String(opts.limit))
    const qs = params.toString()
    return this.get(`/admin/proposals${qs ? `?${qs}` : ""}`)
  }

  // ── Produce import (admin) ────────────────────────────────────────────────

  /**
   * Direct produce entry — creates real Creator rows, not proposals.
   *
   * With `dryRun` the server runs the whole import and rolls it back, so the
   * operator approves the server's verdict instead of a reconstruction of it.
   */
  async importProduce(input: {
    entityId: string
    items: unknown[]
    dryRun?: boolean
    skipExistingNames?: boolean
    org?: string
  }): Promise<any> {
    return this.post("/produce/import", input)
  }

  /** Recipe ingredients still standing in for something vaguer. */
  async listImpreciseIngredients(entityId: string, org?: string): Promise<any> {
    const params = new URLSearchParams({ entity: entityId })
    if (org) params.set("org", org)
    return this.get(`/produce/ingredients?${params.toString()}`)
  }

  /** Point an imprecise ingredient at what it actually is. */
  async refineIngredient(input: {
    processInputId: string
    catalogConceptId?: string
    materialId?: string
    role?: string
    qty?: number
    unitCode?: string
    stillImprecise?: boolean
    org?: string
  }): Promise<any> {
    return this.patch("/produce/ingredients", input)
  }

  /**
   * Grow the shared produce catalog. Admin only — every customer sees these
   * concepts, so adding one is a platform decision, not a per-import shortcut.
   */
  async createCatalogConcepts(input: { concepts: unknown[]; org?: string }): Promise<any> {
    return this.post("/catalog/concepts", input)
  }

  /** Area sources, metadata only, newest first — the freshness evidence. */
  async listBrainSources(areaId: string): Promise<any> {
    return this.get(`/brain/sources?area=${encodeURIComponent(areaId)}`)
  }

  /** Entities with an active customer role and no investor/partner/producer role. */
  async adminCustomersOnly(): Promise<any> {
    return this.get("/admin/customers-only")
  }

  /** Tips mailed to press@mail.dayofweek.com, read by the press-scan skill. */
  async adminPressInbox(opts?: { since?: string; limit?: number }): Promise<any> {
    const params = new URLSearchParams()
    if (opts?.since) params.set("since", opts.since)
    if (opts?.limit) params.set("limit", String(opts.limit))
    const qs = params.toString()
    return this.get(`/press-inbox${qs ? `?${qs}` : ""}`)
  }

  // ── Knowledge ─────────────────────────────────────────────────────────────

  /**
   * List the knowledge documents attached to an entity. `full` returns each
   * document's whole content instead of an excerpt, which is what you want when
   * mirroring an entity's sources into an external knowledge base.
   */
  async listKnowledge(opts: {
    entity: string
    full?: boolean
    org?: string
  }): Promise<any[]> {
    const params = new URLSearchParams({ entity: opts.entity })
    if (opts.full) params.set("full", "1")
    if (opts.org) params.set("org", opts.org)
    return this.get(`/knowledge?${params.toString()}`)
  }

  async getKnowledge(documentId: string, org?: string): Promise<any> {
    const params = new URLSearchParams({ document: documentId })
    if (org) params.set("org", org)
    return this.get(`/knowledge?${params.toString()}`)
  }

  /** Semantic search across knowledge documents. */
  async searchKnowledge(opts: {
    query: string
    entity?: string
    types?: string[]
    limit?: number
    allOrgs?: boolean
    org?: string
  }): Promise<any> {
    const params = new URLSearchParams({ q: opts.query })
    if (opts.entity) params.set("entity", opts.entity)
    if (opts.types?.length) params.set("types", opts.types.join(","))
    if (opts.limit) params.set("limit", String(opts.limit))
    if (opts.allOrgs) params.set("allOrgs", "1")
    if (opts.org) params.set("org", opts.org)
    return this.get(`/knowledge?${params.toString()}`)
  }

  /**
   * Add a markdown knowledge note.
   *
   * Without `direct` this submits a proposal for human review — the default,
   * and the only option non-admin tokens have. With `direct: true` an admin
   * token writes the document immediately, skipping review. Ask the operator
   * before doing that; see references/admin.md in the served skill.
   */
  async addKnowledge(input: {
    entityId: string
    title: string
    content: string
    sourceType?: string
    sourceUrl?: string
    sourceDescription?: string
    confidence?: number
    sourceAgent?: string
    direct?: boolean
    org?: string
  }): Promise<any> {
    return this.post("/knowledge", input)
  }

  /**
   * Attach a binary source (PDF, DOCX, XLSX, …) to an entity. Admin only.
   *
   * Three hops: ask for an upload URL, send the bytes straight to Convex
   * storage, then register the resulting storageId. The bytes never pass
   * through function arguments, so file size isn't bounded by an arg limit.
   */
  async attachKnowledgeFile(input: {
    entityId: string
    /** Raw file bytes. Buffer callers: pass `toArrayBuffer(buf)` below. */
    data: ArrayBuffer
    fileName: string
    mimeType: string
    sourceType?: string
    sourceUrl?: string
    sourceDescription?: string
    org?: string
  }): Promise<any> {
    const { uploadUrl } = await this.post("/knowledge/file", {
      entityId: input.entityId,
      org: input.org,
    })

    const byteSize = input.data.byteLength
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": input.mimeType },
      body: input.data,
    })
    if (!uploadRes.ok) {
      throw new ApiError(
        uploadRes.status,
        `Upload to storage failed: ${uploadRes.status} ${uploadRes.statusText}`,
      )
    }
    const uploaded = (await uploadRes.json()) as { storageId?: string }
    if (!uploaded.storageId) throw new Error("Storage upload returned no storageId")

    return this.put("/knowledge/file", {
      entityId: input.entityId,
      org: input.org,
      storageId: uploaded.storageId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      byteSize,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      sourceDescription: input.sourceDescription,
    })
  }

  // ── Datasets ──────────────────────────────────────────────────────────────
  // The server owns the catalog: which datasets exist, what they are called,
  // and who may read them. This client is deliberately name-blind — discovery
  // happens at runtime so the open-source CLI reveals nothing about the
  // platform's product surfaces.

  async listDatasets(org?: string): Promise<{ datasets: Array<{ name: string; description: string; params: string[] }> }> {
    const qs = org ? `?org=${encodeURIComponent(org)}` : ""
    return this.get(`/datasets${qs}`)
  }

  async readDataset(name: string, opts?: { limit?: number; org?: string }): Promise<any> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set("limit", String(opts.limit))
    if (opts?.org) params.set("org", opts.org)
    const qs = params.toString()
    return this.get(`/datasets/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`)
  }

  // ── Feedback backlog ──────────────────────────────────────────────────────
  // Token scopes apply: read:feedback for the GETs, write:feedback to comment,
  // admin:feedback for claim/status/priority. backOffice users have them all.

  async listFeedback(opts?: {
    status?: string
    priority?: string
    category?: string
    limit?: number
  }): Promise<{ items: any[] }> {
    const params = new URLSearchParams()
    if (opts?.status) params.set("status", opts.status)
    if (opts?.priority) params.set("priority", opts.priority)
    if (opts?.category) params.set("category", opts.category)
    if (opts?.limit) params.set("limit", String(opts.limit))
    const qs = params.toString()
    return this.get(`/feedback${qs ? `?${qs}` : ""}`)
  }

  async getFeedbackItem(itemId: string): Promise<any> {
    return this.get(`/feedback/${encodeURIComponent(itemId)}`)
  }

  /** Top-N from the heuristic prioritizer — "what should I work on next?". */
  async feedbackRecommendations(limit?: number): Promise<{ recommendations: any[] }> {
    const qs = limit ? `?limit=${limit}` : ""
    return this.get(`/feedback/ai-recommendations${qs}`)
  }

  async claimFeedbackItem(itemId: string): Promise<any> {
    return this.post(`/feedback/${encodeURIComponent(itemId)}/claim`, {})
  }

  async commentOnFeedbackItem(itemId: string, body: string): Promise<any> {
    return this.post(`/feedback/${encodeURIComponent(itemId)}/comments`, { body })
  }

  async updateFeedbackItem(
    itemId: string,
    updates: { status?: string; priority?: string; rejectedReason?: string },
  ): Promise<any> {
    return this.patch(`/feedback/${encodeURIComponent(itemId)}`, updates)
  }

  // ── Customer emails (admin only) ──────────────────────────────────────────
  // Sending is gated on explicit human approval by the skill, not by the API.

  async listEmailThreads(opts?: {
    status?: string
    since?: string
    customer?: string
    limit?: number
    org?: string
  }): Promise<any> {
    const params = new URLSearchParams()
    if (opts?.status) params.set("status", opts.status)
    if (opts?.since) params.set("since", opts.since)
    if (opts?.customer) params.set("customer", opts.customer)
    if (opts?.limit) params.set("limit", String(opts.limit))
    if (opts?.org) params.set("org", opts.org)
    const qs = params.toString()
    return this.get(`/emails${qs ? `?${qs}` : ""}`)
  }

  async getEmailThread(threadKey: string): Promise<any> {
    return this.get(`/emails/${encodeURIComponent(threadKey)}`)
  }

  async replyToEmailThread(
    threadKey: string,
    input: { message: string; subject?: string; to?: string; cc?: string[]; quote?: boolean },
  ): Promise<any> {
    return this.post(`/emails/${encodeURIComponent(threadKey)}/reply`, input)
  }

  async composeEmail(input: {
    entityId?: string
    inbox?: string
    to: string
    cc?: string[]
    subject: string
    message: string
  }): Promise<any> {
    return this.post("/emails/compose", input)
  }

  // ── Skill ─────────────────────────────────────────────────────────────────

  async getSkillBundle(name?: string): Promise<{ name: string; version: string; hash?: string; files: Array<{ path: string; content: string; sha256?: string }> }> {
    return this.get(`/skill${name ? `?name=${encodeURIComponent(name)}` : ""}`)
  }

  async listSkillBundles(): Promise<Array<{ name: string; version: string; hash: string }>> {
    return this.get("/skill?list=1")
  }

  // ── Shared skills ─────────────────────────────────────────────────────────
  //
  // Skills other users published into shared knowledge areas. Discovery is
  // server-owned, like the named bundles above: the CLI ships no skill names,
  // and the server decides which skills this device's user may see.

  async listSharedSkills(): Promise<SharedSkillSummary[]> {
    return this.get("/brain/skills")
  }

  async getSharedSkill(skillId: string): Promise<SharedSkillBundle> {
    return this.get(`/brain/skills/${encodeURIComponent(skillId)}`)
  }

  async publishSharedSkill(input: {
    areaId: string
    name: string
    version: string
    description?: string
    visibility: "area" | "company" | "global"
    files: Array<{ path: string; content: string }>
  }): Promise<SharedSkillSummary> {
    return this.post("/brain/skills", input)
  }

  async archiveSharedSkill(skillId: string): Promise<SharedSkillSummary> {
    return this.delete(`/brain/skills/${encodeURIComponent(skillId)}`)
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  async getSchema(): Promise<any> {
    return this.get("/schema")
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private async get(path: string): Promise<any> {
    return this.request(path, { method: "GET" })
  }

  private async post(path: string, body: unknown): Promise<any> {
    return this.request(path, { method: "POST", body: JSON.stringify(body) })
  }

  private async put(path: string, body: unknown): Promise<any> {
    return this.request(path, { method: "PUT", body: JSON.stringify(body) })
  }

  private async patch(path: string, body: unknown): Promise<any> {
    return this.request(path, { method: "PATCH", body: JSON.stringify(body) })
  }

  private async delete(path: string): Promise<any> {
    return this.request(path, { method: "DELETE" })
  }


  private async request(path: string, init: RequestInit): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    })
    if (!res.ok) throw await apiErrorFromResponse(res)
    return res.json()
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  const body = await response.text()
  try {
    const json = JSON.parse(body) as {
      error?: string | { code?: string; message?: string; requestId?: string }
    }
    if (typeof json.error === "string") return new ApiError(response.status, json.error)
    return new ApiError(
      response.status,
      json.error?.message ?? `Request failed (${response.status})`,
      json.error?.code,
      json.error?.requestId,
    )
  } catch {
    return new ApiError(response.status, `Request failed (${response.status})`)
  }
}

export type BrainArea = {
  id: string
  name: string
  kind: "company" | "project"
  role: "owner" | "editor" | "viewer"
  canWrite: boolean
  canManage: boolean
  uri: string
  httpsUrl: string
  updatedAt: number
}

export type BrainNote = {
  id: string
  areaId: string
  areaName: string
  title: string
  markdown: string
  status: string
  version: number
  hash?: string
  sourceId?: string
  sourceUri?: string
  uri: string
  httpsUrl: string
  createdAt: number
  updatedAt: number
}

export type BrainSource = {
  id: string
  areaId: string
  areaName: string
  kind: "text" | "audio" | "file"
  filename?: string
  mimeType?: string
  byteSize?: number
  sha256?: string
  scanState?: "pending" | "clean" | "quarantined" | "failed"
  processingState: string
  rawText?: string
  extractedText?: string
  transcript?: string
  isMeeting: boolean
  derivedNoteUri?: string
  canDownload: boolean
  uri: string
  httpsUrl: string
  uploadedAt: number
}

export type BrainResolvedResource =
  | { resourceType: "area"; area: BrainArea }
  | { resourceType: "note"; note: BrainNote }
  | { resourceType: "source"; source: BrainSource }

export type SharedSkillSummary = {
  id: string
  areaId: string
  areaName: string
  name: string
  version: string
  description?: string
  hash: string
  // "area" = the owning area's members; "company" = everyone in the owning
  // area's organization; "global" = every user of the service (published by
  // service administrators as a shared starter library).
  visibility: "area" | "company" | "global"
  revision: number
  fileCount: number
  byteSize: number
  uri: string
  httpsUrl: string
  updatedAt: number
}

export type SharedSkillBundle = Omit<SharedSkillSummary, "fileCount" | "byteSize"> & {
  files: Array<{ path: string; content: string; sha256: string }>
}
