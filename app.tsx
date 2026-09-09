// bb-plugin-sentry — frontend entry.
//
// A Sentry / GlitchTip issues browser as a BB nav panel. Every call goes
// through the backend's RPC contract, so an auth token never leaves the
// server. The selected project and period live in the panel's subPath so a
// filter is a shareable link (/plugins/sentry/sentry/<project>/<period>).
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Panel } from "@/components/panel";
import { Settings } from "@/components/settings";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "connection",
    title: "Connection",
    description:
      "The Sentry / GlitchTip connection. Blank fields fall back to SENTRY_* env and ~/.sentryclirc.",
    component: Settings,
  });
  app.slots.navPanel({
    id: "sentry",
    title: "Sentry",
    icon: "Bug",
    path: "sentry",
    component: Panel,
  });
});
