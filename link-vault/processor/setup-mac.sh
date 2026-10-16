#!/usr/bin/env bash
# Link Vault PC setup for Mac (and Linux). Run in Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/ashi40041052-eng/test/main/link-vault/processor/setup-mac.sh | bash
#
# It is safe to run again: finished steps are skipped.
# Overrides (env vars): LV_OWNER, LV_APP_REPO, LV_DATA_REPO, LV_APP_DIR, LV_DATA_DIR, LV_MODEL, LV_HOURS
set -euo pipefail

OWNER="${LV_OWNER:-ashi40041052-eng}"
APP_REPO="${LV_APP_REPO:-test}"
DATA_REPO="${LV_DATA_REPO:-link-vault-data}"
APP_DIR="${LV_APP_DIR:-$HOME/link-vault-app}"
DATA_DIR="${LV_DATA_DIR:-$HOME/link-vault-data}"
MODEL="${LV_MODEL:-opus}"
HOURS="${LV_HOURS:-8 11 14 18 22}"
PROC_DIR="$APP_DIR/link-vault/processor"
TTY=/dev/tty

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
pause() { printf '    %s [Enter で続行] ' "$*"; read -r _ < "$TTY" || true; }

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
OS="$(uname -s)"

# ---------- 1. tools ----------
step "1/7 必要なツールを確認（git / Node.js / Claude Code）"
if ! have git || ! have node; then
  if [ "$OS" = "Darwin" ] && have brew; then
    info "Homebrew で git と Node.js をインストールします"
    brew install git node
  elif [ "$OS" = "Darwin" ]; then
    fail "Node.js が必要です。https://nodejs.org/ から LTS 版をインストールしてから、もう一度このコマンドを実行してください"
  else
    fail "git と Node.js 20 以上をインストールしてから、もう一度実行してください（例: sudo apt install git nodejs npm）"
  fi
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
  fail "Node.js $(node -v) は古いです。20.12 以上に更新してください（https://nodejs.org/）"
fi
info "git $(git --version | awk '{print $3}') / node $(node -v)"

if ! have claude; then
  info "Claude Code をインストールします"
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
  have claude || fail "Claude Code のインストールに失敗しました。https://code.claude.com/ の手順で入れてから再実行してください"
fi
CLAUDE_BIN="$(command -v claude)"
info "claude: $CLAUDE_BIN"

# ---------- 2. Claude login (subscription) ----------
step "2/7 Claude Code のログインを確認"
claude_ok() {
  local out
  out="$(cd /tmp && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN "$CLAUDE_BIN" -p "Reply with OK" \
    --output-format json --tools "" --strict-mcp-config --no-session-persistence --model haiku 2>/dev/null || true)"
  printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.is_error?1:0)}catch{process.exit(1)}})'
}
if claude_ok; then
  info "ログイン済みです"
else
  info "Claude Code にログインが必要です。これから Claude Code が開きます。"
  info "  1) 画面の案内でログイン方法を聞かれたら「Claude アカウント（Pro/Max）」を選ぶ"
  info "     （何も聞かれなければ /login と入力して Enter）"
  info "  2) ブラウザでログインが終わったら、/exit と入力して Enter"
  pause "準備ができたら"
  "$CLAUDE_BIN" < "$TTY" > "$TTY" 2>&1 || true
  claude_ok || fail "まだログインできていないようです。もう一度このコマンドを実行してください"
  info "ログインできました"
fi

# ---------- 3. app code ----------
step "3/7 Link Vault のプログラムを用意"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only -q || info "（更新に失敗しましたが、手元の版で続けます）"
else
  git clone -q "https://github.com/$OWNER/$APP_REPO.git" "$APP_DIR"
fi
info "$APP_DIR"
(cd "$PROC_DIR" && npm ci --silent --no-audit --no-fund)
# X の返信は bsk(browser-skill)で、本人の Chrome(X ログイン済み)から読む。無ければ自動でスキップされる
if command -v bsk >/dev/null 2>&1 && bsk status >/dev/null 2>&1; then info "bsk 利用可(他人のリプライを自動で読めます)"; else info "（bsk が未接続。他人のリプライの取得だけ自動でスキップされます）"; fi

# ---------- 4. data repo ----------
step "4/7 データ用リポジトリ（$DATA_REPO）を用意"
if [ ! -d "$DATA_DIR/.git" ]; then
  info "非公開リポジトリなので、GitHub のログインを聞かれることがあります。"
  info "  Username: $OWNER"
  info "  Password: スマホのアプリに入れたトークン（github_pat_...）を貼り付け（画面には表示されません）"
  if [ "$OS" != "Darwin" ]; then
    # Linux: remember the token for scheduled runs (stored in ~/.git-credentials)
    git config --global credential.helper store
  fi
  git clone "https://github.com/$OWNER/$DATA_REPO.git" "$DATA_DIR" < "$TTY" \
    || fail "クローンに失敗しました。リポジトリ名とトークン（Contents: Read and write）を確認してください"
fi
info "$DATA_DIR"

# ---------- 5. settings ----------
step "5/7 設定ファイル（.env）を作成"
ENV_FILE="$PROC_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  info "既にあるのでそのまま使います: $ENV_FILE"
else
  cat > "$ENV_FILE" <<EOF
