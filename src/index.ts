import { renderDashboard } from "./dashboard";
import type { Env } from "./env";
import { runDailyIngest } from "./ingest";
import { buildMetrics, buildStatus, parseFilters } from "./metrics";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default {
  async fetch(req, env): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case "/":
          return new Response(renderDashboard(), {
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
          });
        case "/api/metrics":
          return json(await buildMetrics(env, parseFilters(url)));
        case "/api/status":
          return json(await buildStatus(env));
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e) {
      console.error(e);
      return json({ error: "internal_error" }, 500);
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runDailyIngest(env));
  },
} satisfies ExportedHandler<Env>;
