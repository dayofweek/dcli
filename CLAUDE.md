# @dayofweek/dcli

Public CLI for the Day of Week AgTech platform.

## Architecture

This is a **pure REST client** — no Convex, no internal dependencies. It talks to the Day of Week platform via the REST API at `https://field.dayofweek.com/app/api/dcli/`.

```
src/
  bin/dcli.ts   — CLI entry point (commander)
  client.ts     — HTTP client wrapping the REST API
  config.ts     — Token storage (~/.config/dayofweek/dcli.json)
```

## Key decisions

- **No Convex dependency** — we call the REST API, not Convex directly
- **Minimal dependencies** — just `commander` and `open`
- **JSON output** — agents prefer structured output
- **Token-based auth** — Bearer token in Authorization header
- **Agent Skill** — `dcli skill install` downloads the skill from the API (auth-gated)

## Development

```bash
npm install
npm run dev -- auth status    # Run in dev mode via tsx
npm run build                 # Compile to dist/
```

## Publishing

```bash
npm run build
npm publish
```