LV_DATA_DIR=$DATA_DIR
LV_BACKEND=claude-code
LV_MODEL=$MODEL
LV_CLAUDE_BIN=$CLAUDE_BIN
LV_MAX_PER_RUN=60
EOF
  info "$ENV_FILE"
fi

# ---------- 6. first run ----------
step "6/7 試しに1回実行"
(cd "$PROC_DIR" && node process.mjs) || fail "実行に失敗しました。上のエラーと $PROC_DIR/logs/ を確認してください"

# ---------- 7. schedule ----------
step "7/7 1日の自動実行を設定（${HOURS// /時・}時）"
NODE_BIN="$(command -v node)"
RUN_PATH="$(dirname "$NODE_BIN"):$(dirname "$CLAUDE_BIN"):$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin" # ~/.local/bin: bsk(browser-skill)
if [ "$OS" = "Darwin" ]; then
  LABEL="com.linkvault.processor"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$PROC_DIR/logs"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$LABEL</string>"
    echo "  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$PROC_DIR/run-guarded.mjs</string></array>"
    echo "  <key>WorkingDirectory</key><string>$PROC_DIR</string>"
    echo "  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$RUN_PATH</string></dict>"
    echo "  <key>StandardOutPath</key><string>$PROC_DIR/logs/launchd.log</string>"
    echo "  <key>StandardErrorPath</key><string>$PROC_DIR/logs/launchd.log</string>"
    echo '  <key>StartCalendarInterval</key><array>'
    for h in $HOURS; do echo "    <dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>0</integer></dict>"; done
    echo '  </array>'
    echo '</dict></plist>'
  } > "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  info "登録しました（スリープ中だった分は、起きたときに実行されます）"
  info "止めたいとき: launchctl bootout gui/$(id -u)/$LABEL"

  # archive-only job: every 20 minutes, no AI (saves post text + images). Rewritten and reloaded each time (idempotent).
  ALABEL="com.linkvault.archive"
  APLIST="$HOME/Library/LaunchAgents/$ALABEL.plist"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$ALABEL</string>"
    echo "  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$PROC_DIR/run-guarded.mjs</string><string>--archive-only</string></array>"
    echo "  <key>WorkingDirectory</key><string>$PROC_DIR</string>"
    echo "  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$RUN_PATH</string></dict>"
    echo "  <key>StandardOutPath</key><string>$PROC_DIR/logs/launchd-archive.log</string>"
    echo "  <key>StandardErrorPath</key><string>$PROC_DIR/logs/launchd-archive.log</string>"
    echo '  <key>StartInterval</key><integer>1200</integer>'
    echo '  <key>RunAtLoad</key><true/>'
    echo '</dict></plist>'
  } > "$APLIST"
  launchctl bootout "gui/$(id -u)/$ALABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$APLIST"
  info "20分ごとの保存（アーカイブ）も登録しました。止めたいとき: launchctl bootout gui/$(id -u)/$ALABEL"

  # local PC dashboard (no token): always-on server on 127.0.0.1:4848 reading the cloned data repo
  DLABEL="com.linkvault.dashboard"
  DPLIST="$HOME/Library/LaunchAgents/$DLABEL.plist"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$DLABEL</string>"
    echo "  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$PROC_DIR/dashboard-server.mjs</string></array>"
    echo "  <key>WorkingDirectory</key><string>$PROC_DIR</string>"
    echo "  <key>StandardOutPath</key><string>$PROC_DIR/logs/launchd-dashboard.log</string>"
    echo "  <key>StandardErrorPath</key><string>$PROC_DIR/logs/launchd-dashboard.log</string>"
    echo '  <key>RunAtLoad</key><true/>'
    echo '  <key>KeepAlive</key><true/>'
    echo '</dict></plist>'
  } > "$DPLIST"
  launchctl bootout "gui/$(id -u)/$DLABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$DPLIST"
  info "PC用ダッシュボード: http://127.0.0.1:4848/ （トークン不要。ブックマークしてください）"
else
  have crontab || fail "crontab がありません。cron をインストールしてから再実行してください"
  MARK="# link-vault-processor"
  LINE="0 ${HOURS// /,} * * * cd \"$PROC_DIR\" && PATH=\"$RUN_PATH\" \"$NODE_BIN\" run-guarded.mjs >> \"$PROC_DIR/logs/cron.log\" 2>&1 $MARK"
  mkdir -p "$PROC_DIR/logs"
  AMARK="# link-vault-archive"
  ALINE="*/20 * * * * cd \"$PROC_DIR\" && PATH=\"$RUN_PATH\" \"$NODE_BIN\" run-guarded.mjs --archive-only >> \"$PROC_DIR/logs/cron-archive.log\" 2>&1 $AMARK"
  { crontab -l 2>/dev/null | grep -v "$MARK" | grep -v "$AMARK" || true; echo "$LINE"; echo "$ALINE"; } | crontab -
  info "cron に登録しました（分析は1日の指定時刻、保存は20分ごと）"
fi

printf '\n\033[1;32m✓ セットアップ完了！\033[0m\n'
info "スマホで保存したリンクは、約20分ごとに本文・画像が保存され、${HOURS// /時・}時 に自動で分析されます。"
info "今すぐ分析したいとき: cd \"$PROC_DIR\" && node process.mjs"
info "ログ: $PROC_DIR/logs/"
