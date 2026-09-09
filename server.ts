// bb-plugin-sentry — backend entry.
//
// Holds the connection and every Sentinel/GlitchTip call: the frontend never
// sees a token and never talks to a Sentry host directly. app.tsx reaches this
// over the RPC contract below; `bb sentry` reaches the same helpers from a
// shell.
//
// Connection config resolution (highest first): bb settings → environment
// (SENTRY_URL / SENTRY_AUTH_TOKEN / SENTRY_BACKEND) → ~/.sentryclirc. The token
// may come from a secret setting, SENTRY_AUTH_TOKEN, or the home rc file — it
// is never echoed to the frontend or to CLI output.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  checkConnection,
  fetchEvent,
  fetchIssue,
  fetchLatestEvent,
  listIssues,
  listProjects,
  resolveConfig,
  searchLogs,
  formatTimestamp,
  type SentryConfig,
  type SentryEvent,
  type SentryIssue,
  type SentryLog,
} from "./lib/sentry";
import { detail, table } from "./lib/format";

// ---------------------------------------------------------------------------
// Wire schemas (run at the RPC boundary; frontend imports only the types).
// ---------------------------------------------------------------------------

const issueSchema = z.object({
  id: z.string(),
  shortId: z.string().nullable(),
  title: z.string(),
  level: z.string(),
  status: z.string(),
  culprit: z.string().nullable(),
  count: z.number(),
  userCount: z.number(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  permalink: z.string().nullable(),
  project: z.object({ slug: z.string().nullable() }).nullable(),
  metadata: z
    .object({ type: z.string().nullable(), value: z.string().nullable() })
    .nullable(),
  tags: z.array(
    z.object({
      key: z.string(),
      topValues: z.array(
        z.object({ value: z.string().nullable(), count: z.number() }),
      ),
    }),
  ),
});

const eventSchema = z.object({
  eventID: z.string().nullable(),
  id: z.string().nullable(),
  title: z.string().nullable(),
  message: z.string().nullable(),
  dateCreated: z.string().nullable(),
  project: z.string().nullable(),
  tags: z.array(z.object({ key: z.string(), value: z.string() })),
  contexts: z
    .record(
      z.string(),
      z.object({
        name: z.string().nullable(),
        version: z.string().nullable(),
        family: z.string().nullable(),
        traceId: z.string().nullable(),
        spanId: z.string().nullable(),
        op: z.string().nullable(),
        status: z.string().nullable(),
      }),
    )
    .nullable(),
  entries: z.array(
    z
      .object({ type: z.string().nullable(), data: z.unknown().nullable() })
      .nullable(),
  ),
});

const logSchema = z.object({
  timestamp: z.string().nullable(),
  level: z.string(),
  message: z.string(),
  trace: z.string().nullable(),
  service: z.string().nullable(),
  environment: z.string().nullable(),
  host: z.string().nullable(),
  raw: z.unknown(),
});

const projectSchema = z.object({
  slug: z.string(),
  id: z.string(),
  name: z.string().nullable(),
});

const configInfoSchema = z.object({
  rootUrl: z.string(),
  backend: z.enum(["sentry", "glitchtip"]),
  org: z.string(),
  projects: z.array(z.string()),
  hasToken: z.boolean(),
  ready: z.boolean(),
});

export type BoardIssue = SentryIssue;
export type BoardEvent = SentryEvent;
export type BoardLog = SentryLog;

const issuesListInput = z
  .object({
    query: z.string().optional(),
    status: z.string().optional(),
    level: z.string().optional(),
    period: z.string().optional(),
    sort: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    project: z.string().optional(),
    cursor: z.string().optional(),
  })
  .strict();

const issueGetInput = z
  .object({ value: z.string().min(1), withLatest: z.boolean().optional() })
  .strict();

const eventGetInput = z
  .object({ eventId: z.string().min(1), project: z.string().optional() })
  .strict();

const logsSearchInput = z
  .object({
    query: z.string().optional(),
    level: z.string().optional(),
    period: z.string().optional(),
    project: z.string().optional(),
    trace: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  config_get: {
    input: z.null(),
    output: configInfoSchema,
  },
  config_test: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  projects_list: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSchema) }),
  },
  issues_list: {
    input: issuesListInput,
    output: z.object({
      issues: z.array(issueSchema),
      nextCursor: z.string().nullable(),
    }),
  },
  issue_get: {
    input: issueGetInput,
    output: z.object({ issue: issueSchema, event: eventSchema.nullable() }),
  },
  event_get: {
    input: eventGetInput,
    output: z.object({ event: eventSchema }),
  },
  logs_search: {
    input: logsSearchInput,
    output: z.object({ logs: z.array(logSchema) }),
  },
});

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    url: {
      type: "string",
      label: "Server URL",
      description:
        "Sentry or GlitchTip root. Blank uses ~/.sentryclirc or SENTRY_URL.",
      default: "",
    },
    org: {
      type: "string",
      label: "Org slug",
      description: "Overrides ~/.sentryclirc's [defaults] org.",
      default: "",
    },
    project: {
      type: "string",
      label: "Default project",
      description: "Overrides ~/.sentryclirc's [defaults] project.",
      default: "",
    },
    backend: {
      type: "select",
      label: "Backend",
      description:
        "sentry.io and *.sentry.io are auto-detected; self-hosted Sentry needs 'sentry'.",
      options: ["auto", "sentry", "glitchtip"],
      default: "auto",
    },
    token: {
      type: "string",
      label: "Auth token",
      description:
        "Secret. Blank uses SENTRY_AUTH_TOKEN or ~/.sentryclirc [auth] token.",
      secret: true,
    },
  });

  /** Merge bb settings overrides on top of env + ~/.sentryclirc. */
  async function currentConfig(): Promise<SentryConfig> {
    const values = await settings.get();
    return resolveConfig({
      url: values.url === "" ? undefined : values.url,
      org: values.org === "" ? undefined : values.org,
      project: values.project === "" ? undefined : values.project,
      backend:
        values.backend === "" || values.backend === "auto"
          ? undefined
          : values.backend,
      token: values.token === "" ? undefined : values.token,
    });
  }

  async function requireConfig(): Promise<SentryConfig> {
    const config = await currentConfig();
    if (config.token === "") {
      throw new Error(
        "No Sentry auth token. Set SENTRY_AUTH_TOKEN, add a token to ~/.sentryclirc, or set the Auth token in this plugin's settings.",
      );
    }
    if (config.org === "") {
      throw new Error(
        "No Sentry org slug. Set one in ~/.sentryclirc [defaults] org or in this plugin's settings.",
      );
    }
    return config;
  }

  function toInfo(config: SentryConfig) {
    return {
      rootUrl: config.rootUrl,
      backend: config.backend,
      org: config.org,
      projects: config.projects,
      hasToken: config.token !== "",
      ready: config.token !== "" && config.org !== "",
    };
  }

  async function requireConfigSafe(): Promise<ReturnType<typeof toInfo>> {
    try {
      return toInfo(await currentConfig());
    } catch (cause) {
      bb.log.warn(
        `config: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return {
        rootUrl: "",
        backend: "glitchtip",
        org: "",
        projects: [],
        hasToken: false,
        ready: false,
      };
    }
  }

  const configured = await requireConfigSafe();
  if (!configured.ready) {
    bb.status.needsConfiguration(
      "Set an org slug and an auth token (in ~/.sentryclirc, SENTRY_* env, or this plugin's settings) to browse Sentry issues.",
    );
  }

  function projectList(config: SentryConfig, requested?: string): string[] {
    if (requested && requested.trim() !== "") return [requested.trim()];
    return config.projects;
  }

  bb.rpc.register(rpcContract, {
    config_get: async () => toInfo(await currentConfig()),

    config_test: async () => {
      try {
        return await checkConnection(await requireConfig());
      } catch (cause) {
        return {
          ok: false,
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },

    projects_list: async () => {
      const config = await requireConfig();
      return { projects: await listProjects(config) };
    },

    issues_list: async ({
      query,
      status,
      level,
      period,
      sort,
      limit,
      project,
      cursor,
    }) => {
      const config = await requireConfig();
      const projects = projectList(config, project);
      const { issues, nextCursor } = await listIssues(config, {
        query,
        status,
        level,
        period: period ?? "24h",
        sort,
        limit: limit ?? 25,
        projects,
        cursor,
      });
      return { issues, nextCursor };
    },

    issue_get: async ({ value, withLatest }) => {
      const config = await requireConfig();
      const issue = await fetchIssue(config, { value });
      if (withLatest) {
        const event = await fetchLatestEvent(config, issue.id);
        return { issue, event };
      }
      return { issue, event: null };
    },

    event_get: async ({ eventId, project }) => {
      const config = await requireConfig();
      const target = projectList(config, project)[0];
      const event = await fetchEvent(config, eventId, target);
      return { event };
    },

    logs_search: async ({ query, level, period, project, trace, limit }) => {
      const config = await requireConfig();
      const logs = await searchLogs(config, {
        query,
        level,
        period: period ?? "24h",
        projects: projectList(config, project),
        trace,
        limit: limit ?? 100,
      });
      return { logs };
    },
  });

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  const usage = [
    "Usage: bb sentry <command> [options]",
    "",
    "Commands:",
    "  config                      Show the resolved connection (no token)",
    "  test                        Verify the token against the org",
    "  projects                    List the org's projects",
    "  issues                      List issues (filters below)",
    "  issue <id|url>              Show one issue (--latest attaches the newest event)",
    "  event <event-id>            Show one event by id",
    "  logs [query]                Search logs",
    "",
    "Filters (issues): --status --level --period --sort --limit --query --project --cursor",
    "Filters (logs):   --level --period --trace --limit --project",
    "Global:           --json",
    "",
    "Examples:",
    "  bb sentry issues --status unresolved --level error --period 24h",
    "  bb sentry issue 5765604106 --latest",
    "  bb sentry issue https://glitchtip.example.com/myorg/issues/42",
    "  bb sentry logs timeout --level error --period 6h",
  ].join("\n");

  function formatIssue(issue: BoardIssue): string {
    const lines: string[] = [];
    lines.push(`[${issue.shortId || issue.id}] ${issue.title}`);
    lines.push(
      `  level: ${issue.level} | status: ${issue.status} | project: ${issue.project?.slug ?? "?"}`,
    );
    lines.push(`  events: ${issue.count} | users: ${issue.userCount}`);
    lines.push(
      `  first: ${formatTimestamp(issue.firstSeen)} | last: ${formatTimestamp(issue.lastSeen)}`,
    );
    if (issue.culprit) lines.push(`  culprit: ${issue.culprit}`);
    if (issue.permalink) lines.push(`  url: ${issue.permalink}`);
    return lines.join("\n");
  }

  function formatStacktrace(frames: unknown, maxFrames = 20): string {
    const list = (Array.isArray(frames) ? frames : []) as Array<{
      filename?: string;
      absPath?: string;
      module?: string;
      function?: string;
      lineNo?: number;
      lineno?: number;
      colNo?: number;
      context_line?: string;
      inApp?: boolean;
    }>;
    if (list.length === 0) return "  (no frames)";
    const appFrames = list.filter((frame) => frame.inApp !== false);
    const toShow = (appFrames.length > 0 ? appFrames : list).slice(
      0,
      maxFrames,
    );
    return toShow
      .map((frame, index) => {
        const file =
          frame.filename || frame.absPath || frame.module || "unknown";
        const fn = frame.function || "(anonymous)";
        const line = frame.lineNo ?? frame.lineno;
        const loc = line ? `:${line}` : "";
        let out = `  ${index + 1}. ${file}${loc}\n     → ${fn}`;
        if (frame.context_line) out += `\n     | ${frame.context_line.trim()}`;
        return out;
      })
      .join("\n\n");
  }

  function formatBreadcrumbs(values: unknown): string {
    const crumbs = (Array.isArray(values) ? values : []).slice(-15) as Array<{
      timestamp?: number | string;
      category?: string;
      type?: string;
      level?: string;
      message?: string;
      data?: Record<string, unknown> | string;
    }>;
    const timeOf = (ts: number | string | undefined) => {
      if (ts === undefined) return "??:??:??";
      const date = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
      return Number.isNaN(date.getTime())
        ? "??:??:??"
        : date.toISOString().slice(11, 19);
    };
    return crumbs
      .map((crumb) => {
        let msg = crumb.message || "";
        if (msg === "" && crumb.data) {
          if (typeof crumb.data === "object" && crumb.data !== null) {
            msg =
              typeof crumb.data.url === "string"
                ? crumb.data.url
                : JSON.stringify(crumb.data);
          } else {
            msg = String(crumb.data);
          }
        }
        const cat = crumb.category ?? crumb.type ?? "?";
        const level =
          crumb.level && crumb.level !== "info" ? `[${crumb.level}] ` : "";
        return `  [${timeOf(crumb.timestamp)}] ${level}${cat}: ${msg}`;
      })
      .join("\n");
  }

  function formatEvent(event: BoardEvent): string {
    const lines: string[] = [];
    lines.push(`# Event: ${event.eventID || event.id}`);
    lines.push(`Timestamp: ${formatTimestamp(event.dateCreated)}`);
    if (event.project) lines.push(`Project: ${event.project}`);
    if (event.title) lines.push(`Title: ${event.title}`);
    if (event.message) lines.push(`Message: ${event.message}`);
    if (event.tags.length > 0) {
      lines.push("Tags:");
      for (const tag of event.tags) lines.push(`  ${tag.key}: ${tag.value}`);
    }
    if (event.contexts) {
      const ctx = event.contexts;
      const lines2: string[] = [];
      if (ctx.runtime)
        lines2.push(
          `Runtime: ${ctx.runtime.name ?? "?"} ${ctx.runtime.version ?? ""}`,
        );
      if (ctx.browser)
        lines2.push(
          `Browser: ${ctx.browser.name ?? "?"} ${ctx.browser.version ?? ""}`,
        );
      if (ctx.os)
        lines2.push(`OS: ${ctx.os.name ?? "?"} ${ctx.os.version ?? ""}`);
      if (ctx.trace) lines2.push(`Trace: ${ctx.trace.traceId ?? "?"}`);
      if (lines2.length > 0) {
        lines.push("Context:");
        lines.push(...lines2.map((line) => `  ${line}`));
      }
    }
    for (const entry of event.entries) {
      const row = entry as {
        type?: string | null;
        data?: Record<string, unknown> | null;
      } | null;
      if (!row || !row.type || !row.data) continue;
      if (row.type === "request") {
        if (
          typeof row.data.method === "string" &&
          typeof row.data.url === "string"
        ) {
          lines.push(`Request: ${row.data.method} ${row.data.url}`);
        }
      } else if (row.type === "exception") {
        const values = (
          Array.isArray(row.data.values) ? row.data.values : []
        ) as Array<Record<string, unknown>>;
        for (const exc of values) {
          const type = typeof exc.type === "string" ? exc.type : "Error";
          const value =
            typeof exc.value === "string" ? exc.value : "(no message)";
          lines.push("Exception:");
          lines.push(`  **${type}:** ${value}`);
          if (typeof exc.stacktrace === "object" && exc.stacktrace !== null) {
            lines.push(
              formatStacktrace(
                (exc.stacktrace as Record<string, unknown>).frames,
              ),
            );
          }
        }
      } else if (row.type === "message") {
        if (typeof row.data.formatted === "string") {
          lines.push(`Message: ${row.data.formatted}`);
        }
      } else if (row.type === "breadcrumbs") {
        const crumbs = formatBreadcrumbs(row.data.values);
        if (crumbs !== "") {
          lines.push("Breadcrumbs:");
          lines.push(crumbs);
        }
      }
    }
    return lines.join("\n");
  }

  function formatLog(log: BoardLog): string {
    const ts = log.timestamp
      ? new Date(log.timestamp).toISOString().replace("T", " ").slice(0, 19)
      : "N/A";
    const severity = `[${log.level.toUpperCase().padEnd(5)}]`;
    let out = `${ts} ${severity} ${log.message}`;
    const meta: string[] = [];
    if (log.service) meta.push(`service: ${log.service}`);
    if (log.environment) meta.push(`env: ${log.environment}`);
    if (log.host) meta.push(`host: ${log.host}`);
    if (log.trace) meta.push(`trace: ${log.trace}`);
    if (meta.length > 0) out += `\n  ${meta.join(" | ")}`;
    return out;
  }

  bb.cli.register({
    name: "sentry",
    summary: "Browse Sentry / GlitchTip issues and logs",
    commands: [
      {
        name: "config",
        summary: "Show the resolved connection",
        usage: "bb sentry config [--json]",
      },
      {
        name: "test",
        summary: "Verify the token against the org",
        usage: "bb sentry test [--json]",
      },
      {
        name: "projects",
        summary: "List the org's projects",
        usage: "bb sentry projects [--json]",
      },
      {
        name: "issues",
        summary: "List issues",
        usage: "bb sentry issues [filters] [--json]",
      },
      {
        name: "issue",
        summary: "Show one issue",
        usage: "bb sentry issue <id|url> [--latest] [--json]",
      },
      {
        name: "event",
        summary: "Show one event",
        usage: "bb sentry event <event-id> [--project <p>] [--json]",
      },
      {
        name: "logs",
        summary: "Search logs",
        usage: "bb sentry logs [query] [filters] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");

      /** Parse one named flag with a value, stripping it from the token list. */
      function takeValue(
        args: string[],
        flag: string,
      ): { value: string | null; rest: string[] } {
        const index = args.indexOf(flag);
        if (index === -1) return { value: null, rest: args };
        const value = args[index + 1] ?? null;
        return {
          value,
          rest: args.filter((_, i) => i !== index && i !== index + 1),
        };
      }

      /** Parse a boolean flag, stripping it from the token list. */
      function takeFlag(
        args: string[],
        flag: string,
      ): { present: boolean; rest: string[] } {
        const present = args.includes(flag);
        return { present, rest: args.filter((arg) => arg !== flag) };
      }

      const [command, ...raw] = argv.filter((arg) => arg !== "--json");
      const { rest, value: queryValue } = takeValue(raw, "--query");
      const { rest: r1, value: status } = takeValue(rest, "--status");
      const { rest: r2, value: level } = takeValue(r1, "--level");
      const { rest: r3, value: period } = takeValue(r2, "--period");
      const { rest: r4, value: sort } = takeValue(r3, "--sort");
      const { rest: r5, value: limitStr } = takeValue(r4, "--limit");
      const { rest: r6, value: project } = takeValue(r5, "--project");
      const { rest: r7, value: trace } = takeValue(r6, "--trace");
      const { rest: r8, value: eventIdFlag } = takeValue(r7, "--event-id");
      const { rest: r9, value: cursor } = takeValue(r8, "--cursor");
      const { present: latest, rest: r10 } = takeFlag(r9, "--latest");
      const limit = limitStr === null ? undefined : parseInt(limitStr, 10);
      const positional = r10.filter((arg) => arg !== "");

      /** The connection, with a friendly error if it is not ready. */
      function config(): Promise<SentryConfig> {
        return requireConfig();
      }

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };

          case "config": {
            const info = toInfo(await currentConfig());
            if (json) return { exitCode: 0, stdout: JSON.stringify(info) };
            return {
              exitCode: 0,
              stdout: detail([
                ["Server", info.rootUrl],
                ["Backend", info.backend],
                ["Org", info.org === "" ? "(none)" : info.org],
                ["Projects", info.projects.join(", ") || "(none)"],
                ["Token", info.hasToken ? "set" : "missing"],
              ]),
            };
          }

          case "test": {
            const result = await checkConnection(await config());
            if (json)
              return {
                exitCode: result.ok ? 0 : 1,
                stdout: JSON.stringify(result),
              };
            return {
              exitCode: result.ok ? 0 : 1,
              stdout: result.ok ? result.message : `Failed: ${result.message}`,
            };
          }

          case "projects": {
            const projects = await listProjects(await config());
            if (json) return { exitCode: 0, stdout: JSON.stringify(projects) };
            return {
              exitCode: 0,
              stdout: table(
                ["slug", "name", "id"],
                projects.map((p) => [p.slug, p.name ?? "", p.id]),
                "No projects.",
              ),
            };
          }

          case "issues": {
            const { issues, nextCursor } = await listIssues(await config(), {
              query: queryValue ?? undefined,
              status: status ?? undefined,
              level: level ?? undefined,
              period: period ?? "24h",
              sort: sort ?? undefined,
              limit,
              projects: project ? [project] : undefined,
              cursor: cursor ?? undefined,
            });
            if (json)
              return {
                exitCode: 0,
                stdout: JSON.stringify({ issues, nextCursor }),
              };
            const body = table(
              ["id", "level", "events", "project", "last", "title"],
              issues.map((issue) => [
                issue.shortId || issue.id,
                issue.level,
                issue.count,
                issue.project?.slug ?? "?",
                formatTimestamp(issue.lastSeen),
                issue.title,
              ]),
              "No issues found matching your query.",
            );
            const more =
              nextCursor === null
                ? ""
                : `\n\n(${issues.length} shown — pass --cursor ${nextCursor} for the next page.)`;
            return { exitCode: 0, stdout: body + more };
          }

          case "issue": {
            const value = positional[0] ?? eventIdFlag;
            if (!value)
              return { exitCode: 1, stderr: "bb sentry issue <id|url>" };
            const issueCfg = await config();
            const issue = await fetchIssue(issueCfg, { value });
            const event = latest
              ? await fetchLatestEvent(issueCfg, issue.id)
              : null;
            if (json)
              return { exitCode: 0, stdout: JSON.stringify({ issue, event }) };
            let out = formatIssue(issue);
            if (event) out += `\n\n${formatEvent(event)}`;
            return { exitCode: 0, stdout: out };
          }

          case "event": {
            const value = positional[0] ?? eventIdFlag;
            if (!value)
              return { exitCode: 1, stderr: "bb sentry event <event-id>" };
            const cfg = await config();
            const target = project ?? cfg.projects[0];
            if (!target)
              return {
                exitCode: 1,
                stderr: "No project set. Pass --project <slug>.",
              };
            const event = await fetchEvent(cfg, value, target);
            if (json) return { exitCode: 0, stdout: JSON.stringify(event) };
            return { exitCode: 0, stdout: formatEvent(event) };
          }

          case "logs": {
            const query = queryValue ?? positional[0];
            const logs = await searchLogs(await config(), {
              query: query,
              level: level ?? undefined,
              period: period ?? "24h",
              projects: project ? [project] : undefined,
              trace: trace ?? undefined,
              limit,
            });
            if (json) return { exitCode: 0, stdout: JSON.stringify(logs) };
            if (logs.length === 0)
              return {
                exitCode: 0,
                stdout: "No logs found matching your query.",
              };
            return {
              exitCode: 0,
              stdout: `Found ${logs.length} log entries:\n\n${logs.map(formatLog).join("\n")}`,
            };
          }
        }
      } catch (cause) {
        return {
          exitCode: 1,
          stderr: cause instanceof Error ? cause.message : String(cause),
        };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
