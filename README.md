# bb-plugin-sentry

Browse Sentry / GlitchTip issues, stack traces, events, and logs from BB.

- `server.ts` — the backend. Resolves the connection (bb settings →
  `SENTRY_*` env → `~/.sentryclirc`), keeps the auth token on the server,
  and exposes every query as RPC plus a `bb sentry` CLI.
- `lib/sentry.ts` — the typed Sentry/GlitchTip API client (issues, event,
  latest event, logs, projects), ported from the `sentry` skill.
- `app.tsx` — the frontend: a **Sentry** page in the left sidebar
  (`app.slots.navPanel`) that filters issues and drills into one issue's
  stack trace and latest event, plus a **Connection** settings section.
- `skills/sentry/SKILL.md` — a skill that tells agents how to query with
  `bb sentry`.
- `PLUGIN_OVERVIEW.md` — the store listing text.

Try it: install the plugin, open **Sentry** in the sidebar and pick a project.
Then run `bb sentry issues --status unresolved --period 24h` in a terminal.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the BB
component registry:

```
npx shadcn add @bb/select @bb/table
```

Run `npm install` once before `bb plugin build` — the vendored components'
npm deps bundle into your dist. React, and BB-shimmed packages like the
radix portal primitives and `sonner`, are provided by the BB app at runtime
and never bundled. Every shimmed package is declared in `devDependencies` at
the host's version; keep them there and let `bb plugin types` repin them.
Ship `dist/` so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `bb.server` — backend entry (required).
- `bb.app` — frontend entry.
- `bb.skills` — skill roots; omitted here, so BB reads `skills/`.
- `bb.name` and `bb.description` — required human-facing identity.
- `bb.branding` — required; `icon` is a BB icon name (`Bug`).
- `engines.bb` / `engines.bbPluginSdk` — supported ranges.
- `dependencies` — packages BB does not provide; `devDependencies` is for
  types and tooling only.

Run `bb plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` and `app.js` / `app.css` /
`app.meta.json`.

## Store listing

`bb.description` is the one-sentence hook on every browse card; keep it under
about 140 characters. `PLUGIN_OVERVIEW.md` is the same claim at length, shown
in an Overview section. Keep the two in sync.

## Install

```
npm install
bb plugin install .
bb plugin reload sentry
```

## Configure

Connection is resolved from bb settings → env → `~/.sentryclirc`. Edit the
plugin's settings in **Extensions → Plugins → Sentry**, or per install:

```
bb plugin config sentry
bb plugin config sentry set org myorg
bb plugin reload sentry
```

## Types & API reference

The plugin API ships as `@get-bb/plugin-sdk`, pinned to an exact version in
`devDependencies` (`0.4.47`). Readable declarations:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

Ask BB to write plugins for you: the `bb-plugin-authoring` skill documents
the whole surface. Clone the BB repo for anything the types don't explain:
<https://github.com/get-bb/bb>.
