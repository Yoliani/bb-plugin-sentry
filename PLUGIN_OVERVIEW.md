See your Sentry or GlitchTip errors where you already work: a sidebar panel
that lists issues and drills into a stack trace, plus a `bb sentry` command for
the terminal and for agents.

## What you get

- A **Sentry** page in the left sidebar. Pick a project and period, filter by
  status and level, search, then open an issue to see its latest event: stack
  trace, request, tags, runtime context, and breadcrumbs.
- A **Connection** settings section that shows the resolved endpoint and tests
  the token.
- A `bb sentry` CLI that mirrors the skill scripts: `config`, `test`,
  `projects`, `issues`, `issue`, `event`, and `logs`, all with `--json`.

## How it works

The connection is resolved from bb settings, then `SENTRY_URL` /
`SENTRY_AUTH_TOKEN` / `SENTRY_BACKEND`, then `~/.sentryclirc`. It auto-detects
Sentry vs GlitchTip from the URL and speaks each backend's quirks (period,
sorting, query syntax, log limits). The auth token never leaves the server: the
frontend talks to your Sentry host only through this plugin's RPC.

## For agents

The bundled `sentry` skill tells an agent how to query with `bb sentry` —
listing recent errors, fetching an issue with its latest event, and searching
logs — so a debugging agent can pull the error story itself.
