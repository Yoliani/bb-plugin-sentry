// bb-plugin-sentry — a single issue with its latest event.
//
// Fetches `issue_get` with `withLatest` so the newest event's stack trace,
// request, tags, contexts, and breadcrumbs come back in one call. This is the
// drill-down equivalent of the skill's `fetch-issue.js <id> --latest`.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { BoardEvent, BoardIssue, rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

interface Frame {
  filename?: string;
  absPath?: string;
  module?: string;
  function?: string;
  lineNo?: number;
  lineno?: number;
  context_line?: string;
  preContext?: string[];
  postContext?: string[];
}

function KeyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-4 py-1 text-sm">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 font-medium">{value}</span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4 border-t border-border pt-3">
      <h3 className="px-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function renderStackframes(frames: Frame[] | null) {
  if (!frames || frames.length === 0) {
    return <p className="px-4 text-sm text-muted-foreground">(no frames)</p>;
  }
  // Show application frames first, mirroring the skill's ordering.
  const appFrames = frames.filter(
    (frame) => frame.function !== undefined || frame.filename,
  );
  const list = appFrames.length > 0 ? appFrames : frames;
  return (
    <ol className="space-y-2 px-4">
      {list.slice(0, 25).map((frame, index) => {
        const file =
          frame.filename || frame.absPath || frame.module || "unknown";
        const fn = frame.function || "(anonymous)";
        const line = frame.lineNo ?? frame.lineno;
        const loc = line ? `:${line}` : "";
        return (
          <li key={index} className="font-mono text-xs leading-relaxed">
            <span className="text-muted-foreground">{index + 1}.</span>{" "}
            <span className="text-foreground">
              {file}
              {loc}
            </span>
            <div className="pl-3 text-muted-foreground">→ {fn}</div>
            {frame.context_line ? (
              <pre className="mt-0.5 truncate pl-3 text-foreground/80">
                {frame.context_line.trim()}
              </pre>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function ExceptionEntry({ data }: { data: Record<string, unknown> }) {
  const values = (Array.isArray(data.values) ? data.values : []) as Array<
    Record<string, unknown>
  >;
  if (values.length === 0) return null;
  return (
    <div className="space-y-3">
      {values.map((exc, index) => {
        const type = typeof exc.type === "string" ? exc.type : "Error";
        const value =
          typeof exc.value === "string" ? exc.value : "(no message)";
        const frames = (
          Array.isArray(exc.stacktrace)
            ? exc.stacktrace
            : (exc.stacktrace as Record<string, unknown> | undefined)?.frames
        ) as Frame[] | null;
        return (
          <div key={index}>
            <p className="px-4 font-mono text-sm font-semibold">
              <span className="text-destructive">{type}:</span> {value}
            </p>
            {renderStackframes(frames)}
          </div>
        );
      })}
    </div>
  );
}

function RequestEntry({ data }: { data: Record<string, unknown> }) {
  const method = typeof data.method === "string" ? data.method : null;
  const url = typeof data.url === "string" ? data.url : null;
  const headers = Array.isArray(data.headers)
    ? (data.headers as Array<[string, string]>)
    : [];
  const body = typeof data.data === "string" ? data.data : null;
  return (
    <div className="space-y-2 px-4">
      {method && url ? (
        <p className="font-mono text-sm">
          <span className="font-semibold">{method}</span>{" "}
          <span className="break-all">{url}</span>
        </p>
      ) : null}
      {headers.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {headers.slice(0, 8).map(([key, val], index) => (
            <span key={index}>
              <span className="text-foreground">{key}:</span> {val}
            </span>
          ))}
        </div>
      ) : null}
      {body ? (
        <pre className="rounded-md bg-card px-3 py-2 text-xs">
          {body.slice(0, 1000)}
        </pre>
      ) : null}
    </div>
  );
}

interface Crumb {
  timestamp?: number | string;
  category?: string;
  type?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown> | string;
}

function BreadcrumbsEntry({ data }: { data: Record<string, unknown> }) {
  const values = (Array.isArray(data.values) ? data.values : []) as Crumb[];
  const crumbs = values.slice(-15);
  if (crumbs.length === 0) return null;
  const timeOf = (ts: number | string | undefined) => {
    if (ts === undefined) return "??:??:??";
    const date = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
    return Number.isNaN(date.getTime())
      ? "??:??:??"
      : date.toISOString().slice(11, 19);
  };
  return (
    <div className="space-y-1 px-4 font-mono text-xs">
      {crumbs.map((crumb, index) => {
        let msg = crumb.message || "";
        if (msg === "" && crumb.data) {
          if (typeof crumb.data === "object") {
            const record = crumb.data as Record<string, unknown>;
            msg =
              typeof record.url === "string"
                ? record.url
                : JSON.stringify(record);
          } else {
            msg = String(crumb.data);
          }
        }
        const cat = crumb.category ?? crumb.type ?? "?";
        const level =
          crumb.level && crumb.level !== "info" ? `[${crumb.level}] ` : "";
        return (
          <div key={index} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">
              [{timeOf(crumb.timestamp)}]
            </span>
            <span className="text-muted-foreground">
              {level}
              {cat}:
            </span>{" "}
            <span className="truncate">{msg}</span>
          </div>
        );
      })}
    </div>
  );
}

function EventEntry({
  entry,
}: {
  entry: { type: string | null; data: unknown } | null;
}) {
  if (!entry || !entry.type) return null;
  const data = (entry.data ?? {}) as Record<string, unknown>;
  switch (entry.type) {
    case "request":
      return <RequestEntry data={data} />;
    case "exception":
      return <ExceptionEntry data={data} />;
    case "message": {
      const formatted =
        typeof data.formatted === "string" ? data.formatted : null;
      return formatted ? <p className="px-4 text-sm">{formatted}</p> : null;
    }
    case "breadcrumbs":
      return <BreadcrumbsEntry data={data} />;
    default:
      return null;
  }
}

function ContextBlock({ event }: { event: BoardEvent }) {
  if (!event.contexts) return null;
  const rows: Array<[string, string]> = [];
  const runtime = event.contexts.runtime;
  if (runtime)
    rows.push(["Runtime", `${runtime.name ?? "?"} ${runtime.version ?? ""}`]);
  if (event.contexts.browser) {
    rows.push([
      "Browser",
      `${event.contexts.browser.name ?? "?"} ${event.contexts.browser.version ?? ""}`,
    ]);
  }
  if (event.contexts.os) {
    rows.push([
      "OS",
      `${event.contexts.os.name ?? "?"} ${event.contexts.os.version ?? ""}`,
    ]);
  }
  if (event.contexts.trace)
    rows.push(["Trace", event.contexts.trace.traceId ?? "?"]);
  if (rows.length === 0) return null;
  return (
    <div className="px-4">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-2 text-xs">
          <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
          <span className="truncate">{value}</span>
        </div>
      ))}
    </div>
  );
}

function TagsBlock({ event }: { event: BoardEvent }) {
  if (event.tags.length === 0) return null;
  const interesting = event.tags.filter(
    (tag) =>
      [
        "environment",
        "release",
        "server_name",
        "transaction",
        "url",
        "browser",
        "os",
        "runtime",
      ].includes(tag.key) || tag.key.startsWith("sentry:"),
  );
  if (interesting.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 text-xs">
      {interesting.map((tag) => (
        <span key={tag.key}>
          <span className="text-muted-foreground">{tag.key}:</span> {tag.value}
        </span>
      ))}
    </div>
  );
}

function formatWhen(ts: string | null): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString();
}

function DetailContent({
  issue,
  event,
}: {
  issue: BoardIssue;
  event: BoardEvent | null;
}) {
  return (
    <div>
      <div className="px-4 pt-2">
        <p className="text-base font-semibold leading-snug">{issue.title}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-md bg-secondary px-2 py-0.5 font-medium text-secondary-foreground">
            {issue.shortId || issue.id}
          </span>
          <span className="rounded-md bg-secondary px-2 py-0.5">
            {issue.level}
          </span>
          <span className="rounded-md bg-secondary px-2 py-0.5">
            {issue.status}
          </span>
          <span className="text-muted-foreground">
            {issue.project?.slug ?? "?"}
          </span>
          {issue.permalink ? (
            <a
              href={issue.permalink}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-border px-2 py-0.5 text-foreground hover:bg-state-hover"
            >
              <Icon name="ExternalLink" className="mr-1 inline size-3" />
              Open
            </a>
          ) : null}
        </div>
      </div>

      <div className="mt-3 border-t border-border pt-2">
        <KeyRow label="First seen" value={formatWhen(issue.firstSeen)} />
        <KeyRow label="Last seen" value={formatWhen(issue.lastSeen)} />
        <KeyRow label="Events" value={issue.count} />
        <KeyRow label="Users" value={issue.userCount} />
        {issue.culprit ? (
          <KeyRow label="Culprit" value={issue.culprit} />
        ) : null}
      </div>

      {event === null ? (
        <Section title="Event">
          <p className="px-4 text-sm text-muted-foreground">
            No event attached.
          </p>
        </Section>
      ) : (
        <>
          <Section title="Latest event">
            <KeyRow
              label="Event ID"
              value={
                <span className="font-mono">{event.eventID || event.id}</span>
              }
            />
            <KeyRow label="Timestamp" value={formatWhen(event.dateCreated)} />
            {event.project ? (
              <KeyRow label="Project" value={event.project} />
            ) : null}
          </Section>

          <Section title="Context">
            <ContextBlock event={event} />
            <div className="h-1" />
            <TagsBlock event={event} />
          </Section>

          {event.entries.map((entry, index) => {
            if (!entry || !entry.type) return null;
            const label =
              entry.type === "exception"
                ? "Exception"
                : entry.type === "message"
                  ? "Message"
                  : entry.type === "request"
                    ? "Request"
                    : entry.type === "breadcrumbs"
                      ? "Breadcrumbs"
                      : entry.type;
            return (
              <Section key={index} title={label}>
                <EventEntry entry={entry} />
              </Section>
            );
          })}
        </>
      )}
    </div>
  );
}

export function IssueDetail({
  issueId,
  onBack,
}: {
  issueId: string;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{
    issue: BoardIssue;
    event: BoardEvent | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const load = useCallback(() => {
    rpc
      .call("issue_get", { value: issueId, withLatest: true })
      .then((result) => {
        setData(result);
        setError(null);
      }, report);
  }, [rpc, issueId, report]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Back to issues"
          onClick={onBack}
        >
          <Icon name="ChevronLeft" className="size-4" />
        </Button>
        <span className="text-sm text-muted-foreground">Sentry issue</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-7"
          aria-label="Refresh"
          onClick={load}
        >
          <Icon name="Loading" className="size-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {error === null ? (
          data === null ? (
            <p
              role="status"
              className="mx-4 mt-4 text-sm text-muted-foreground"
            >
              Loading issue…
            </p>
          ) : (
            <DetailContent issue={data.issue} event={data.event} />
          )
        ) : (
          <p role="alert" className="mx-4 mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
