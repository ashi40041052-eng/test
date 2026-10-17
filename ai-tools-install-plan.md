# 7つの AI ツール 導入手順書(Mac のセッションに渡す用)

調べた日: 2026-10-17(クラウドのセッションで調査。Mac での導入はまだ)

## 確認できなかったこと(Mac 側で最初にやる)
- X の元投稿は、クラウドからは開けなかった。bsk で投稿と返信を開き、下の8つのリンクと一致するか照合する。
- スター数は GitHub に直接つながらず、確かめられなかった(検索結果の数字は出どころによってばらつく)。各リポジトリのページで、作者とスター数を確認する。
- 依頼文の番号は 1,2,4〜9 で 8項目ある(3番が欠番)。「7つ」とずれているので確認する。

## 特定したリポジトリと3行まとめ

| # | 道具 | リポジトリ(作者) | Apple Silicon | 有料キー・アカウント | 今ある物とのかぶり |
|---|---|---|---|---|---|
| 1 | Hindsight | vectorize-io/hindsight | 動く(Docker / pip) | 記憶の整理に LLM が要る。`claude-code`(Pro/Max 契約)や Ollama を使えば追加のキーは不要 | HANDOFF.md・メモリと役目がかぶる |
| 2 | paperclip | paperclipai/paperclip | 動く(Node、`npx paperclipai onboard`) | アカウント不要・自前で動かす。お試しには ANTHROPIC_API_KEY が要る | AI オフィスとかぶる。予算の上限・承認の流れはこちらにある |
| 4 | security-audit-skill | cloudflare/security-audit-skill | 動く(スキルなので場所を選ばない) | 不要 | webapp-security スキルと比べる対象 |
| 5 | WeKnora | Tencent/WeKnora | 動く(Docker Compose、重い) | Ollama を使えば不要。クラウドの LLM を使うならキーが要る | 達成ノート MCP と検索の役目が一部かぶる |
| 6 | treg | superdesigndev/treg | 動く(pip `tools-registry`) | **ログインが要る。外部の API を使うたびに前払いの残高から引かれる** | 下の注意を参照 |
| 7 | mobile-mcp | mobile-next/mobile-mcp | 動く(Xcode とシミュレーターが要る) | 不要 | なし |
| 8 | CLI-Anything | HKUDS/CLI-Anything | 動く(Python、Claude Code プラグイン) | 不要 | なし |
| 9 | claude-code-templates | davila7/claude-code-templates | 動く(`npx claude-code-templates`) | 不要 | 設定集が今の skills・hooks とかぶる可能性 |

## 注意: treg は依頼の目的と合わない可能性が高い
README によると treg は「AI 用の道具の OpenRouter」で、外部の有料 API(SEO・SNS・企業情報など)を1回ごとの課金で呼べるようにする窓口。
「今つながっている MCP を整理して、会話の最初のトークンを減らす・止まっている MCP を見える化する」道具ではない。
→ 入れる前に、本当にこれを使うか聞く。目的が「MCP の整理とトークン削減」なら、別の手段を提案する
(使っていない MCP を外す、`claude mcp list` で状態確認、Claude Code の MCP ツール遅延読み込み設定など)。

## 止まって聞く所(依頼の決まりに従う)
- treg: ログインと前払い残高
- Hindsight / WeKnora: クラウドの LLM を使う場合の API キー(Ollama か Claude 契約を使えば不要)
- paperclip: お試しの `test-drive` は API キーを使う
- Hindsight Cloud / WeKnora Cloud / Paperclip Cloud: どれも使わない(自前で動かす)

## 導入コマンド(README より)
1. Hindsight
   `docker run -d --name hindsight --restart unless-stopped -p 8888:8888 -p 9999:9999 -e HINDSIGHT_API_LLM_PROVIDER=<claude-code か ollama> ... ghcr.io/vectorize-io/hindsight:latest`
   MCP: `http://localhost:8888/mcp/{bank_id}/`。Claude Code 連携は hindsight.vectorize.io の claude-code の手順。
   常に動かす物 → `--restart unless-stopped` と Docker Desktop の「ログイン時に起動」。
2. paperclip: `npx paperclipai@latest onboard --yes`。AI オフィスとの比較を先に書く。
4. security-audit-skill: `npx skills add https://github.com/cloudflare/security-audit-skill --skill security-audit --global`
5. WeKnora: clone して `docker compose up -d`(画面は 80 番、API は 8080 番)。重いので使う時だけ起動。Claude Code へは付属の MCP サーバーでつなぐ。
6. treg: 上の注意の通り、先に確認。
7. mobile-mcp: `claude mcp add mobile-mcp -- npx -y @mobilenext/mobile-mcp@latest`。先に `xcrun simctl boot` でシミュレーターを起動しておく。
8. CLI-Anything: `/plugin marketplace add HKUDS/CLI-Anything` → プラグインを入れる → `/cli-anything <アプリ>`。
   対象アプリの候補は Mac で `ls /Applications` を見て決める(字幕・音量・書き出しなら DaVinci Resolve / Kdenlive / Shotcut / Audacity などが入っていれば有力)。
9. claude-code-templates: `npx claude-code-templates@latest --analytics`(使った量)/ `--health-check`。設定集は候補を出すだけで、入れるのは OK の後。

## 担当の分け方(同じ設定ファイルを同時に触らない)
- MCP を追加する物(Hindsight・WeKnora・mobile-mcp・treg)は1人が順番に担当する。
- スキル・プラグインだけの物(security-audit・CLI-Anything・templates)と paperclip の比較は、別の人が並行して進めてよい。
- 最後にレビュー担当が全部を通しで確かめ、結果の表を ~/Desktop/Claude受け渡し/完成品/ に置く。
