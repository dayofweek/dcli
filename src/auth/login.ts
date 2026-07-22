import { hostname } from "node:os"
import { createAuthorizationRequest, verifyAuthorizationCallback } from "./pkce.js"
import { startLoopbackListener, type LoopbackListener } from "./loopback.js"

type LoginDependencies = {
  startListener: () => Promise<LoopbackListener>
  openBrowser: (url: string) => Promise<unknown>
  fetch: typeof globalThis.fetch
}

export async function browserLogin(options: {
  apiUrl: string
  scopes: string[]
  deviceName?: string
  sourceApp?: "dcli" | "dayofweek-desktop"
  dependencies?: Partial<LoginDependencies>
}): Promise<{ secret: string; scopes: string[]; bootstrap: unknown }> {
  const dependencies: LoginDependencies = {
    startListener: startLoopbackListener,
    openBrowser: async (url) => (await import("open")).default(url),
    fetch: globalThis.fetch,
    ...options.dependencies,
  }
  const listener = await dependencies.startListener()
  try {
    const appBase = options.apiUrl.replace(/\/api\/dcli\/?$/, "")
    const request = await createAuthorizationRequest({
      authorizeUrl: `${appBase}/dcli/auth`,
      redirectUri: listener.redirectUri,
      deviceName: options.deviceName ?? hostname(),
      scopes: options.scopes,
    })
    const authorizeUrl = new URL(request.url)
    authorizeUrl.searchParams.set("source_app", options.sourceApp ?? "dcli")
    await dependencies.openBrowser(authorizeUrl.toString())
    const callbackUrl = await listener.waitForCallback()
    const { code } = verifyAuthorizationCallback(callbackUrl, request.state)
    const exchange = await dependencies.fetch(`${options.apiUrl}/auth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier: request.verifier, redirectUri: listener.redirectUri }),
    })
    if (!exchange.ok) throw new Error("Authorization code exchange failed")
    const credential = await exchange.json() as { secret: string; scopes: string[] }
    const bootstrapResponse = await dependencies.fetch(`${options.apiUrl}/brain/bootstrap`, {
      headers: { Authorization: `Bearer ${credential.secret}` },
    })
    if (!bootstrapResponse.ok) throw new Error("Day of Week bootstrap check failed")
    return {
      secret: credential.secret,
      scopes: credential.scopes,
      bootstrap: await bootstrapResponse.json(),
    }
  } finally {
    await listener.close()
  }
}
