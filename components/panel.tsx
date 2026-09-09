// bb-plugin-sentry — the nav panel: filter and browse Sentry issues.
//
// Every call is RPC to the server (no token in the browser). Selecting an
// issue swaps the panel for the detail view; a back button returns to the list.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { BoardIssue, rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useResource } from "@/hooks/use-resource";
import { IssueDetail } from "@/components/issue-detail";

interface ConfigInfo {
  rootUrl: string;
  backend: "sentry" | "glitchtip";
  org: string;
  projects: string[];
  hasToken: boolean;
  ready: boolean;
}

interface ProjectSummary {
  slug: string;
  id: string;
  name: string | null;
}

interface ListData {
  issues: BoardIssue[];
  nextCursor: string | null;
}

const PERIODS = ["24h", "7d", "14d", "30d"];
const STATUSES = ["unresolved", "resolved", "ignored"];
const LEVELS = ["error", "warning", "info", "fatal"];

function relative(ts: string | null): string {
  if (!ts) return "—";
  const time = new Date(ts).getTime();
  if (Number.isNaN(time)) return ts;
  const mins = Math.floor((Date.now() - time) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function levelTone(level: string): string {
  switch (level.toLowerCase()) {
    case "fatal":
    case "critical":
      return "text-red-500";
    case "error":
      return "text-destructive";
    case "warning":
      return "text-amber-500";
    case "info":
      return "text-sky-500";
    default:
      return "text-muted-foreground";
  }
}

function Notice({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "mx-4 rounded-lg border border-dashed px-4 py-6 text-center text-sm md:mx-5",
        tone === "error"
          ? "border-destructive/40 text-destructive"
          : "border-border text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function IssueRow({
  issue,
  selected,
  onOpen,
}: {
  issue: BoardIssue;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full flex-col gap-1 px-4 py-3 text-left text-sm transition-colors",
        selected ? "bg-state-active" : "hover:bg-state-hover",
      )}
    >
      <span className="flex items-center gap-2">
        <span className={cn("font-medium", levelTone(issue.level))}>
          {issue.level.replace(/^\w/, (c: string) => c.toUpperCase())}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {issue.shortId || issue.id}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {issue.count} event{issue.count === 1 ? "" : "s"}
        </span>
      </span>
      <span className="line-clamp-2 pr-2 font-medium leading-snug">
        {issue.title}
      </span>
      <span className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{issue.project?.slug ?? "?"}</span>
        <span className="ml-auto">{relative(issue.lastSeen)}</span>
      </span>
    </button>
  );
}

function PanelPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [project, setProject] = useState("");
  const [period, setPeriod] = useState("24h");
  const [status, setStatus] = useState("unresolved");
  const [level, setLevel] = useState("");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Pages beyond the first: "Load more" appends here, reset by a fresh first page.
  const [appended, setAppended] = useState<BoardIssue[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Monotonic sequence for "load more": bumped at the start of each request AND
  // whenever a fresh first page lands, so only the most recent request may append
  // or touch state. A stale response — filters changed, or the user clicked twice
  // — is dropped entirely instead of clearing loading or showing an old error.
  const loadMoreSeq = useRef(0);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const loadConfig = useCallback(() => {
    rpc.call("config_get").then((result) => {
      setConfig(result);
      setProject((current) =>
        current === "" ? (result.projects[0] ?? "") : current,
      );
    }, report);
  }, [rpc, report]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Load the org's projects so the picker shows real slugs (not just defaults).
  useEffect(() => {
    rpc.call("projects_list").then(
      (result) => setProjects(result.projects),
      () => setProjects([]),
    );
  }, [rpc]);

  // The issue list, re-read whenever a filter, window, or the submitted search
  // changes. The submitted search is deliberately separate from the live `query`
  // text: typing never fires a request per keystroke — only Enter (form submit)
  // commits a search. That fixes the "8 requests to type 'database'" waste and,
  // because this is a sequence-guarded read, a slow response for one filter can
  // never paint over a newer one.
  const list = useResource<ListData>(
    () =>
      project === ""
        ? Promise.resolve({ issues: [], nextCursor: null })
        : rpc.call("issues_list", {
            project,
            period,
            limit: 50,
            ...(status === "" ? {} : { status }),
            ...(level === "" ? {} : { level }),
            ...(submittedQuery.trim() === ""
              ? {}
              : { query: submittedQuery.trim() }),
          }),
    [rpc, project, period, status, level, submittedQuery],
  );

  // A fresh first page (any filter change, or a refresh) resets pagination, drops
  // any in-flight "Load more", and clears a stale error from a previous attempt.
  useEffect(() => {
    if (list.data !== null) {
      loadMoreSeq.current += 1;
      setAppended([]);
      setCursor(list.data.nextCursor);
      setLoadingMore(false);
      setError(null);
    }
  }, [list.data]);

  const loadMore = useCallback(() => {
    if (project === "" || cursor === null) return;
    const current = ++loadMoreSeq.current;
    setLoadingMore(true);
    setError(null);
    rpc
      .call("issues_list", {
        project,
        period,
        limit: 50,
        cursor,
        ...(status === "" ? {} : { status }),
        ...(level === "" ? {} : { level }),
        ...(submittedQuery.trim() === ""
          ? {}
          : { query: submittedQuery.trim() }),
      })
      .then(
        (result) => {
          if (current !== loadMoreSeq.current) return;
          setAppended((prev) => [...prev, ...result.issues]);
          setCursor(result.nextCursor);
          setLoadingMore(false);
        },
        (cause) => {
          if (current !== loadMoreSeq.current) return;
          setLoadingMore(false);
          report(cause);
        },
      );
    // loadMoreSeq is a ref, not a dep: it bumps on each request and each fresh
    // first page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, project, period, status, level, submittedQuery, cursor, report]);

  const issues = list.data === null ? null : [...list.data.issues, ...appended];

  if (config === null) return null;

  if (!config.ready) {
    return (
      <div className="h-full min-h-0 overflow-y-auto pt-3 md:pt-4">
        <Notice>
          <p className="text-foreground">
            Connect a Sentry or GlitchTip org to see issues.
          </p>
          <p className="mt-2">
            Set an org slug and an auth token in <code>~/.sentryclirc</code>,
            via <code>SENTRY_*</code> env vars, or in{" "}
            <strong>Extensions → Plugins → Sentry</strong>.
          </p>
        </Notice>
      </div>
    );
  }

  if (selectedId !== null) {
    return (
      <IssueDetail issueId={selectedId} onBack={() => setSelectedId(null)} />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 md:px-5">
        <select
          aria-label="Project"
          value={project}
          onChange={(event) => setProject(event.target.value)}
          className="h-8 max-w-40 rounded-md border border-input bg-card px-2 text-sm text-foreground"
        >
          <option value="" disabled>
            {projects === null ? "Loading…" : "Project"}
          </option>
          {(projects ?? []).map((candidate) => (
            <option key={candidate.id} value={candidate.slug}>
              {candidate.slug}
            </option>
          ))}
        </select>
        <select
          aria-label="Period"
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
          className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground"
        >
          {PERIODS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground"
        >
          <option value="">Any status</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label="Level"
          value={level}
          onChange={(event) => setLevel(event.target.value)}
          className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground"
        >
          <option value="">Any level</option>
          {LEVELS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-7 text-muted-foreground hover:text-foreground"
          aria-label="Refresh issues"
          disabled={list.loading}
          onClick={list.reload}
        >
          <Icon
            name="Loading"
            className={cn("size-4", list.loading && "animate-spin")}
          />
        </Button>
      </div>

      <form
        className="border-b border-border px-4 py-2 md:px-5"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmittedQuery(query.trim());
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search issues…"
          aria-label="Search issues"
          className="h-8"
        />
      </form>

      {error === null ? null : (
        <div className="pb-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.error !== null ? (
          <Notice tone="error">{list.error}</Notice>
        ) : issues === null ? (
          <Notice>Loading issues…</Notice>
        ) : issues.length === 0 ? (
          <Notice>No issues match your filters.</Notice>
        ) : (
          <div className="divide-y divide-border">
            {issues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                selected={issue.id === selectedId}
                onOpen={() => setSelectedId(issue.id)}
              />
            ))}
          </div>
        )}
      </div>

      {issues !== null && issues.length > 0 ? (
        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground md:px-5">
          <span>
            {issues.length} issue{issues.length === 1 ? "" : "s"} ·{" "}
            {config.rootUrl} · {config.org}
          </span>
          {cursor === null ? null : (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Panel() {
  return <PanelPage />;
}
