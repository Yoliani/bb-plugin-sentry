// bb-plugin-sentry — Sentry / GlitchTip API client.
//
// This mirrors the `sentry` skill (adapted from mitsuhiko/agent-stuff,
// Apache-2.0) so the plugin surfaces the same data the skill does. Where the
// skill reads config from CLI flags / env / ~/.sentryclirc per process, this
// module resolves config once from env + the home rc file, and `server.ts`
// layers bb setting overrides on top (which win over everything, matching the
// skill's "CLI flags → env → rc" precedence with settings standing in for the
// flags).
//
// The plugin server runs in the bb daemon, not in a project directory, so it
// reads the home `~/.sentryclirc` only — it cannot layer a repo-local
// `.sentryclirc` on top the way the skill can (there is no repo cwd). Use the
// settings panel (server.ts) to override org/project/url/backend per install
// instead.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "https://sentry.io/";

export interface SentryConfig {
  /** Web root, e.g. https://sentry.io or https://glitchtip.example.com */
  rootUrl: string;
  /** `${rootUrl}/api/0` */
  apiBase: string;
  backend: "sentry" | "glitchtip";
  isGlitchTip: boolean;
  token: string;
  org: string;
  /** Project slugs/ids to scope queries to (defaults from rc). */
  projects: string[];
}

export interface RcConfig {
  url: string | null;
  org: string | null;
  project: string | null;
  backend: string | null;
  token: string | null;
}

interface Overrides {
  url?: string;
  org?: string;
  project?: string;
  backend?: string;
  token?: string;
}

interface RawIssue {
  id: string;
  shortId?: string | null;
  title?: string | null;
  level?: string | null;
  status?: string | null;
  culprit?: string | null;
  count?: number | null;
  userCount?: number | null;
  firstSeen?: string | null;
  lastSeen?: string | null;
  permalink?: string | null;
  project?: { slug?: string | null; name?: string | null } | null;
  metadata?: {
    type?: string | null;
    value?: string | null;
    [key: string]: unknown;
  } | null;
  tags?: Array<{
    key?: string | null;
    topValues?: Array<{ value?: string | null; count?: number | null }> | null;
  }> | null;
}

export interface SentryIssue {
  id: string;
  shortId: string | null;
  title: string;
  level: string;
  status: string;
  culprit: string | null;
  count: number;
  userCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  permalink: string | null;
  project: { slug: string | null } | null;
  metadata: { type: string | null; value: string | null } | null;
  tags: Array<{
    key: string;
    topValues: Array<{ value: string | null; count: number }>;
  }>;
}

interface RawTag {
  key?: string | null;
  value?: string | null;
}

interface RawEvent {
  eventID?: string | null;
  id?: string | null;
  title?: string | null;
  message?: string | null;
  dateCreated?: string | null;
  timestamp?: string | null;
  projectID?: string | null;
  projectSlug?: string | null;
  tags?: RawTag[] | null;
  contexts?: Record<
    string,
    {
      name?: string | null;
      version?: string | null;
      family?: string | null;
      trace_id?: string | null;
      span_id?: string | null;
      op?: string | null;
      status?: string | null;
    } | null
  > | null;
  context?: Record<
    string,
    { name?: string | null; version?: string | null; family?: string | null }
  > | null;
  entries?: Array<{ type?: string | null; data?: unknown } | null> | null;
}

export interface SentryEvent {
  eventID: string | null;
  id: string | null;
  title: string | null;
  message: string | null;
  dateCreated: string | null;
  project: string | null;
  tags: Array<{ key: string; value: string }>;
  contexts: Record<
    string,
    {
      name: string | null;
      version: string | null;
      family: string | null;
      traceId: string | null;
      spanId: string | null;
      op: string | null;
      status: string | null;
    }
  > | null;
  /** Raw entries (request / exception / message / breadcrumbs / spans). */
  entries: Array<{ type: string | null; data: unknown } | null>;
}

export interface SentryLog {
  timestamp: string | null;
  level: string;
  message: string;
  trace: string | null;
  service: string | null;
  environment: string | null;
  host: string | null;
  raw: unknown;
}

export interface IssueListOptions {
  query?: string;
  status?: string;
  level?: string;
  period?: string;
  sort?: string;
  limit?: number;
  projects?: string[];
  /** Opaque pagination cursor from a previous page's nextCursor. */
  cursor?: string;
}

