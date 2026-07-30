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
npm run build
npm run standalone:build
npm run standalone:smoke
```

## License

MIT
