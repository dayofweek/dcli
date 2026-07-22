import { describe, expect, it } from "vitest"
import {
  createAuthorizationRequest,
  validateLoopbackRedirect,
  verifyAuthorizationCallback,
} from "../src/auth/pkce.js"

describe("loopback PKCE contracts", () => {
  it("creates an S256 request without putting a credential in the URL", async () => {
    const request = await createAuthorizationRequest({
      authorizeUrl: "https://field.dayofweek.com/app/dcli/auth",
      redirectUri: "http://127.0.0.1:43123/callback",
      deviceName: "Test Mac",
      scopes: ["brain:read", "brain:write"],
    })
    const url = new URL(request.url)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get("state")).toBe(request.state)
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:43123/callback")
    expect(request.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(request.url).not.toMatch(/token|jwt|dsk_/i)
  })

  it.each([
    "https://127.0.0.1:43123/callback",
    "http://localhost:43123/callback",
    "http://0.0.0.0:43123/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:43123/not-callback",
    "http://user:pass@127.0.0.1:43123/callback",
    "http://127.0.0.1:43123/callback?token=x",
  ])("rejects altered redirect %s", (uri) => {
    expect(() => validateLoopbackRedirect(uri)).toThrow()
  })

  it("accepts only code plus matching state", () => {
    expect(
      verifyAuthorizationCallback(
        "http://127.0.0.1:43123/callback?code=abc_123&state=expected",
        "expected",
      ),
    ).toEqual({ code: "abc_123" })
    expect(() =>
      verifyAuthorizationCallback(
        "http://127.0.0.1:43123/callback?code=abc&state=wrong",
        "expected",
      ),
    ).toThrow(/state/i)
    expect(() =>
      verifyAuthorizationCallback(
        "http://127.0.0.1:43123/callback?code=abc&state=expected&token=leak",
        "expected",
      ),
    ).toThrow()
  })
})
