import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ProtectedFileCredentialStore } from "../src/credentials.js"

describe("protected credential fallback", () => {
  it("stores outside a vault and uses owner-only permissions on POSIX", () => {
    const directory = mkdtempSync(join(tmpdir(), "dcli-credential-"))
    const path = join(directory, "app-owned", "credential.json")
    const store = new ProtectedFileCredentialStore(path)
    const secret = `dsk_${"a".repeat(43)}`
    store.set(secret)
    expect(store.get()).toBe(secret)
    if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0)
    expect(readFileSync(path, "utf8")).not.toContain("authToken")
    store.delete()
    expect(store.get()).toBeUndefined()
  })
})
