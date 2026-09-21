#!/bin/bash
# SUUMO 日次クロール（Mac 側）を launchd から外す。ログと ~/.config/fukuoka-condo-watch/env は残す。
set -euo pipefail
LABEL="com.kechiiiiin.fukuoka-condo-watch.suumo"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || echo "（launchd には登録されていなかった）"
rm -f "$DEST"
echo "✓ 外しました。トークンも消すなら: rm ~/.config/fukuoka-condo-watch/env && npx wrangler secret delete LISTINGS_INGEST_TOKEN"
