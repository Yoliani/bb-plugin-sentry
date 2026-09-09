// Config resolution, input parsing, and text rendering — the parts with rules
// of their own. Everything here is pure; nothing touches the Sentry API.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bytes, detail, table } from "./lib/format";
import {
  detectBackend,
  nextCursorFromLink,
  parseIssueInput,
  parsePeriod,
  parseRc,
  resolveConfig,
} from "./lib/sentry";
import { formatHomePathForDisplay } from "./lib/utils";

const previousRc = process.env.SENTRY_RC;

/** Write a throwaway .sentryclirc and point the resolver at it alone. */
function useRc(contents: string): void {
  const dir = mkdtempSync(join(tmpdir(), "sentry-rc-"));
  const path = join(dir, ".sentryclirc");
  writeFileSync(path, contents, "utf-8");
  process.env.SENTRY_RC = path;
}

afterEach(() => {
  if (previousRc === undefined) delete process.env.SENTRY_RC;
  else process.env.SENTRY_RC = previousRc;
  delete process.env.SENTRY_AUTH_TOKEN;
  delete process.env.SENTRY_URL;
  delete process.env.SENTRY_BACKEND;
});

describe("rc file", () => {
  it("reads sections and ignores comments", () => {
    const rc = parseRc(
      [
        "# a comment",
        "; another",
        "[auth]",
        "token = sntrys_abc ",
        "[defaults]",
        "org=acme",
        "project = web",
      ].join("\n"),
    );
    expect(rc.auth?.token).toBe("sntrys_abc");
    expect(rc.defaults?.org).toBe("acme");
    expect(rc.defaults?.project).toBe("web");
  });

  it("keeps '=' inside a value", () => {
    const rc = parseRc("[auth]\ntoken=a=b=c\n");
    expect(rc.auth?.token).toBe("a=b=c");
  });

  it("skips lines with no '='", () => {
    const rc = parseRc("[defaults]\ngarbage\norg=acme\n");
    expect(rc.defaults).toEqual({ org: "acme" });
  });
});

describe("config resolution", () => {
  it("falls back to sentry.io and detects the SaaS backend", () => {
    useRc("");
    const config = resolveConfig();
    expect(config.rootUrl).toBe("https://sentry.io");
    expect(config.apiBase).toBe("https://sentry.io/api/0");
    expect(config.backend).toBe("sentry");
    expect(config.isGlitchTip).toBe(false);
  });

  it("takes the token and org from the rc file", () => {
    useRc("[auth]\ntoken=sntrys_from_rc\n[defaults]\norg=acme\nproject=web\n");
    const config = resolveConfig();
    expect(config.token).toBe("sntrys_from_rc");
    expect(config.org).toBe("acme");
    expect(config.projects).toEqual(["web"]);
  });

  it("lets the environment beat the rc file", () => {
    useRc("[auth]\ntoken=from_rc\n[defaults]\nurl=https://rc.example.com\n");
    process.env.SENTRY_AUTH_TOKEN = "from_env";
    process.env.SENTRY_URL = "https://env.example.com";
    const config = resolveConfig();
    expect(config.token).toBe("from_env");
    expect(config.rootUrl).toBe("https://env.example.com");
  });

  it("lets explicit overrides beat the environment", () => {
    useRc("[auth]\ntoken=from_rc\n");
    process.env.SENTRY_AUTH_TOKEN = "from_env";
    const config = resolveConfig({ token: "from_override" });
    expect(config.token).toBe("from_override");
  });

  it("treats a self-hosted URL as GlitchTip and strips trailing slashes", () => {
    useRc("");
    const config = resolveConfig({ url: "https://errors.example.com///" });
    expect(config.rootUrl).toBe("https://errors.example.com");
    expect(config.isGlitchTip).toBe(true);
  });

  it("honours an explicit backend over URL detection", () => {
    useRc("");
    const config = resolveConfig({
      url: "https://errors.example.com",
      backend: "sentry",
    });
    expect(config.backend).toBe("sentry");
    expect(config.isGlitchTip).toBe(false);
  });

  it("reports no projects when none is configured", () => {
    useRc("");
    expect(resolveConfig().projects).toEqual([]);
  });
});

describe("backend detection", () => {
  it("recognises sentry.io and its subdomains", () => {
    expect(detectBackend("https://sentry.io")).toBe("sentry");
    expect(detectBackend("https://acme.sentry.io")).toBe("sentry");
  });

  it("treats anything else — including junk — as GlitchTip", () => {
    expect(detectBackend("https://errors.example.com")).toBe("glitchtip");
    expect(detectBackend("not a url")).toBe("glitchtip");
  });

  it("is not fooled by a lookalike host", () => {
    expect(detectBackend("https://notsentry.io")).toBe("glitchtip");
  });
});

