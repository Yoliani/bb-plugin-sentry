---
name: sentry
description: Query Sentry or GlitchTip issues, events, and logs through the bb-plugin-sentry command. Use when debugging a production error, chasing a stack trace, finding what broke recently, or checking the latest events for a project.
---

# Sentry / GlitchTip via `bb sentry`

The `bb sentry` CLI (from the bb-plugin-sentry plugin) reads error-tracking data
over the Sentry-compatible API. Works against Sentry SaaS and against GlitchTip
(or any Sentry-compatible host) at a custom URL.

## Configuration

Resolved from, highest first: the plugin's settings → `SENTRY_URL` /
`SENTRY_AUTH_TOKEN` / `SENTRY_BACKEND` → `~/.sentryclirc`.

```ini
[auth]
token=<token>

[defaults]
url=https://glitchtip.example.com/    # omit for sentry.io
org=myorg
project=backend
```

`url` is the host you open in the browser; `/api/0` is appended. `sentry.io` and
`*.sentry.io` are auto-detected as Sentry; self-hosted Sentry needs
`backend=sentry`.

## Quick reference

| Task | Command |
|------|---------|
| Show the resolved connection | `bb sentry config` |
| Verify the token and org | `bb sentry test` |
| List the org's projects | `bb sentry projects` |
| List issues | `bb sentry issues --status unresolved --level error --period 24h` |
| Get one issue | `bb sentry issue 5765604106` |
| Issue + latest event (stack trace) | `bb sentry issue 5765604106 --latest` |
| Get one event | `bb sentry event <event-id> --project backend` |
| Search logs | `bb sentry logs "timeout" --level error --period 6h` |

All commands take `--json` for raw output. `bb sentry issues` takes
`--status`, `--level`, `--period`, `--sort`, `--limit`, `--query`,
`--project`. It pages results: pass `--cursor <opaque>` (returned as
`nextCursor` in `--json`, and shown in the CLI footer) to fetch the next page.
`bb sentry logs` takes `--level`, `--period`, `--trace`, `--limit`,
`--project`.

## Common debugging workflows

### "What errors are happening right now?"

```bash
bb sentry issues --status unresolved --level error --period 24h
bb sentry issues --sort freq --period 7d
bb sentry issues --query "ConnectionResetError"
```

### "Show me this issue"

```bash
bb sentry issue 5765604106 --latest
bb sentry issue https://glitchtip.example.com/myorg/issues/42 --latest
```

`--latest` attaches the most recent event: stack trace, request, breadcrumbs,
runtime context — usually the whole story for a crash. The event
(`bb sentry event`) and `--latest` render the exception stack trace and the
most recent 15 breadcrumbs, not just tags.

### "What was logged around that time?"

```bash
bb sentry logs "timeout" --level error --period 6h --project backend
bb sentry logs --trace 4f2a... --period 7d
```

## Notes

- GlitchTip uses explicit `start`/`end`; `--period` is converted for it.
- GlitchTip caps `--limit` at 200 per page; Sentry allows 1000.
- GlitchTip's single-event endpoint takes the project **slug** in its URL
  (`/projects/{org}/{slug}/events/{id}/`), not a numeric project id. The plugin
  maps a numeric id back to its slug automatically, so `--project 20` and
  `--project ios` both work.
- On GlitchTip, `bb sentry issue <short-id>` (e.g. `IOS-19J`) is unsupported —
  pass the numeric issue id or the issue URL instead.
- GlitchTip implements only an `is:`/`level:` subset of the query language — if
  a query returns something surprising, simplify it rather than trusting the
  filter.
- The bb-plugin-sentry nav panel mirrors these commands in the sidebar.
