#!/bin/bash
# SUUMO クロール（Mac 側）を launchd に登録する。何度実行してもよい（入れ直し）。6 本:
#   - com.kechiiiiin.fukuoka-condo-watch.suumo           … 中古・毎日 01:00
#   - com.kechiiiiin.fukuoka-condo-watch.suumo-shinchiku … 新築・毎週日曜 06:00（2026-09-22〜）
#   - com.kechiiiiin.fukuoka-condo-watch.suumo-chintai   … 賃貸・毎週土曜 06:00（2026-09-26〜）
#   - com.kechiiiiin.fukuoka-condo-watch.suumo-chintai-pets … 賃貸のペット相談可（2 周目）・毎週土曜 12:00
#   - com.kechiiiiin.fukuoka-condo-watch.suumo-chintai-maisonette … 賃貸のメゾネット（3 周目）・毎週土曜 14:00
#   - com.kechiiiiin.fukuoka-condo-watch.suumo-chintai-detail … 賃貸の詳細ページ（LDK 畳数）・毎週土曜 16:00
# ⚠️ 賃貸の 2〜4 本目は 1 周目（06:00）より後でなければならない（1 周目の upsert が印を上書きするため）。
# 6 本は同じロックファイルを使うので、同時に SUUMO を叩かない（後から起きた方が待つ）。
#
#   bash ops/launchd/install.sh                    # 6 本とも登録（~/Library/LaunchAgents に置いて bootstrap）
#   bash ops/launchd/install.sh --only chintai     # 1 本だけ（chuko / shinchiku / chintai / chintai_pets / chintai_maisonette / chintai_detail）
#   bash ops/launchd/install.sh --dry-run          # 埋めた plist を表示して lint するだけ（登録しない）
#
# 前提: ~/.config/fukuoka-condo-watch/env（ops/setup-ingest-token.sh が作る）と npm ci 済みの node_modules
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LOG_DIR="$HOME/Library/Logs/fukuoka-condo-watch"
ENV_FILE="$HOME/.config/fukuoka-condo-watch/env"
DRY=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --only) ONLY="${2:-}"; shift ;;
    *) echo "不明な引数: $1" >&2; exit 1 ;;
  esac
  shift
done

die() { echo "✗ $*" >&2; exit 1; }

case "$ONLY" in
  "") LABELS=("com.kechiiiiin.fukuoka-condo-watch.suumo" "com.kechiiiiin.fukuoka-condo-watch.suumo-shinchiku" "com.kechiiiiin.fukuoka-condo-watch.suumo-chintai" "com.kechiiiiin.fukuoka-condo-watch.suumo-chintai-pets" "com.kechiiiiin.fukuoka-condo-watch.suumo-chintai-maisonette" "com.kechiiiiin.fukuoka-condo-watch.suumo-chintai-detail") ;;
  chuko) LABELS=("com.kechiiiiin.fukuoka-condo-watch.suumo") ;;
  shinchiku) LABELS=("com.kechiiiiin.fukuoka-condo-watch.suumo-shinchiku") ;;
  chintai) LABELS=("com.kechiiiiin.fukuoka-condo-watch.suumo-chintai") ;;
  chintai_pets) LABELS=("com.kechiiiiin.fukuoka-condo-watch.suumo-chintai-pets") ;;
  chintai_maisonette) LABELS=("com.kechiiiiin.fukuoka-condo-watch.suumo-chintai-maisonette") ;;
  chintai_detail) LABELS=("com.kechiiiiin.fukuoka-condo-watch.suumo-chintai-detail") ;;
  *) die "--only には chuko / shinchiku / chintai / chintai_pets / chintai_maisonette / chintai_detail のいずれかを" ;;
esac

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
  else die "$ENV_FILE が無い。先に: bash ops/setup-ingest-token.sh https://condo.kechiiiiin.com"; fi
else
  perm="$(stat -f '%Lp' "$ENV_FILE")"
  [ "$perm" = "600" ] || die "$ENV_FILE の権限が $perm です。chmod 600 $ENV_FILE"
fi

PATH_VALUE="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"
esc() { printf '%s' "$1" | sed -e 's/[&|\\]/\\&/g'; }
RENDERED="$(mktemp -t fcw-plist)"
trap 'rm -f "$RENDERED"' EXIT

echo "node: $NODE"
echo "repo: $REPO"
[ "$DRY" = 1 ] || mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

for LABEL in "${LABELS[@]}"; do
  TEMPLATE="$HERE/$LABEL.plist"
  DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
  [ -f "$TEMPLATE" ] || die "テンプレートが無い: $TEMPLATE"
  sed -e "s|__REPO__|$(esc "$REPO")|g" \
      -e "s|__NODE_BIN__|$(esc "$NODE")|g" \
      -e "s|__HOME__|$(esc "$HOME")|g" \
      -e "s|__PATH__|$(esc "$PATH_VALUE")|g" \
      "$TEMPLATE" > "$RENDERED"
  grep -q '__[A-Z_]*__' "$RENDERED" && die "テンプレートの置き換え漏れ（$LABEL）"
  plutil -lint "$RENDERED" >/dev/null || die "plist が不正（$LABEL）"

  if [ "$DRY" = 1 ]; then
    echo "----- $LABEL -----"
    cat "$RENDERED"
    continue
  fi
  install -m 644 "$RENDERED" "$DEST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$DEST"
  case "$LABEL" in
    *.suumo-shinchiku) WHEN="毎週日曜 06:00"; LOG="suumo-shinchiku-crawl.out.log" ;;
    *.suumo-chintai-pets) WHEN="毎週土曜 12:00"; LOG="suumo-chintai-pets-crawl.out.log" ;;
    *.suumo-chintai-maisonette) WHEN="毎週土曜 14:00"; LOG="suumo-chintai-maisonette-crawl.out.log" ;;
    *.suumo-chintai-detail) WHEN="毎週土曜 16:00"; LOG="suumo-chintai-detail.out.log" ;;
    *.suumo-chintai)   WHEN="毎週土曜 06:00"; LOG="suumo-chintai-crawl.out.log" ;;
    *) WHEN="毎日 01:00"; LOG="suumo-crawl.out.log" ;;
  esac
  echo "✓ 登録しました: $DEST（$WHEN）"
  echo "  今すぐ 1 回走らせる: launchctl kickstart gui/$(id -u)/$LABEL"
  echo "  ログ:               tail -f $LOG_DIR/$LOG"
done

if [ "$DRY" = 1 ]; then
  echo "（--dry-run: 登録していない）"
  exit 0
fi
echo "  止める:             bash ops/launchd/uninstall.sh（--only chuko|shinchiku|chintai|chintai_pets|chintai_maisonette|chintai_detail で 1 本だけ）"
