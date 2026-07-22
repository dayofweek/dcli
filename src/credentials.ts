import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { homedir, platform, userInfo } from "node:os"
import { dirname, join } from "node:path"

const SERVICE = "com.dayofweek.dcli"
const ACCOUNT = "brain-device"

export interface CredentialStore {
  get(): string | undefined
  set(secret: string): void
  delete(): void
}

export class ProtectedFileCredentialStore implements CredentialStore {
  constructor(public readonly path: string = join(homedir(), ".config", "dayofweek", "credentials.json")) {}

  get(): string | undefined {
    if (!existsSync(this.path)) return undefined
    if (platform() !== "win32" && (statSync(this.path).mode & 0o077) !== 0) {
      throw new Error(`Credential file permissions are unsafe: ${this.path}`)
    }
    const value = JSON.parse(readFileSync(this.path, "utf8")) as { deviceSecret?: unknown }
    return typeof value.deviceSecret === "string" ? value.deviceSecret : undefined
  }

  set(secret: string): void {
    if (!/^dsk_[A-Za-z0-9_-]{20,160}$/.test(secret)) throw new Error("Refusing to store an invalid credential")
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (platform() !== "win32") chmodSync(directory, 0o700)
    writeFileSync(this.path, JSON.stringify({ deviceSecret: secret }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "w",
    })
    if (platform() !== "win32") {
      chmodSync(this.path, 0o600)
      if ((statSync(this.path).mode & 0o077) !== 0) throw new Error("Could not secure credential file")
    } else {
      const username = userInfo().username
      execFileSync("icacls", [this.path, "/inheritance:r", "/grant:r", `${username}:(R,W)`], {
        stdio: "ignore",
      })
    }
  }

  delete(): void {
    if (existsSync(this.path)) unlinkSync(this.path)
  }
}

class MacKeychainCredentialStore implements CredentialStore {
  get(): string | undefined {
    try {
      return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    } catch {
      return undefined
    }
  }

  set(secret: string): void {
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", secret],
      { stdio: "ignore" },
    )
  }

  delete(): void {
    try {
      execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], {
        stdio: "ignore",
      })
    } catch {
      // Missing credential is already logged out.
    }
  }
}

class LinuxSecretServiceCredentialStore implements CredentialStore {
  get(): string | undefined {
    try {
      return execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    } catch {
      return undefined
    }
  }

  set(secret: string): void {
    execFileSync(
      "secret-tool",
      ["store", "--label", "Day of Week device", "service", SERVICE, "account", ACCOUNT],
      { input: secret, stdio: ["pipe", "ignore", "ignore"] },
    )
  }

  delete(): void {
    try {
      execFileSync("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT], { stdio: "ignore" })
    } catch {
      // Missing credential is already logged out.
    }
  }
}

export function defaultCredentialStore(): CredentialStore {
  if (platform() === "darwin") return new MacKeychainCredentialStore()
  if (platform() === "linux") {
    try {
      execFileSync("secret-tool", ["--version"], { stdio: "ignore" })
      return new LinuxSecretServiceCredentialStore()
    } catch {
      return new ProtectedFileCredentialStore()
    }
  }
  return new ProtectedFileCredentialStore()
}
