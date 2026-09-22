#!/bin/bash
# SUUMO クロール（Mac 側）を launchd から外す。ログと ~/.config/fukuoka-condo-watch/env は残す。
#   bash ops/launchd/uninstall.sh                    # 中古・新築の 2 本とも
#   bash ops/launchd/uninstall.sh --only shinchiku   # 1 本だけ（chuko / shinchiku）
set -euo pipefail
case "${1:-}" in
  "") LABELS=("com.kechiiiiin.fukuoka-condo-watch.suumo" "com.kechiiiiin.fukuoka-condo-watch.suumo-shinchiku") ;;
  --only)
    case "${2:-}" in
      chuko) LABELS=("com.kechiiiiin.fukuoka-condo-watch.suumo") ;;
      shinchiku) LABELS=("com.kechiiiiin.fukuoka-condo-watch.suumo-shinchiku") ;;
      *) echo "--only には chuko か shinchiku を" >&2; exit 1 ;;
    esac ;;
  *) echo "不明な引数: $1" >&2; exit 1 ;;
esac
for LABEL in "${LABELS[@]}"; do
  DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || echo "（$LABEL は launchd に登録されていなかった）"
  rm -f "$DEST"
  echo "✓ 外しました: $LABEL"
done
echo "  トークンも消すなら（両方外したときだけ）: rm ~/.config/fukuoka-condo-watch/env && npx wrangler secret delete LISTINGS_INGEST_TOKEN"
