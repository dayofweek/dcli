import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

const ALLOWED_SCOPES = new Set(["brain:read", "brain:write", "brain:manage"])

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url")
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function validateLoopbackRedirect(input: string): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error("Invalid loopback redirect URI")
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/callback" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Redirect must be an exact http://127.0.0.1:<port>/callback URI")
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Invalid loopback callback port")
  }
  return url
}

export async function createAuthorizationRequest(options: {
  authorizeUrl: string
  redirectUri: string
  deviceName: string
  scopes: string[]
}): Promise<{ url: string; state: string; verifier: string }> {
  const redirectUri = validateLoopbackRedirect(options.redirectUri).toString()
  const scopes = [...new Set(options.scopes)]
  if (scopes.length === 0 || scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new Error("Invalid requested brain scopes")
  }
  const deviceName = options.deviceName.trim()
  if (!deviceName || deviceName.length > 100) throw new Error("Invalid device name")

  const state = base64url(randomBytes(32))
  const verifier = base64url(randomBytes(48))
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url")
  const url = new URL(options.authorizeUrl)
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") {
    throw new Error("Authorization URL must use HTTPS")
  }
  url.search = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    device_name: deviceName,
    scope: scopes.join(" "),
  }).toString()
  return { url: url.toString(), state, verifier }
}

export function verifyAuthorizationCallback(callbackUrl: string, expectedState: string): { code: string } {
  const url = new URL(callbackUrl)
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/callback" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Invalid authorization callback")
  }
  const keys = [...url.searchParams.keys()]
  if (
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    !keys.includes("code") ||
    !keys.includes("state") ||
    url.searchParams.getAll("code").length !== 1 ||
    url.searchParams.getAll("state").length !== 1
  ) {
    throw new Error("Authorization callback must contain only code and state")
  }
  const code = url.searchParams.get("code") ?? ""
  const state = url.searchParams.get("state") ?? ""
  if (!/^[A-Za-z0-9_-]{3,256}$/.test(code)) throw new Error("Invalid authorization code")
  if (!safeEqual(state, expectedState)) throw new Error("Authorization state mismatch")
  return { code }
}