export interface LogsSearchOptions {
  query?: string;
  level?: string;
  period?: string;
  projects?: string[];
  trace?: string;
  limit?: number;
}

export interface IssueInput {
  /** Numeric id, short id (PROJECT-ABC), or an issue URL. */
  value: string;
}

// ---------------------------------------------------------------------------
// ~/.sentryclirc parsing (INI-ish), ported from the skill's lib/api.js.
// ---------------------------------------------------------------------------

type RcSections = Record<string, Record<string, string>>;

function parseRc(content: string): RcSections {
  const sections: RcSections = { "": {} };
  let current = "";
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      sections[current] = sections[current] ?? {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    sections[current][key] = value;
  }
  return sections;
}

function mergeRc(sources: RcSections[]): RcSections {
  const merged: RcSections = {};
  for (const source of sources) {
    for (const [section, values] of Object.entries(source)) {
      merged[section] = { ...merged[section], ...values };
    }
  }
  return merged;
}

/** Read the home ~/.sentryclirc, if it exists. No repo-local layer here. */
function loadRc(): RcSections {
  const path = join(homedir(), ".sentryclirc");
  if (!existsSync(path)) return {};
  try {
    return parseRc(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function detectBackend(rootUrl: string): "sentry" | "glitchtip" {
  try {
    const host = new URL(rootUrl).hostname;
    if (host === "sentry.io" || host.endsWith(".sentry.io")) return "sentry";
  } catch {
    // fall through
  }
  return "glitchtip";
}

export function parsePeriod(period: string): string | null {
  const match = String(period).match(/^(\d+)([mhdw])$/);
  if (!match) return null;
  const units: Record<string, number> = { m: 60, h: 3600, d: 86400, w: 604800 };
  const seconds = parseInt(match[1], 10) * units[match[2]];
  return new Date(Date.now() - seconds * 1000).toISOString();
}

export function formatTimestamp(
  ts: string | number | null | undefined,
): string {
  if (!ts) return "N/A";
  try {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return String(ts);
    return date.toLocaleString();
  } catch {
    return String(ts);
  }
}

/**
 * Resolve the effective config. Precedence, highest first: overrides (bb
 * settings) → environment → ~/.sentryclirc. The token is only ever read here
 * (or from a secret setting via `token`).
 */
export function resolveConfig(overrides: Overrides = {}): SentryConfig {
  const rc = loadRc();
  const rcDefaults = rc.defaults ?? {};
  const rcAuth = rc.auth ?? {};

  const rootUrl = (
    overrides.url ||
    process.env.SENTRY_URL ||
    rcDefaults.url ||
    DEFAULT_URL
  ).replace(/\/+$/, "");

  const explicitBackend =
    overrides.backend || process.env.SENTRY_BACKEND || rcDefaults.backend;
  const backend = explicitBackend
    ? (explicitBackend.toLowerCase() as "sentry" | "glitchtip")
    : detectBackend(rootUrl);

  const token = (
    overrides.token ||
    process.env.SENTRY_AUTH_TOKEN ||
    rcAuth.token ||
    ""
  ).trim();

  const org = (overrides.org || rcDefaults.org || "").trim();
  const defaultProject = (overrides.project || rcDefaults.project || "").trim();
  const projects = defaultProject === "" ? [] : [defaultProject];

  return {
    rootUrl,
    apiBase: `${rootUrl}/api/0`,
    backend,
    isGlitchTip: backend === "glitchtip",
    token,
    org,
    projects,
  };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

export async function fetchJson<T = unknown>(
  url: string,
  token: string,
): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sentry API error ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

interface JsonResponse<T> {
  data: T;
  link: string | null;
}

/** Like fetchJson, but also returns the raw Link header for pagination. */
async function fetchJsonWithHeaders<T = unknown>(
  url: string,
  token: string,
): Promise<JsonResponse<T>> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sentry API error ${res.status}: ${text.slice(0, 500)}`);
  }
  return { data: (await res.json()) as T, link: res.headers.get("link") };
}

/**
 * Pull the pagination cursor for `rel="next"` from an RFC 5988 Link header.
 * Sentry and GlitchTip both advertise the next page this way. Returns null
 * when there is no next page, or the header is absent.
 */
function nextCursorFromLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const cursor = part.match(/cursor="([^"]+)"/);
    const next = part.match(/rel="next"/);
    if (cursor && next) return cursor[1];
  }
  return null;
}

const projectIdCache = new Map<string, string>();

export async function resolveProjectId(
  config: SentryConfig,
  project: string,
): Promise<string> {
  if (/^\d+$/.test(project)) return project;
  const cacheKey = `${config.org}/${project}`;
  const cached = projectIdCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const url = `${config.apiBase}/projects/${encodeURIComponent(config.org)}/${encodeURIComponent(project)}/`;
  const data = await fetchJson<{ id?: string }>(url, config.token);
  if (!data || !data.id) {
    throw new Error(
      `Project '${project}' not found in organization '${config.org}'`,
    );
  }
  const id = String(data.id);
  projectIdCache.set(cacheKey, id);
  return id;
}

/**
 * Map a project identifier to the slug the /projects/{org}/{project}/events/ path
 * expects. Sentry and GlitchTip use the *slug* in that path, while issue-list
 * queries accept a numeric id — so a numeric id here must be mapped back to its
 * slug. A non-numeric value is assumed to already be a slug and returned as-is.
 */
export async function resolveProjectSlug(
  config: SentryConfig,
  project: string,
): Promise<string> {
  if (!/^\d+$/.test(project)) return project;
  const projects = await listProjects(config);
  const match = projects.find((p) => p.id === project);
  if (match?.slug) return match.slug;
  return project; // fall back to the raw id; the API will 404 if it is wrong
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

const toNumber = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toIso = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return new Date(v * 1000).toISOString();
  return null;
};

function normalizeIssue(raw: RawIssue): SentryIssue {
  const topValues = (raw.tags ?? []).map((tag) => ({
    key: tag.key ?? "",
    topValues: (tag.topValues ?? []).map((top) => ({
      value: top.value ?? null,
      count: toNumber(top.count),
    })),
  }));
  return {
    id: raw.id,
    shortId: raw.shortId ?? null,
    title: raw.title ?? "(no title)",
    level: raw.level ?? "?",
    status: raw.status ?? "?",
    culprit: raw.culprit ?? null,
    count: toNumber(raw.count),
    userCount: toNumber(raw.userCount),
    firstSeen: toIso(raw.firstSeen),
    lastSeen: toIso(raw.lastSeen),
    permalink: raw.permalink ?? null,
    project: raw.project?.slug ? { slug: raw.project.slug } : null,
    metadata: raw.metadata
      ? { type: raw.metadata.type ?? null, value: raw.metadata.value ?? null }
      : null,
    tags: topValues,
  };
}

function normalizeEvent(raw: RawEvent): SentryEvent {
  const tags = (raw.tags ?? [])
    .map((tag) => ({ key: tag.key ?? "", value: tag.value ?? "" }))
    .filter((tag) => tag.key !== "");
  const contexts: SentryEvent["contexts"] = {};
  if (raw.contexts) {
    for (const [key, value] of Object.entries(raw.contexts)) {
      if (!value) continue;
      contexts[key] = {
        name: value.name ?? null,
        version: value.version ?? null,
        family: value.family ?? null,
        traceId: value.trace_id ?? null,
        spanId: value.span_id ?? null,
        op: value.op ?? null,
        status: value.status ?? null,
      };
    }
  } else if (raw.context) {
    for (const [key, value] of Object.entries(raw.context)) {
      if (!value) continue;
      contexts[key] = {
        name: value.name ?? null,
        version: value.version ?? null,
        family: value.family ?? null,
        traceId: null,
        spanId: null,
        op: null,
        status: null,
      };
    }
  }
  return {
    eventID: raw.eventID ?? null,
    id: raw.id ?? null,
    title: raw.title ?? null,
    message: raw.message ?? null,
    dateCreated: toIso(raw.dateCreated ?? raw.timestamp),
    project: raw.projectSlug || (raw.projectID != null ? String(raw.projectID) : null),
    tags,
    contexts: Object.keys(contexts).length > 0 ? contexts : null,
    entries: (raw.entries ?? []).map((entry) =>
      entry?.type == null
        ? null
        : { type: entry.type ?? null, data: entry.data ?? null },
    ),
  };
}

function normalizeLog(raw: Record<string, unknown>): SentryLog {
  const timestamp =
    typeof raw.timestamp === "string"
      ? raw.timestamp
      : typeof raw.timestamp === "number"
        ? new Date(raw.timestamp * 1000).toISOString()
        : null;
  const severity = String(raw["sentry.severity"] ?? raw.level ?? "info");
  const body = String(
    raw.message ?? raw.body ?? raw["sentry.message"] ?? "(no message)",
  );
  const trace = String(raw.trace ?? raw.traceID ?? "") || null;
  return {
    timestamp,
    level: severity.toLowerCase(),
    message: body,
    trace,
    service: (raw.service as string | null) ?? null,
    environment: (raw.environment as string | null) ?? null,
    host: (raw.host as string | null) ?? null,
    raw,
  };
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  slug: string;
  id: string;
  name: string | null;
}

export async function listProjects(
  config: SentryConfig,
): Promise<ProjectSummary[]> {
  const url = `${config.apiBase}/projects/`;
  const data = await fetchJson<
    Array<{ slug?: string; id?: string; name?: string }>
  >(url, config.token);
  return (Array.isArray(data) ? data : [])
    .map((row) => ({
      slug: row.slug ?? "",
      id: String(row.id ?? ""),
      name: row.name ?? null,
    }))
    .filter((row) => row.slug !== "");
}

export async function listIssues(
  config: SentryConfig,
  options: IssueListOptions,
): Promise<{ issues: SentryIssue[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options.period) {
    if (config.isGlitchTip) {
      const start = parsePeriod(options.period);
      if (!start)
        throw new Error(
          `Could not parse period '${options.period}' (use 24h, 7d, ...)`,
        );
      params.set("start", start);
    } else {
      params.set("statsPeriod", options.period);
    }
  }
  params.set("limit", String(Math.min(options.limit ?? 25, 100)));

  const queryParts: string[] = [];
  if (options.query) queryParts.push(options.query);
  if (options.status) queryParts.push(`is:${options.status}`);
  if (options.level) queryParts.push(`level:${options.level}`);
  if (queryParts.length > 0) params.set("query", queryParts.join(" "));

  if (options.sort) {
    const glitchMap: Record<string, string> = {
      date: "-last_seen",
      new: "-first_seen",
      freq: "-count",
      priority: "-priority",
    };
    if (config.isGlitchTip) {
      const mapped = glitchMap[options.sort];
      if (!mapped)
        throw new Error(`GlitchTip does not support --sort ${options.sort}`);
      params.set("sort", mapped);
    } else {
      params.set("sort", options.sort);
    }
  }

  if (options.cursor) params.set("cursor", options.cursor);

  const projects = options.projects?.length
    ? options.projects
    : config.projects;
  for (const project of projects) {
    params.append("project", await resolveProjectId(config, project));
  }

  const url = `${config.apiBase}/organizations/${encodeURIComponent(config.org)}/issues/?${params.toString()}`;
  const resp = await fetchJsonWithHeaders<RawIssue[]>(url, config.token);
  return {
    issues: (Array.isArray(resp.data) ? resp.data : []).map(normalizeIssue),
    nextCursor: nextCursorFromLink(resp.link),
  };
}

function parseIssueInput(value: string): {
  org: string | null;
  issueId: string | null;
  shortId: string | null;
} {
  const urlMatch = value.match(
    /sentry\.io\/organizations\/([^/]+)\/issues\/(\d+)/,
  );
  if (urlMatch)
    return { org: urlMatch[1], issueId: urlMatch[2], shortId: null };
  const newUrlMatch = value.match(/([^/.]+)\.sentry\.io\/issues\/(\d+)/);
  if (newUrlMatch)
    return { org: newUrlMatch[1], issueId: newUrlMatch[2], shortId: null };
  if (/^\d+$/.test(value)) return { org: null, issueId: value, shortId: null };
  const genericUrlMatch = value.match(
    /^https?:\/\/[^/]+\/(?:organizations\/)?([^/]+)\/issues\/(\d+)/,
  );
  if (genericUrlMatch)
    return {
      org: genericUrlMatch[1],
      issueId: genericUrlMatch[2],
      shortId: null,
    };
  if (/^[A-Z]+-[A-Z0-9]+$/i.test(value))
    return { org: null, issueId: null, shortId: value };
  return { org: null, issueId: value, shortId: null };
}

export async function fetchIssue(
  config: SentryConfig,
  input: IssueInput,
): Promise<SentryIssue> {
  const parsed = parseIssueInput(input.value);
  if (parsed.shortId) {
    if (config.isGlitchTip) {
      throw new Error(
        "GlitchTip has no short-ID lookup. Use the numeric issue id or the issue URL, or find it with list-issues.",
      );
    }
    const org = parsed.org || config.org;
    if (!org)
      throw new Error(
        "Applying a short id needs an org. Set one in the settings panel or ~/.sentryclirc.",
      );
    const url = `${config.apiBase}/organizations/${encodeURIComponent(org)}/shortids/${encodeURIComponent(parsed.shortId)}/`;
    const result = await fetchJson<{ group?: RawIssue }>(url, config.token);
    if (!result?.group) throw new Error(`Issue ${parsed.shortId} not found`);
    return normalizeIssue(result.group);
  }
  const url = `${config.apiBase}/issues/${encodeURIComponent(parsed.issueId ?? input.value)}/`;
  const issue = await fetchJson<RawIssue>(url, config.token);
  return normalizeIssue(issue);
}

export async function fetchLatestEvent(
  config: SentryConfig,
  issueId: string,
): Promise<SentryEvent> {
  const url = `${config.apiBase}/issues/${encodeURIComponent(issueId)}/events/latest/`;
  const event = await fetchJson<RawEvent>(url, config.token);
  return normalizeEvent(event);
}

export async function fetchEvent(
  config: SentryConfig,
  eventId: string,
  project: string,
): Promise<SentryEvent> {
  const projectSlug = await resolveProjectSlug(config, project);
  const url = `${config.apiBase}/projects/${encodeURIComponent(config.org)}/${encodeURIComponent(projectSlug)}/events/${encodeURIComponent(eventId)}/`;
  const event = await fetchJson<RawEvent>(url, config.token);
  return normalizeEvent(event);
}

export async function searchLogs(
  config: SentryConfig,
  options: LogsSearchOptions,
): Promise<SentryLog[]> {
  if (config.isGlitchTip) {
    return searchGlitchTipLogs(config, options);
  }
  const params = new URLSearchParams();
  params.set("dataset", "logs");
  params.set("statsPeriod", options.period ?? "24h");
  params.set("per_page", String(Math.min(options.limit ?? 100, 1000)));
  params.set("sort", "-timestamp");
  for (const field of [
    "sentry.item_id",
    "trace",
    "sentry.severity",
    "timestamp",
    "message",
  ]) {
    params.append("field", field);
  }
  const queryParts: string[] = [];
  const projects = options.projects?.length
    ? options.projects
    : config.projects;
  for (const project of projects) queryParts.push(`project:${project}`);
  if (options.query) queryParts.push(options.query);
  if (queryParts.length > 0) params.set("query", queryParts.join(" "));
  const url = `${config.apiBase}/organizations/${encodeURIComponent(config.org)}/events/?${params.toString()}`;
  const data = await fetchJson<{ data?: Array<Record<string, unknown>> }>(
    url,
    config.token,
  );
  return (data.data ?? []).map(normalizeLog);
}

async function searchGlitchTipLogs(
  config: SentryConfig,
  options: LogsSearchOptions,
): Promise<SentryLog[]> {
  const params = new URLSearchParams();
  if (options.period) {
    const start = parsePeriod(options.period);
    if (!start)
      throw new Error(
        `Could not parse period '${options.period}' (use 24h, 7d, ...)`,
      );
    params.set("start", start);
  }
  params.set("limit", String(Math.min(options.limit ?? 100, 200)));
  for (const project of options.projects?.length
    ? options.projects
    : config.projects) {
    params.append("project", await resolveProjectId(config, project));
  }
  if (options.level) params.append("level", options.level);
  if (options.trace) params.set("traceId", options.trace);
  if (options.query) params.set("query", options.query);
  const url = `${config.apiBase}/organizations/${encodeURIComponent(config.org)}/logs/?${params.toString()}`;
  const data = await fetchJson<
    | Array<Record<string, unknown>>
    | { results?: Array<Record<string, unknown>> }
  >(url, config.token);
  const rows = Array.isArray(data) ? data : (data.results ?? []);
  return rows.map(normalizeLog);
}

/** Verify the token and read the org's project list. */
export async function checkConnection(
  config: SentryConfig,
): Promise<{ ok: boolean; message: string }> {
  try {
    const projects = await listProjects(config);
    return {
      ok: true,
      message: `Reached ${config.rootUrl} (${config.backend}) — ${projects.length} project${projects.length === 1 ? "" : "s"}.`,
    };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
