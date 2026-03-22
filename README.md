# @dayofweek/dcli

CLI for the [Day of Week](https://dayofweek.com) AgTech platform.

Read your organization's data and submit proposals for human review — nothing changes until you approve it.

## Install

```bash
npm install -g @dayofweek/dcli
```

## Quick start

```bash
# Authenticate
dcli auth set-token <your-token>

# Browse your entities
dcli read entities --json

# Submit a proposal
dcli agent propose --op create --table hierarchyEntities \
  --title "New Farm" --source "my-agent" \
  --parent <parentEntityId> --entity-type Farm \
  --file payload.json

# Check proposal status
dcli agent proposals --status pending
```

## Agent integration

```bash
# Install the Agent Skill for AI agents
dcli skill install

# Works with OpenClaw, Claude Code, Cursor, VS Code Copilot,
# Gemini CLI, Goose, OpenHands, and 25+ others
```

The skill follows the open [Agent Skills](https://agentskills.io) standard. After `dcli skill install`, any compatible agent on the machine discovers it automatically.

## Commands

### Authentication
- `dcli auth login` — Authenticate via browser
- `dcli auth set-token <token>` — Save a token locally
- `dcli auth status` — Check token health
- `dcli auth devices` — List your agent tokens
- `dcli auth create-token <name>` — Create an agent token
- `dcli auth revoke <id>` — Revoke a token

### Reading data
- `dcli read entities [--type Farm] [--parent <id>] [--limit 50]`
- `dcli read entity <entityId>`
- `dcli read produce [--entity <id>]`
- `dcli read contacts [--entity <id>]`

### Proposals
- `dcli agent propose --op create --table <table> --title <title> [--file payload.json]`
- `dcli agent propose-batch --label <label> --file batch.json`
- `dcli agent proposals [--status pending]`
- `dcli agent show <proposalId>`

### Agent Skill
- `dcli skill install` — Download skill (requires auth)
- `dcli skill update` — Update to latest
- `dcli skill status` — Check installed version

## Configuration

dcli stores its config at `~/.config/dayofweek/dcli.json`.

Environment variables:
- `DCLI_AUTH_TOKEN` — Auth token (overrides stored token)
- `DCLI_API_URL` — Custom API base URL

## REST API

dcli talks to the Day of Week platform via a REST API. You can also call it directly:

```bash
curl -H "Authorization: Bearer dsk_xxx" \
  "https://field.dayofweek.com/app/api/dcli/entities?type=Farm"
```

See the [API schema](https://field.dayofweek.com/app/api/dcli/schema) for all endpoints.

## License

MIT
