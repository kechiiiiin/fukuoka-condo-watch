import { requireAccess } from "./access";
import { renderDashboard } from "./dashboard";
import type { Env } from "./env";
import { runDailyIngest } from "./ingest";
import { buildListingStatus, LISTINGS_CRON, listingsEnabled, runListingCrawl } from "./listing-crawl";
import { buildListingMetrics } from "./listing-metrics";
import { renderListingsDashboard } from "./listings-dashboard";
import { buildMetrics, buildStatus, parseFilters } from "./metrics";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** 非公開（Cloudflare Access + Worker 側の JWT 検証）にするパス */
export function isPrivatePath(pathname: string): boolean {
  return (
    pathname === "/listings" ||
    pathname.startsWith("/listings/") ||
    pathname === "/api/listings" ||
    pathname.startsWith("/api/listings/")
  );
}

export default {
  async fetch(req, env): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const url = new URL(req.url);
    try {
      if (isPrivatePath(url.pathname)) {
        const auth = await requireAccess(req, env);
        if (!auth.ok) return auth.response;
        const priv = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };
        switch (url.pathname) {
          case "/listings":
          case "/listings/":
            return new Response(renderListingsDashboard(), { headers: { "content-type": "text/html; charset=utf-8", ...priv } });
          case "/api/listings/metrics":
            return json(await buildListingMetrics(env, url));
          case "/api/listings/status":
            return json(await buildListingStatus(env));
          default:
            return new Response("Not Found", { status: 404, headers: priv });
        }
      }
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

  async scheduled(controller, env, ctx): Promise<void> {
    if (controller.cron === LISTINGS_CRON) {
      // off のときは D1 にも触らず終わる
      if (!listingsEnabled(env)) return;
      ctx.waitUntil(runListingCrawl(env).then((r) => console.log(JSON.stringify({ listingCrawlResult: r }))));
      return;
    }
    ctx.waitUntil(runDailyIngest(env));
  },
} satisfies ExportedHandler<Env>;
