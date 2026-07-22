import { describe, expect, it } from "vitest"
import { browserLogin } from "../src/auth/login.js"

describe("browser login orchestration", () => {
  it("exchanges a one-time code and bootstraps without credentials in URLs", async () => {
    let callback = ""
    const opened: string[] = []
    const fetched: Array<{ url: string; init?: RequestInit }> = []
    const result = await browserLogin({
      apiUrl: "https://field.dayofweek.com/app/api/dcli",
      scopes: ["brain:read", "brain:write"],
      deviceName: "Test device",
      dependencies: {
        startListener: async () => ({
          redirectUri: "http://127.0.0.1:43123/callback",
          waitForCallback: async () => callback,
          close: async () => undefined,
        }),
        openBrowser: async (url) => {
          opened.push(url)
          const state = new URL(url).searchParams.get("state")!
          callback = `http://127.0.0.1:43123/callback?code=bac_test-code&state=${state}`
        },
        fetch: async (input, init) => {
          const url = String(input)
          fetched.push({ url, init })
          if (url.endsWith("/auth/exchange")) {
            return Response.json({ secret: `dsk_${"x".repeat(43)}`, scopes: ["brain:read", "brain:write"] })
          }
          return Response.json({ authenticated: true, areas: [{ id: "area" }] })
        },
      },
    })
    expect(result.scopes).toEqual(["brain:read", "brain:write"])
    expect(opened).toHaveLength(1)
    expect(opened[0]).not.toMatch(/dsk_|token|jwt/i)
    expect(fetched.map((entry) => entry.url)).toEqual([
      "https://field.dayofweek.com/app/api/dcli/auth/exchange",
      "https://field.dayofweek.com/app/api/dcli/brain/bootstrap",
    ])
    expect(String(fetched[1].init?.headers)).not.toContain(`dsk_${"x".repeat(43)}`)
    expect(JSON.stringify(fetched[0].init)).not.toContain("brain:write")
  })
})
