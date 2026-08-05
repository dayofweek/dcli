# @dayofweek/dcli

`dcli` is the Day of Week command-line client for personal and shared knowledge. It gives Agent Skills a narrow, auditable interface to shared notes and original sources without putting credentials or shared content inside your personal wiki.

The Day of Week desktop app is the recommended installer. A signed standalone binary is also available for technical users; npm is required only when developing `dcli` itself.

## Sign in

```bash
dcli auth login --scopes brain:read,brain:write
dcli auth status --json
dcli doctor --json
```

Login uses a short-lived, single-use browser authorization code with PKCE. The device credential is stored in macOS Keychain, a Linux secret-service provider, Windows' protected credential file, or a permission-restricted file fallback. `dcli` does not write a new plaintext token to its JSON config.

You can remove the device credential at any time:

```bash
dcli auth logout --json
```

## Shared knowledge

```bash
# Discover spaces that this device may access
dcli brain list --json

# Search one space
dcli brain search "soil health" --area <areaId> --json

# Read a canonical Day of Week URI
dcli brain get 'dayofweek://brain/<areaId>/note/<noteId>' --json

# Explicitly share a local Markdown note
dcli brain share --area <areaId> --title "Soil plan" \
  --file wiki/soil-plan.md --intent interactive --json

# Optimistic update; a stale version exits with the conflict exit code
dcli brain update 'dayofweek://brain/<areaId>/note/<noteId>' \
  --file wiki/soil-plan.md --if-version 3 --json
```

Autonomous note creation is saved as a draft. Interactive creation is saved as approved. An organization role, Studio role, or administrator role never grants shared-space access on its own: access requires an active device scope and an active membership in the exact destination space.

### Original files

Original files are deliberately separate from note text:

```bash
dcli brain source upload --area <areaId> --file research.pdf --mime application/pdf --json
dcli brain source get 'dayofweek://brain/<areaId>/source/<sourceId>' --json
dcli brain source download 'dayofweek://brain/<areaId>/source/<sourceId>' \
  --output ./downloads/research.pdf --json
```

Downloads require an explicit output path, verify SHA-256 while streaming, fsync the temporary file, and install it atomically. Existing destinations are not replaced unless `--overwrite` is supplied. Recorded meetings also require `--meeting --consent-ack`; that flag is an explicit attestation that participants were informed and consented.

## Agent Skills

Named bundles are deterministic and available to authenticated devices:

```bash
dcli skill list --json
dcli skill install personal-llm-wiki --dir .agents/skills/personal-llm-wiki --json
dcli skill install dayofweek-brain --dir .agents/skills/dayofweek-brain --json
dcli skill status dayofweek-brain --dir .agents/skills/dayofweek-brain --json
dcli skill update dayofweek-brain --dir .agents/skills/dayofweek-brain --json
```

Updates overwrite only files whose installed hash still matches the managed manifest. Locally edited managed files are preserved and the new server version is written beside them as `<name>.new`.

The legacy entity/proposal Agent Skill remains available through `dcli skill install` without a bundle name.

### Shared skills

Beyond the named bundles above, users can publish their own skills into a shared knowledge area. Anyone who can read the area — or, with `--visibility company`, anyone in the publishing area's organization — can then discover, install, and update the skill. Service administrators can additionally publish with `--visibility global`, making a skill a shared starter for every user of the service; the desktop app syncs global skills into managed wikis automatically.

```bash
# Publish a local skill directory (name/version come from SKILL.md frontmatter)
dcli skill publish --area <areaId> --dir .agents/skills/meeting-notes --visibility company

# Discover: --shared adds skills shared with you to the bundle listing
dcli skill list --shared --json

# Install by canonical URI, or by name + area
dcli skill install 'dayofweek://brain/<areaId>/skill/<skillId>'
dcli skill install meeting-notes --area <areaId>

# Update goes back to wherever the install came from
dcli skill update meeting-notes --area <areaId>
dcli skill update --dir .agents/skills/meeting-notes

# Check for newer versions without writing anything
dcli skill status meeting-notes --dir .agents/skills/meeting-notes --check

# Retire a shared skill you own
dcli skill archive 'dayofweek://brain/<areaId>/skill/<skillId>'
```

Shared skills go through the same integrity pipeline as named bundles: per-file SHA-256 plus a manifest hash computed server-side and re-verified locally before anything touches disk, the same path-safety rules, and the same conflict handling — locally edited files are never overwritten. The install origin is recorded in `.dayofweek-skill.json`, so `skill update` and `skill status --check` know whether to ask the bundle endpoint or the shared-skill endpoint. Publishing requires write access to the area; `--visibility company` and `skill archive` require ownership.

