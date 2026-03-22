import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface DcliConfig {
  authToken?: string
  apiUrl?: string
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
  mkdirSync(CONFIG_DIR, { recursive: true })
  const existing = loadConfig()
  const merged = { ...existing, ...updates }
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8")
}

export function getToken(): string {
  const token =
    process.env.DCLI_AUTH_TOKEN ??
    process.env.DCLI_TOKEN ??
    loadConfig().authToken

  if (!token) {
    console.error("No auth token found.")
    console.error("Set DCLI_AUTH_TOKEN or run: dcli auth login")
    process.exit(1)
  }

  return token
}

export function getApiUrl(): string {
  return (
    process.env.DCLI_API_URL ??
    loadConfig().apiUrl ??
    "https://field.dayofweek.com/app/api/dcli"
  )
}
