#!/bin/bash
# SUUMO 日次クロール（Mac 側）を launchd に登録する。何度実行してもよい（入れ直し）。
#
#   bash ops/launchd/install.sh             # 登録（~/Library/LaunchAgents に置いて bootstrap）
#   bash ops/launchd/install.sh --dry-run   # 埋めた plist を表示して lint するだけ（登録しない）
#
# 前提: ~/.config/fukuoka-condo-watch/env（ops/setup-ingest-token.sh が作る）と npm ci 済みの node_modules
set -euo pipefail

LABEL="com.kechiiiiin.fukuoka-condo-watch.suumo"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TEMPLATE="$HERE/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/fukuoka-condo-watch"
ENV_FILE="$HOME/.config/fukuoka-condo-watch/env"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

die() { echo "✗ $*" >&2; exit 1; }

# node の実体を探す。
#   - Homebrew（/opt/homebrew/bin/node 等）はそのパスのまま使う（brew upgrade で Cellar の版が変わっても追従する）
#   - nodenv / anyenv などの shim は launchd の素の環境では動かないことがあるので、node 自身に実体のパスを聞く
#     （リポジトリで実行するので .node-version があればそれに従う。版を消したら install.sh をやり直す）
resolve_node() {
  local n
  n="$(command -v node || true)"
  if [ -z "$n" ]; then
    for c in /opt/homebrew/bin/node /usr/local/bin/node; do
      if [ -x "$c" ]; then n="$c"; break; fi
    done
  fi
  [ -z "$n" ] && return 0
  case "$n" in
    */shims/*) n="$(cd "$REPO" && "$n" -p 'process.execPath' 2>/dev/null || true)" ;;
  esac
  echo "$n"
}

NODE="$(resolve_node)"
[ -n "$NODE" ] && [ -x "$NODE" ] || die "node が見つかりません（Homebrew なら brew install node）"
case "$NODE" in */shims/*) die "node が shim（$NODE）です。nodenv which node で実体が取れる状態にしてください" ;; esac
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "node 20 以上が要ります（$NODE）"
[ -d "$REPO/node_modules/tsx" ] || die "node_modules が無い。先に: (cd $REPO && npm ci)"

if [ ! -f "$ENV_FILE" ]; then
  if [ "$DRY" = 1 ]; then echo "⚠️ $ENV_FILE がまだ無い（本番の登録前に ops/setup-ingest-token.sh を実行）" >&2
  else die "$ENV_FILE が無い。先に: bash ops/setup-ingest-token.sh https://fukuoka-condo-watch.<sub>.workers.dev"; fi
else
  perm="$(stat -f '%Lp' "$ENV_FILE")"
  [ "$perm" = "600" ] || die "$ENV_FILE の権限が $perm です。chmod 600 $ENV_FILE"
fi

PATH_VALUE="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"
esc() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }
RENDERED="$(mktemp -t fcw-plist)"
trap 'rm -f "$RENDERED"' EXIT
sed -e "s|__REPO__|$(esc "$REPO")|g" \
    -e "s|__NODE_BIN__|$(esc "$NODE")|g" \
    -e "s|__HOME__|$(esc "$HOME")|g" \
    -e "s|__PATH__|$(esc "$PATH_VALUE")|g" \
    "$TEMPLATE" > "$RENDERED"
grep -q '__[A-Z_]*__' "$RENDERED" && die "テンプレートの置き換え漏れ"
plutil -lint "$RENDERED" >/dev/null || die "plist が不正"

echo "node: $NODE"
echo "repo: $REPO"
if [ "$DRY" = 1 ]; then
  cat "$RENDERED"
  echo "（--dry-run: 登録していない）"
  exit 0
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
install -m 644 "$RENDERED" "$DEST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "✓ 登録しました: $DEST（毎日 01:00）"
echo "  今すぐ 1 回走らせる: launchctl kickstart gui/$(id -u)/$LABEL"
echo "  ログ:               tail -f $LOG_DIR/suumo-crawl.out.log"
echo "  止める:             bash ops/launchd/uninstall.sh"
