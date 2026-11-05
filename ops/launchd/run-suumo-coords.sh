#!/bin/bash
# launchd（com.kechiiiiin.fukuoka-condo-watch.suumo-coords）から呼ばれる。手で叩いてもよい（引数はクローラへ渡す）。
# 掲載（中古・賃貸）の建物の座標を取る。先に国土地理院の住所検索で番地のある住所に仮座標（scripts/gsi-coords.ts）、
# 続けて SUUMO のページの座標（scripts/suumo-coords.ts）。国土地理院が失敗しても SUUMO は走る。
# SUUMO に止められた（403・captcha・redirect_challenge 等）日は、その日（JST）の残りの回は SUUMO に行かず「今日は休む」と
# 1 行出して終わる（exit 0）。国土地理院の方は毎回走る。翌日は自動で再開（印は suumo-coords-blocked.txt・scripts/crawl-local-lib.ts）。
# 止められた回自身の exit code は 2（launchd の最終終了コードに残る）。
# 引数は SUUMO の方へ渡す（--max 3 で試し走り・--dry-run で設定確認だけ。--dry-run は国土地理院の方にも渡す）。
# node は plist の NODE_BIN（ops/launchd/install.sh が解決して埋める）。無ければ PATH の node。
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
NODE="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "$(date '+%FT%T%z') node が見つかりません（ops/launchd/install.sh をやり直してください）" >&2
  exit 1
fi
GSI_ARGS=()
for a in "$@"; do [ "$a" = "--dry-run" ] && GSI_ARGS=(--dry-run); done
if ! "$NODE" --import tsx scripts/gsi-coords.ts ${GSI_ARGS[@]+"${GSI_ARGS[@]}"}; then
  echo "$(date '+%FT%T%z') 国土地理院の仮座標（gsi-coords）が失敗。SUUMO の座標は続けて取る" >&2
fi
exec "$NODE" --import tsx scripts/suumo-coords.ts "$@"
