// bb-plugin-sentry — connection settings section.
//
// Reads the resolved connection over RPC and lets you test it. The value
// fields themselves are edited in Extensions → Plugins → Sentry (they are the
// declared `bb.settings` descriptors on the server); this section mirrors the
// skill's check-config verb: show what is resolved, then prove the token.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

interface ConfigInfo {
  rootUrl: string;
  backend: "sentry" | "glitchtip";
  org: string;
  projects: string[];
  hasToken: boolean;
  ready: boolean;
}

export function Settings() {
  const rpc = useRpc<typeof rpcContract>();
  const [info, setInfo] = useState<ConfigInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(() => {
    rpc.call("config_get").then(
      (result) => {
        setInfo(result);
        setError(null);
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    load();
  }, [load]);

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await rpc.call("config_test");
      setTestResult(result);
    } catch (cause) {
      setTestResult({
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Values are edited in <strong>Extensions → Plugins → Sentry</strong>.
        Blank fields fall back to <code>SENTRY_URL</code>,{" "}
        <code>SENTRY_AUTH_TOKEN</code>, <code>SENTRY_BACKEND</code>, then{" "}
        <code>~/.sentryclirc</code>.
      </p>

      {info === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {error === null ? "Reading the connection…" : error}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border text-sm">
          <div className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-1.5 px-4 py-3">
            <span className="text-muted-foreground">Server</span>
            <span className="font-mono break-all">{info.rootUrl || "—"}</span>
            <span className="text-muted-foreground">Backend</span>
            <span>{info.backend}</span>
            <span className="text-muted-foreground">Org</span>
            <span>{info.org === "" ? "—" : info.org}</span>
            <span className="text-muted-foreground">Projects</span>
            <span>
              {info.projects.length === 0 ? "—" : info.projects.join(", ")}
            </span>
            <span className="text-muted-foreground">Token</span>
            <span>
              {info.hasToken ? (
                "set"
              ) : (
                <strong className="text-destructive">missing</strong>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
            <Button
              variant="outline"
              size="sm"
              onClick={test}
              disabled={testing || !info.ready}
            >
              <Icon
                name={testing ? "Loading" : "CircleCheck"}
                className="size-4"
              />
              {testing ? "Testing…" : "Test connection"}
            </Button>
            <Button variant="ghost" size="sm" onClick={load}>
              Refresh
            </Button>
          </div>
        </div>
      )}

      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {testResult === null ? null : (
        <p
          className={
            testResult.ok
              ? "text-sm text-emerald-600"
              : "text-sm text-destructive"
          }
        >
          {testResult.message}
        </p>
      )}
    </div>
  );
}