## URI contract

`dcli` accepts only exact canonical resource forms:

```text
dayofweek://brain/<areaId>/note/<noteId>
dayofweek://brain/<areaId>/source/<sourceId>
https://field.dayofweek.com/brain/<areaId>/note/<noteId>
https://field.dayofweek.com/brain/<areaId>/source/<sourceId>
```

Unknown hosts, user-info, ports, query strings, fragments, encoded path separators, malformed identifiers, and oversized input are rejected before any API request.

## Entity knowledge

Knowledge documents attached to an entity — read them, add to them, mirror them
out into another knowledge base.

```bash
# Read
dcli knowledge list --entity <entityId> --json
dcli knowledge list --entity <entityId> --full --json    # whole content, not excerpts
dcli knowledge get <documentId> --json
dcli knowledge search "cold chain" --entity <entityId> --json

# Add a markdown note — submitted for human review
dcli knowledge add --entity <entityId> --title "Variety catalogue" --file note.md

# Mirror an entity's sources to disk as markdown with provenance front-matter
dcli knowledge export --entity <entityId> --out ./knowledge
```

`add` submits a proposal by default: a person approves it before it lands. If
your token has admin rights you can pass `--direct` to skip review, and
`dcli knowledge attach --file article.pdf` to upload a binary source. Both write
immediately, so treat them as something you do when a person has asked for that
specific document — not as the normal path. The server rejects them for
non-admin tokens.

## Datasets

The platform offers additional read-only datasets beyond entities and
knowledge. The catalog is server-owned and discovered at runtime — what
`data list` returns is exactly what your credential may read.

```bash
dcli data list --json
dcli data get <dataset> --limit 100 --json
```

Responses are `{ dataset, total, truncated, rows }`. The CLI has no built-in
dataset names; new datasets appear in the listing without a CLI update.

## Feedback backlog

The customer feedback backlog that humans and coding agents work together.

```bash
dcli feedback next --json                    # what should I work on next
dcli feedback list --status backlog --json
dcli feedback show <itemId> --json
dcli feedback claim <itemId> --json          # signal that you picked it up
dcli feedback comment <itemId> --body "Fixed in #482"
dcli feedback status <itemId> --status shipped
```

Access follows the token's scopes: `read:feedback` for the reads,
`write:feedback` to comment, `admin:feedback` for claim/status/priority.
Day of Week staff hold all three implicitly.

## Customer emails (staff)

Mail sent to a customer's own inbox address becomes a thread you can answer.
The commands appear once `dcli auth status` has cached your admin role.

```bash
dcli emails list --status needs_reply --json
dcli emails show <threadKey> --json
dcli emails reply <threadKey> --message "..." --approved
dcli emails compose --entity <entityId> --to person@example.com \
  --subject "..." --message "..." --approved
```

`reply` and `compose` refuse to run without `--approved`. Sending mail as a
customer is irreversible and outward-facing, so it cannot happen as a side
effect of reading the inbox — a person approves the exact text first, and
`--approved` records that they did.

## Legacy platform commands

Existing read/proposal workflows remain compatible:

```bash
dcli read entities --json
dcli agent propose --op create --table hierarchyEntities \
  --title "New Farm" --source "my-agent" \
  --parent <parentEntityId> --entity-type Farm --file payload.json
dcli agent proposals --status pending --json
```

## Configuration and development

Non-secret preferences are stored at `~/.config/dayofweek/dcli.json`.

- `DCLI_API_URL` overrides the API base URL.
- `DCLI_AUTH_TOKEN` and `--token` remain temporary compatibility overrides; they are not persisted by the current login flow.

Development commands:

```bash
npm install
npm test
npm run build            # tsc + the dependency-free bundle
npm run build:bundle     # just dist/bundle/dcli.cjs
npm run standalone:build
npm run standalone:smoke
```

### What gets published

`npm run build` produces two runnable forms, and both ship:

- **`dist/bin/dcli.js`** — the normal entry point, the one `bin` points at. It
  imports `commander` and `open` from `node_modules`, which is exactly right
  when npm installed the package.
- **`dist/bundle/dcli.cjs`** — the same CLI with its dependencies compiled in,
  runnable straight from an unpacked tarball.

The bundle exists for consumers that unpack the tarball themselves instead of
installing it, the Day of Week desktop app being the one that matters: it fetches
the published package and runs it with Electron's Node, so a customer with no
`node` and no `npm` still gets a working `dcli`. Without the bundle that install
starts and immediately fails on a missing `commander`.

Keep both. Dropping `dist/bundle/` from `files` silently breaks the desktop app's
dcli updates.

## License

MIT
