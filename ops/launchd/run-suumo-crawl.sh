#!/bin/bash
# launchd（com.kechiiiiin.fukuoka-condo-watch.suumo = 中古・.suumo-shinchiku = 新築で --kind shinchiku 付き）から呼ばれる。手で叩いてもよい（引数はクローラへ渡す）。
# node は plist の NODE_BIN（ops/launchd/install.sh が解決して埋める）。無ければ PATH の node。
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
NODE="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "$(date '+%FT%T%z') node が見つかりません（ops/launchd/install.sh をやり直してください）" >&2
  exit 1
fi
exec "$NODE" --import tsx scripts/suumo-crawl-local.ts "$@"
