import { createServer, type Server } from "node:http"

export type LoopbackListener = {
  redirectUri: string
  waitForCallback(timeoutMs?: number): Promise<string>
  close(): Promise<void>
}

export async function startLoopbackListener(): Promise<LoopbackListener> {
  let callbackResolve: ((url: string) => void) | undefined
  let callbackReject: ((error: Error) => void) | undefined
  const callback = new Promise<string>((resolve, reject) => {
    callbackResolve = resolve
    callbackReject = reject
  })
  let settled = false
  const server: Server = createServer((request, response) => {
    const address = server.address()
    const port = address && typeof address === "object" ? address.port : 0
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
    response.statusCode = url.pathname === "/callback" ? 200 : 404
    response.setHeader("Content-Type", "text/plain; charset=utf-8")
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("X-Content-Type-Options", "nosniff")
    response.end(url.pathname === "/callback" ? "Day of Week authorization received. You can close this window." : "Not found")
    if (!settled && url.pathname === "/callback") {
      settled = true
      callbackResolve?.(url.toString())
    }
  })
  server.on("error", (error) => {
    if (!settled) {
      settled = true
      callbackReject?.(error)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve)
    server.once("error", reject)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not bind loopback listener")
  const redirectUri = `http://127.0.0.1:${address.port}/callback`
  return {
    redirectUri,
    async waitForCallback(timeoutMs = 120_000) {
      let timer: NodeJS.Timeout | undefined
      try {
        return await Promise.race([
          callback,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Authorization callback timed out")), timeoutMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
