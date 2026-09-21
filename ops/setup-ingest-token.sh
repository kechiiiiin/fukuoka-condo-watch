#!/bin/bash
# 取り込み用トークン（LISTINGS_INGEST_TOKEN）を生成し、Worker secret と Mac の env ファイルの両方に置く。
# **値は画面にもシェル履歴にも出さない**（変数に持って、secret には stdin で、ファイルには printf 組み込みで渡す）。
# 何度実行してもよい（その都度トークンを作り直す = ローテーション）。
#
#   bash ops/setup-ingest-token.sh https://fukuoka-condo-watch.<sub>.workers.dev
#
# ⚠️ カスタムドメイン（condo.kechiiiiin.com）は /api/listings/* の前に Cloudflare Access が立っているので使えない。workers.dev を渡す。
set -euo pipefail

ORIGIN="${1:-}"
ORIGIN="${ORIGIN%/}"
[[ "$ORIGIN" =~ ^https://[A-Za-z0-9.-]+$ ]] || { echo "使い方: bash $0 https://fukuoka-condo-watch.<sub>.workers.dev" >&2; exit 1; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_DIR="$HOME/.config/fukuoka-condo-watch"
ENV_FILE="$CONF_DIR/env"

mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"

TOKEN="$(openssl rand -hex 32)"
[ "${#TOKEN}" -eq 64 ] || { echo "トークンの生成に失敗" >&2; exit 1; }

echo "→ Worker secret LISTINGS_INGEST_TOKEN を登録"
(cd "$REPO" && printf '%s' "$TOKEN" | npx wrangler secret put LISTINGS_INGEST_TOKEN)

echo "→ $ENV_FILE に書く（chmod 600）"
(
  umask 077
  printf 'LISTINGS_INGEST_URL=%s/api/listings/ingest\nLISTINGS_INGEST_TOKEN=%s\n' "$ORIGIN" "$TOKEN" > "$ENV_FILE.tmp"
)
mv "$ENV_FILE.tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
unset TOKEN
echo "✓ 済み（トークンの値は表示していません）"
