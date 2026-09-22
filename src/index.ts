import { requireAccess } from "./access";
import { renderDashboard } from "./dashboard";
import type { Env } from "./env";
import { runDailyIngest } from "./ingest";
import {
  buildListingStatus,
  handleListingIngest,
  INGEST_PATH,
  LISTINGS_CRON,
  listingsEnabled,
  recordCronInvocation,
  runListingCrawl,
} from "./listing-crawl";
import { buildListingMetrics } from "./listing-metrics";
import { buildListingPicks } from "./listing-picks";
import { renderListingsDashboard } from "./listings-dashboard";
import { renderListingsPicksDashboard } from "./listings-picks-dashboard";
import { buildNewListings } from "./new-listings";
import { renderNewListingsDashboard } from "./new-listings-dashboard";
import { buildMetrics, buildStatus, parseFilters } from "./metrics";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** 非公開（Cloudflare Access + Worker 側の JWT 検証）にするパス。INGEST_PATH だけは先に分岐して Bearer で守る */
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
    const url = new URL(req.url);
    // Mac（launchd）からの掲載取り込み。Access ではなく共有シークレット（Bearer）で守る → Access の前段が無い
    // Access の保護パス（/listings*・/api/listings*）の外に置いてあるので、カスタムドメインのまま届く
    if (url.pathname === INGEST_PATH) {
      try {
        return await handleListingIngest(req, env);
      } catch (e) {
        console.error(e);
        return json({ ok: false, error: "internal_error" }, 500);
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    try {
      if (isPrivatePath(url.pathname)) {
        const auth = await requireAccess(req, env);
        if (!auth.ok) return auth.response;
        const priv = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };
        switch (url.pathname) {
          case "/listings":
          case "/listings/":
            return new Response(renderListingsDashboard(), { headers: { "content-type": "text/html; charset=utf-8", ...priv } });
          case "/listings/picks":
          case "/listings/picks/":
            return new Response(renderListingsPicksDashboard(), { headers: { "content-type": "text/html; charset=utf-8", ...priv } });
          case "/api/listings/metrics":
            return json(await buildListingMetrics(env, url));
          case "/api/listings/status":
            return json(await buildListingStatus(env));
          case "/api/listings/picks":
            return json(await buildListingPicks(env, url));
          case "/listings/shinchiku":
          case "/listings/shinchiku/":
            return new Response(renderNewListingsDashboard(), { headers: { "content-type": "text/html; charset=utf-8", ...priv } });
          case "/api/listings/shinchiku":
            return json(await buildNewListings(env, url));
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
      // on（Worker が取る）以外は D1 にも触らず終わる。external では Mac が取って /api/ingest/listings に送る
      if (!listingsEnabled(env)) return;
      const startedAt = new Date().toISOString();
      ctx.waitUntil(
        runListingCrawl(env).then(
          (r) => {
            console.log(JSON.stringify({ listingCrawlResult: r }));
            return recordCronInvocation(env, controller.cron, startedAt, r);
          },
          (e) => {
            console.error("掲載クロールが例外で終了", e);
            return recordCronInvocation(env, controller.cron, startedAt, { status: "error", pages: 0, detail: String(e) });
          },
        ),
      );
      return;
    }
    ctx.waitUntil(runDailyIngest(env));
  },
} satisfies ExportedHandler<Env>;
