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

  async listEntities(opts?: { type?: string; parent?: string; limit?: number }): Promise<any[]> {
    const params = new URLSearchParams()
    if (opts?.type) params.set("type", opts.type)
    if (opts?.parent) params.set("parent", opts.parent)
    if (opts?.limit) params.set("limit", String(opts.limit))
    const qs = params.toString()
    return this.get(`/entities${qs ? `?${qs}` : ""}`)
  }

  async getEntity(entityId: string): Promise<any> {
    return this.get(`/entities/${entityId}`)
  }

  async listProduce(opts?: { entity?: string; limit?: number }): Promise<any[]> {
    const params = new URLSearchParams()
    if (opts?.entity) params.set("entity", opts.entity)
    if (opts?.limit) params.set("limit", String(opts.limit))
    const qs = params.toString()
    return this.get(`/produce${qs ? `?${qs}` : ""}`)
  }

  async listContacts(opts?: { entity?: string; limit?: number }): Promise<any[]> {
    const params = new URLSearchParams()
    if (opts?.entity) params.set("entity", opts.entity)
    if (opts?.limit) params.set("limit", String(opts.limit))
    const qs = params.toString()
    return this.get(`/contacts${qs ? `?${qs}` : ""}`)
  }

  async listEntityTypes(): Promise<any[]> {
    return this.get("/entity-types")
  }

  async searchCatalog(opts?: { search?: string; parent?: string; type?: string; includeCategories?: boolean; limit?: number }): Promise<any[]> {
    const params = new URLSearchParams()
    if (opts?.search) params.set("search", opts.search)
    if (opts?.parent) params.set("parent", opts.parent)
    if (opts?.type) params.set("type", opts.type)
    if (opts?.includeCategories) params.set("includeCategories", "true")
    if (opts?.limit) params.set("limit", String(opts.limit))
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

  async submitBatch(batch: { batchLabel: string; sourceAgent?: string; proposals: any[] }): Promise<any> {
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

  // ── Skill ─────────────────────────────────────────────────────────────────

  async getSkillBundle(name?: string): Promise<{ name: string; version: string; hash?: string; files: Array<{ path: string; content: string; sha256?: string }> }> {
    return this.get(`/skill${name ? `?name=${encodeURIComponent(name)}` : ""}`)
  }

  async listSkillBundles(): Promise<Array<{ name: string; version: string; hash: string }>> {
    return this.get("/skill?list=1")
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
