/**
 * HTTP client for the Day of Week platform REST API.
 * All calls go through the proxy at field.dayofweek.com/app/api/dcli.
 */

const DEFAULT_BASE_URL = "https://field.dayofweek.com/app/api/dcli"

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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

  async checkAuth(): Promise<{ status: string; authenticated: boolean }> {
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

  // ── Skill ─────────────────────────────────────────────────────────────────

  async getSkillBundle(): Promise<{ name: string; version: string; files: Array<{ path: string; content: string }> }> {
    return this.get("/skill")
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  async getSchema(): Promise<any> {
    return this.get("/schema")
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      const body = await res.text()
      try {
        const json = JSON.parse(body)
        throw new ApiError(res.status, json.error ?? body)
      } catch (e) {
        if (e instanceof ApiError) throw e
        throw new ApiError(res.status, body)
      }
    }
    return res.json()
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      try {
        const json = JSON.parse(text)
        throw new ApiError(res.status, json.error ?? text)
      } catch (e) {
        if (e instanceof ApiError) throw e
        throw new ApiError(res.status, text)
      }
    }
    return res.json()
  }

  private async delete(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new ApiError(res.status, text)
    }
    return res.json()
  }
}
