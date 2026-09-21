// POST /api/listings/ingest の認証（Mac 側クローラ → Worker）。Workers と Node の両方で動く（テスト用）。
//
//   Authorization: Bearer <LISTINGS_INGEST_TOKEN>
//
// - LISTINGS_INGEST_TOKEN は Worker secret。**未設定・短すぎる（32 文字未満）なら全員拒否（fail-closed）**
// - 比較は定数時間: 両方を SHA-256 にしてから長さ固定で XOR を積む（長さの違いも時間に出さない）
// - Cloudflare Access（src/access.ts）とは別経路。Access の JWT 検証は変えていない

export const MIN_INGEST_TOKEN_LENGTH = 32;

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** 定数時間の文字列比較 */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Authorization ヘッダが設定済みのトークンと一致するか。トークン未設定なら常に false */
export async function checkIngestToken(authorization: string | null, configured: string | undefined): Promise<boolean> {
  const expected = (configured ?? "").trim();
  if (expected.length < MIN_INGEST_TOKEN_LENGTH) return false;
  const m = /^Bearer[ ]+(\S+)\s*$/i.exec(authorization ?? "");
  // 形が不正でも比較は 1 回行う（早期 return で時間差を作らない）
  const given = m?.[1] ?? "";
  const same = await timingSafeEqualStr(given, expected);
  return !!m && same;
}
