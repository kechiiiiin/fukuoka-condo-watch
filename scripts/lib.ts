// ローカル実行スクリプトの共通部品（Worker には含まれない）
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DB_NAME = "fukuoka-condo-watch";

function devVars(): Record<string, string> {
  if (!existsSync(".dev.vars")) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return out;
}

/** 環境変数 → .dev.vars の順に探す。値は表示しない */
export function requireVar(name: string): string {
  const v = process.env[name] || devVars()[name];
  if (!v) {
    console.error(`${name} が未設定です（.dev.vars か環境変数に入れてください）`);
    process.exit(1);
  }
  return v;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function sqlLit(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

/** SQL 文の配列を 1 ファイルにして wrangler d1 execute で流す。既定はローカル、--remote で本番 */
export function executeSql(statements: string[], label: string): void {
  if (statements.length === 0) return;
  const remote = flag("remote");
  const dir = join(".wrangler", "tmp-sql");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${label.replace(/[^A-Za-z0-9_-]/g, "_")}.sql`);
  writeFileSync(file, statements.join(";\n") + ";\n");
  console.log(`→ D1(${remote ? "remote" : "local"}) に ${statements.length} 文を投入: ${label}`);
  execFileSync("npx", ["wrangler", "d1", "execute", DB_NAME, remote ? "--remote" : "--local", `--file=${file}`, "--yes"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 福岡市 7 区をすっぽり覆う範囲（周辺市町の一部を含む） */
export const FUKUOKA_BBOX = { west: 130.17, east: 130.5, south: 33.43, north: 33.72 };

export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

export function tilesForBbox(z: number): { z: number; x: number; y: number }[] {
  const nw = lonLatToTile(FUKUOKA_BBOX.west, FUKUOKA_BBOX.north, z);
  const se = lonLatToTile(FUKUOKA_BBOX.east, FUKUOKA_BBOX.south, z);
  const out: { z: number; x: number; y: number }[] = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.push({ z, x, y });
  return out;
}
