import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { defaultCredentialStore, type CredentialStore } from "./credentials.js"

export interface DcliConfig {
  authToken?: string
  apiUrl?: string
  /**
   * Cached admin status from the last `dcli auth status` call. Used to
   * decide locally whether to expose admin-only subcommands in `--help`.
   * Refreshed automatically when `dcli auth status` or `dcli auth login`
   * runs; admin commands are hidden when this is unset or false.
   */
  isAdmin?: boolean
  /** Unix-ms timestamp of the last isAdmin refresh. */
  roleCachedAt?: number
}

const CONFIG_DIR = join(homedir(), ".config", "dayofweek")
const CONFIG_FILE = join(CONFIG_DIR, "dcli.json")

export function loadConfig(): DcliConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
    }
  } catch {
    // Ignore malformed config
  }
  return {}
}

export function saveConfig(updates: Partial<DcliConfig>): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const existing = loadConfig()
  const merged = { ...existing, ...updates }
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o600 })
}

export function getToken(store: CredentialStore = defaultCredentialStore()): string {
  const config = loadConfig()
  const storedToken = store.get()
  const token =
    process.env.DCLI_AUTH_TOKEN ??
    process.env.DCLI_TOKEN ??
    storedToken ??
    config.authToken

  // One-way migration of the old plaintext config. The legacy key is removed
  // immediately after the protected store accepts it.
  if (!storedToken && config.authToken && token === config.authToken) {
    store.set(config.authToken)
    saveConfig({ authToken: undefined })
  }

  if (!token) {
    throw new Error("No credential found. Run: dcli auth login")
  }

  return token
}

export function saveCredential(secret: string, store: CredentialStore = defaultCredentialStore()): void {
  store.set(secret)
  if (loadConfig().authToken) saveConfig({ authToken: undefined })
}

export function deleteCredential(store: CredentialStore = defaultCredentialStore()): void {
  store.delete()
  if (loadConfig().authToken) saveConfig({ authToken: undefined })
}

export function getApiUrl(): string {
  return (
    process.env.DCLI_API_URL ??
    loadConfig().apiUrl ??
    "https://field.dayofweek.com/app/api/dcli"
  )
}