describe("period parsing", () => {
  it("accepts each supported unit", () => {
    for (const period of ["30m", "24h", "7d", "2w"]) {
      expect(parsePeriod(period)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("resolves to a time the requested distance in the past", () => {
    const parsed = parsePeriod("1h");
    const elapsed = Date.now() - new Date(parsed as string).getTime();
    expect(elapsed).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(elapsed).toBeLessThanOrEqual(3_600_000 + 5_000);
  });

  it("rejects unsupported shapes", () => {
    for (const bad of ["", "7", "d", "7y", "-1d", "1.5h"]) {
      expect(parsePeriod(bad)).toBeNull();
    }
  });
});

describe("issue input parsing", () => {
  it("reads the org and id from a legacy issue URL", () => {
    expect(
      parseIssueInput("https://sentry.io/organizations/acme/issues/123"),
    ).toEqual({ org: "acme", issueId: "123", shortId: null });
  });

  it("reads the org and id from a subdomain issue URL", () => {
    expect(parseIssueInput("https://acme.sentry.io/issues/456")).toEqual({
      org: "acme",
      issueId: "456",
      shortId: null,
    });
  });

  it("reads a self-hosted GlitchTip URL", () => {
    expect(
      parseIssueInput("https://errors.example.com/acme/issues/321"),
    ).toEqual({ org: "acme", issueId: "321", shortId: null });
  });

  it("takes a bare numeric id", () => {
    expect(parseIssueInput("789")).toEqual({
      org: null,
      issueId: "789",
      shortId: null,
    });
  });

  it("recognises a short id", () => {
    expect(parseIssueInput("PROJ-1AB")).toEqual({
      org: null,
      issueId: null,
      shortId: "PROJ-1AB",
    });
  });

  it("falls back to treating the value as an id", () => {
    expect(parseIssueInput("whatever")).toEqual({
      org: null,
      issueId: "whatever",
      shortId: null,
    });
  });
});

describe("link header pagination", () => {
  it("pulls the cursor off the rel=next segment", () => {
    const link =
      '<https://sentry.io/a>; rel="previous"; cursor="0:0:1", ' +
      '<https://sentry.io/b>; rel="next"; cursor="0:100:0"';
    expect(nextCursorFromLink(link)).toBe("0:100:0");
  });

  it("returns null with no next page or no header", () => {
    expect(nextCursorFromLink(null)).toBeNull();
    expect(
      nextCursorFromLink(
        '<https://sentry.io/a>; rel="previous"; cursor="0:0:1"',
      ),
    ).toBeNull();
  });
});

describe("table rendering", () => {
  it("pads columns to the widest cell and leaves the last one ragged", () => {
    const rendered = table(
      ["ID", "TITLE"],
      [
        ["1", "short"],
        ["1000", "a longer title"],
      ],
      "no rows",
    );
    expect(rendered.split("\n")).toEqual([
      "ID    TITLE",
      "1     short",
      "1000  a longer title",
    ]);
  });

  it("collapses newlines and tabs so a row stays on one line", () => {
    expect(table(["T"], [["a\nb\tc"]], "none")).toBe("T\na b c");
  });

  it("returns the empty message for no rows", () => {
    expect(table(["ID"], [], "no issues found")).toBe("no issues found");
  });
});

describe("detail rendering", () => {
  it("aligns values past the widest label", () => {
    expect(
      detail([
        ["id", 42],
        ["culprit", "app/main"],
      ]),
    ).toBe("id       42\nculprit  app/main");
  });

  it("renders null and undefined as empty", () => {
    expect(detail([["id", null]])).toBe("id  ");
  });
});

describe("byte formatting", () => {
  it("scales through B, KB, and MB", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(1024)).toBe("1.0 KB");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("home path display", () => {
  it("abbreviates a home directory to ~", () => {
    expect(formatHomePathForDisplay("/Users/ada/code/app")).toBe("~/code/app");
    expect(formatHomePathForDisplay("/home/ada/code")).toBe("~/code");
    expect(formatHomePathForDisplay("/root/code")).toBe("~/code");
  });

  it("leaves a path outside home alone", () => {
    expect(formatHomePathForDisplay("/var/log/app")).toBe("/var/log/app");
  });
});
