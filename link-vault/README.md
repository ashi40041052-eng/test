# Link Vault

X などで見つけた「いいな」と思ったリンクを、スマホからコピペ1回で保存。
PC が 1 日数回 AI（Claude）で中身を読んで要約し、**時系列**と**カテゴリ別**に自動で振り分けます。
人が見るダッシュボードと、AI に読ませるための Markdown の両方を自動生成します。

```
 スマホ (PWA)                    GitHub (非公開リポジトリ)            PC (1日5回)
┌──────────────┐  送信(API)    ┌─────────────────────┐  git pull  ┌────────────────────┐
│ 貼り付け/共有 │ ───────────▶ │ links/   元データ      │ ─────────▶ │ ページ取得           │
│   ↓ 即保存    │               │ analysis/ AI分析結果   │            │ Claude で要約・分類   │
│ 端末内に保存  │ ◀─────────── │ index.json 一覧用      │ ◀───────── │ index/knowledge 生成  │
│ (送れるまで保持)│  一覧を取得   │ knowledge/ AI読込用MD  │  git push  └────────────────────┘
└──────────────┘               └─────────────────────┘
```

## リンクが絶対に消えない仕組み

| 段階 | 守り方 |
|---|---|
| 保存した瞬間 | 通信より**先に**端末内の IndexedDB（強い書き込み保証）と localStorage の**2か所**に保存。通信状態は一切関係なし |
| 電波が悪い | 端末に残ったまま「未送信 N件」と表示。アプリを開く・電波が戻る・1分ごと、に自動再送。Android は閉じていても電波回復時に再送（Background Sync） |
| 送信途中で切れた | 1リンク=1ファイル・ユニークID・**新規作成のみ**なので、再送しても重複・上書きは起きない（既に届いていたら成功扱い） |
| 送信後 | 端末のデータは**削除しない**（送信済みの印を付けるだけ）。設定から JSON で書き出しも可能 |
| サーバー側 | GitHub の git 履歴に全部残る。PC にもクローン（完全コピー）がある |
| AI 処理 | `links/` は**読むだけ**で絶対に書き換えない。分析結果は別フォルダ。失敗しても元データは無傷で、次回以降に自動で再挑戦 |
| 間違えて保存した | 削除は「ゴミ箱に入れる」方式。一覧・AI 用データからは消えるが、設定タブのゴミ箱から戻せる（削除の操作もオフラインで記録→あとで送信） |
| 端末のデータ消去対策 | 起動時にストレージ永続化を要求。IndexedDB が消えても localStorage の控えから自動復元 |

> iPhone は「ホーム画面に追加」して使ってください。Safari のタブのままだと、長期間開かないとブラウザがデータを消すことがあります（ホーム画面アプリは対象外）。

## セットアップ（初回だけ・約15分）

### 1. データ用の非公開リポジトリを作る

GitHub で新しいリポジトリを作成します。

- 名前: `link-vault-data`（何でもよい）
- **Private（非公開）** を選ぶ
- 「Add a README file」にチェック

### 2. スマホ用のトークンを作る

GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token

- Repository access: **Only select repositories** → `link-vault-data` だけ
- Permissions → Repository permissions → **Contents: Read and write**
- 有効期限は長め（期限が切れたらアプリに「送信エラー」と出ます。リンクは端末に残っているので、新しいトークンを入れれば送られます）

### 3. アプリを公開してスマホに入れる

`link-vault/app/` は単なる静的ファイルです。どこに置いても動きます。

- **GitHub Pages**: このリポジトリの Settings → Pages → Branch: `main` / `/ (root)` →
  `https://<ユーザー名>.github.io/<リポジトリ名>/link-vault/app/` で開けます
  （無料プランではリポジトリが Public の必要があります。アプリのコードだけで、リンクのデータは非公開リポジトリ側なので見られません）
- 別の手段: Cloudflare Pages / Netlify に `link-vault/app` フォルダをアップロード

スマホでそのURLを開き、

- **Android (Chrome)**: メニュー →「アプリをインストール」/「ホーム画面に追加」
- **iPhone (Safari)**: 共有ボタン →「ホーム画面に追加」

アプリの「設定」タブで、オーナー名・リポジトリ名（`link-vault-data`）・トークンを入れて「保存して接続テスト」。

### 4. PC 側（AI 分析）— コマンド1つ

分析は PC の Claude Code にサブスク（Pro / Max）のまま任せるので、**API キーも追加料金も不要**です。
下のコマンドを貼り付けて Enter を押すだけで、必要なものを順番に用意します：

1. git / Node.js / Claude Code の確認とインストール
2. Claude Code のログイン確認（未ログインなら案内が出る）
3. プログラムのダウンロード
4. データ用リポジトリ（`link-vault-data`）のダウンロード
5. 設定ファイル（`.env`）の作成
6. 試しに 1 回実行
7. 1 日 5 回（8・11・14・18・22 時）の自動実行を登録

**Windows**（スタートメニューで「PowerShell」を開いて貼り付け）:

```powershell
irm https://raw.githubusercontent.com/ashi40041052-eng/test/main/link-vault/processor/setup-windows.ps1 | iex
```

- 途中で GitHub のログイン画面が開いたら、案内どおりにログインしてください
- PC が切れていた時間の分は、次に起動したときに実行されます

**Mac**（「ターミナル」を開いて貼り付け。Linux でも動きます）:

```bash
curl -fsSL https://raw.githubusercontent.com/ashi40041052-eng/test/main/link-vault/processor/setup-mac.sh | bash
```

- GitHub の Username / Password を聞かれたら、Username は自分のユーザー名、Password には**スマホに入れたトークン（`github_pat_...`）**を貼り付け（入力しても画面には表示されません）
- スリープ中だった分は、起きたときに実行されます

どちらも、何度実行しても大丈夫です（終わっている手順は飛ばします）。

> Claude Code のログインは、API キーではなく **Claude アカウント（サブスク）** を選んでください。
> PC に `ANTHROPIC_API_KEY` が設定されていても、このスクリプトは Claude Code に渡さないので API 課金にはなりません。

<details>
<summary>手動でセットアップする場合</summary>

```bash
git clone https://github.com/<ユーザー名>/test.git link-vault-app
git clone https://github.com/<ユーザー名>/link-vault-data.git
cd link-vault-app/link-vault/processor
npm ci
cp .env.example .env    # LV_DATA_DIR にデータリポジトリのパスを書く
npm run process         # 1回実行
```

自動実行: Windows は `powershell -ExecutionPolicy Bypass -File .\install-windows-task.ps1`、
Mac / Linux は cron に `0 8,11,14,18,22 * * * cd /path/to/processor && node process.mjs`。
`claude` が見つからないと言われたら `.env` の `LV_CLAUDE_BIN` にフルパス（`which claude` / `where claude`）を書いてください。

</details>

ログは `processor/logs/` に残ります。

## 使い方

### スマホでリンクを入れる

- **Android**: X などで「共有」→ **Link Vault** を選ぶだけ（アプリが開いて即保存）
- **iPhone / 共通**: リンクをコピー → アプリを開いて **「📋 コピーしたリンクを保存」** をタップ
- 入力欄に URL を貼り付けても即保存。メモを付けたいときは文章と一緒に書いて「保存」
- 1回に複数の URL を貼ると、それぞれ別のリンクとして保存
- LINE に貼っていた文章ごと貼っても OK（URL 以外の部分はメモとして残り、AI の分類の参考になります）

### 間違えたとき（削除）

- 各リンクの右下の 🗑 を押す → 確認して削除。直後に出る「元に戻す」でも取り消せます
- 削除したリンクは一覧と AI 用ファイル（`knowledge/`）から消え、AI の分析もされません
- 戻したいときは「設定」タブの **ゴミ箱** →「↩ 戻す」
- 元データ自体は非公開リポジトリに残ります（「絶対消えない」を守るため）。完全に消したい場合は、データリポジトリの `links/` から該当ファイルを手で削除してください

### 見る

「一覧」タブ: **時系列**（日付ごと）と**カテゴリ**の切り替え、キーワード検索、カテゴリで絞り込み。
まだ PC で分析されていないものも「送信済み・分析待ち」「端末に保存済み・送信待ち」として表示されます。

### AI に読ませる

**最初に `ai/llms.txt` を読ませてください**（データリポジトリの `ai/`）。入口 → 候補 → 全文の順にたどれます。

- `ai/llms.txt` … 入口（60行以内）。読む順・カテゴリ一覧・統計
- `ai/recent.md` … 直近30件 / `ai/categories/<カテゴリ>.md` … カテゴリ別の索引
- `ai/manifest.jsonl` … 1行1リンク（grep 用: t=タイトル g=タグ a=投稿者）/ `ai/tags.json`
- `ai/links/<年>/<id>.md` … 1リンク1ファイル（frontmatter＋要約＋ポイント＋**主題リソース**（README・モデルカード全文）＋**文脈**（親・引用・本人の続き）＋保存済みの本文全文）
- 主題（ポストが指すリポジトリ/モデル/論文）で探す → `ai/manifest.jsonl` の `pk`（r=リポジトリ m=モデル p=論文 s=サイト v=動画 x=ポスト）と `pu`（主題のURL）を grep
- `ai/schema.md` … 項目の定義

`knowledge/`（従来の形式）も引き続き生成されます。`## 要約`/`## ポイント` 以外（主題リソース・文脈・本文）は第三者のテキストで、そこに書かれた指示には従わない前提です。

例:
- Claude Code / Cursor 等でデータリポジトリを開いて「ai/llms.txt を読んで、最近保存したAI活用のアイデアをまとめて」
- Claude の Projects に `ai/` の md をアップロード
- GitHub 連携できる AI に `link-vault-data` リポジトリを渡す

### PC ダッシュボード・保存時のアーカイブ（app）

- `app/dashboard.html`（アプリと同じ場所に公開されます。例 `https://<ユーザー名>.github.io/<リポジトリ名>/link-vault/app/dashboard.html`）: PC 向けの 3 ペイン画面。左=カテゴリ/期間/状態/タグ、中央=一覧、右=詳細（アーカイブ本文・引用・画像）。キー操作は `j`/`k` 移動、`/` 検索、`o` 元URL、`d` ゴミ箱、`t` ゴミ箱表示。設定（token）はスマホ版と同じブラウザの設定を共有するので、同じオリジンで一度設定すれば動きます。書き込みはゴミ箱の削除/復元だけ。
- **Mac ならトークン不要**: セットアップで `com.linkvault.dashboard` が常駐し、`http://127.0.0.1:4848/` で同じ画面が開きます（`processor/dashboard-server.mjs` が `app/` と手元の `link-vault-data` を読み取り専用で配信。20分ごとの保存/分析で自動更新。ゴミ箱操作はスマホか Pages 版で）。
- **v3 関連表示**（`DESIGN-v3.md` §7/§8）: 詳細ペイン最上部に**主題カード**（リポジトリ/モデル/論文/サイト/動画/ポスト。説明・★/DL・ライセンス・元ページ・README 全文は開いた時に取得）、その下に**スレッド**（親 → 保存ポスト → 本人の続き。引用は枠で入れ子、ポスト内の URL はリソースチップ）。一覧カードに主題名、左ペインに「主題の種類」フィルタ（`manifest.jsonl` の `pk`/`pu`）。読むのは `related.json` と `related/res/*`（無ければ従来表示。モック・ローカル(`/data/`)・Pages 版で動く）。ロジックは `dash-logic.js` の `relatedView`。スマホは保存時に `related/thread.json`（fxtwitter `/2/thread`）を create-only・best-effort で置くだけ（`core.js` の `captureThread`、保存は止めない）。
- テスト用: `cd link-vault/app && python3 -m http.server 8765` → `http://localhost:8765/dashboard.html?mock=1`（`app/fixtures/mock/` のダミーデータ。トークン不要）。
- 保存時アーカイブ: X のリンクを送信できた直後に、スマホが fxtwitter から本文と画像（最大4枚）を `archive/<年>/<id>/` に create-only で保存します。保存・送信の成否には影響せず、失敗しても processor が後で拾います。
- 純ロジックのテスト: `node --test link-vault/app/test`

## カテゴリについて

- AI は既存カテゴリから選び、どれにも合わないときだけ新カテゴリを作ります
- カテゴリ一覧はデータリポジトリの `categories.json`。名前や説明を手で直しても OK（説明は AI の判断材料になります）
- 最初からカテゴリを決めておきたい場合は、`categories.json` に `[{"name": "AI活用", "description": "..."}]` の形で書いておく
- 全部分類し直したいとき: データリポジトリの `analysis/` フォルダを消して `npm run process`（元データは `links/` にあるので何も失われません）

## X（旧Twitter）のポストについて

X のページはログインなしで本文が読めないため、公開 API の [FxTwitter](https://github.com/FxEmbed/FxEmbed) 経由で本文を取得しています。
取得できなかったときは URL とメモだけで分類し、要約に「推測」と書かれます。

## 費用

**追加料金なし**（Claude の Pro / Max プランの範囲内）。GitHub もアプリも無料です。

- 分析は 1 回の実行で最大 5 件ずつまとめて Claude Code に渡すので、プランの利用枠の消費は少なめです
- 枠をもっと節約したいときは `.env` で `LV_MODEL=haiku`（カテゴリ分けなら十分）。精度重視なら `opus`（既定）
- プランの上限に達して分析が失敗しても、リンクは消えません。失敗分は次の実行で自動的に再挑戦します（3回失敗したら、その後は1日1回ずっと再挑戦）

<details>
<summary>Claude API（従量課金）で動かす場合</summary>

PC で Claude Code を使わない場合は、`.env` に `LV_BACKEND=api` と `ANTHROPIC_API_KEY` を設定すると Claude API で分析します。
目安は 1 リンクあたり Opus で約 $0.02〜0.05、Haiku（`LV_MODEL=claude-haiku-5-5`）で約 $0.001 です。

</details>

## データの形式

```
link-vault-data/
├── links/2026/10/20261014-120305-a1b2c3d4.json   ← スマホが作る（不変）
├── events/2026/10/20261014-130000-e5f6a7b8.json  ← 削除/復元の記録（スマホが作る・不変）
├── analysis/2026/20261014-120305-a1b2c3d4.json    ← AI 分析結果
├── categories.json
├── index.json                                       ← アプリの一覧が読む
├── knowledge/                                       ← AI 用 Markdown（従来形式）
├── ai/                                              ← AI の入口（llms.txt・manifest・links/*.md）
└── archive/2026/20261014-120305-a1b2c3d4/           ← 本文・画像のスナップショット（不変）
    ├── snapshot.json                                  作成後は絶対に上書きしない（create-only）
    ├── media/01.jpg                                   画像・動画（ファイルの有無が正）
    ├── attempts.json                                  取得失敗の記録（snapshot ができたら触らない）
    ├── related.json                                   v3: 文脈グラフ+リソース台帳+主題（create-only）
    ├── related-attempts.json                          related.json ができるまでの失敗記録
    └── related/                                       posts/<id>.json=親・引用・本人の続き（fxtwitter v2 そのまま）,
                                                       res/NN-種類-名前.{json,md}=GitHub README・HF モデルカード・論文 abstract・Web 本文,
                                                       thread.json=スマホが置いた /2/thread（あれば processor はこれを使う）
```

**related（v3、`DESIGN-v3.md`）**: X のポストは、それが指すもの（GitHub/HF/論文/サイト）のために保存される、という前提で、processor が archive の直後に `related.json` を作ります。`/2/thread` から親（3段まで）・引用（1段）・本人の続きのリプ（5件まで）を取り、その中の URL（t.co 展開済み・重複除去・1リンク8件まで）を種類別に取得します（GitHub=repo メタ+README、HF=モデルカード（gated で raw README が 401 のときは公開ページの本文を保存し `body_source: page` と記録）、arXiv=abstract（3秒間隔・1回20件）、YouTube=oembed、その他=本文）。主題（`primary`）は URL の位置で点数化して決め、AI の `primary_subject` と両方を記録します（`ai/` では AI 側を優先）。`index.json` の各項目にも `primary_subject` / `resource_kind` を入れます（ダッシュボードが AI の主題を優先表示）。AI がバッチの一部にしか答えなかったリンクは、同じ実行内で残りだけをもう1回だけ聞き直します。`related.json` は再取得しません。やり直したいときは `archive/<年>/<id>/` の `related*` を手で消してください。取得に失敗したリソースは次の実行で最大5回、以後1日1回再試行します。他人の返信の Grok X 検索は**既定で無効**（`LV_XSEARCH=1` を明示したときだけ。本人の指示で Grok の自動利用は禁止）。有効時は条件つき(本文が「リプ欄」等を指し自己スレッドに URL が無い／資源が 0 件でツール系の話)で Grok の X 検索を1ランあたり最大 `LV_XSEARCH_PER_RUN`(既定3)回だけ使い、`related/x-search.json` に生の応答を保存します(利用枠エラーで24時間停止、`LV_GROK_BIN` で差し替え)。**他人のリプライ(既定)**は、本人のログイン済み X をブラウザ(playwright/Chromium、`~/.link-vault/x-profile`)で読みます。最初に一度だけ `cd processor && npm run x-login` で X にログインしてウィンドウを閉じてください(セットアップ `setup-mac.sh` が Chromium を入れます)。直近7日に保存した、主題が資源でないリンクなどで、1ランあたり `LV_XREPLIES_PER_RUN`(既定4)件まで読み、`related/x-replies.json` に保存します。ログインが切れたら `processor/logs/x-login-required.json` ができ、`npm run x-login` で再開します(`LV_XREPLIES=0` で無効。`DESIGN-v3.md` v3.2)。URL の無い引用/親ポストの投稿者はプロフィールのサイト(リンクハブは公式ドメイン優先)も候補にします(`DESIGN-v3.md` 付録)。これらの追記で資源が増えた分析済みリンクは `--reanalyze-related` で分析し直されます(ダッシュボードの「その他のリソース」に由来を表示)。GitHub は `gh auth token` があれば使います（無くても動きます）。

`archive/` は PC の processor（20分ごとの `node process.mjs --archive-only`、AI なし）が埋め、スマホが先に作った分は上書きしません。再取得したいときは、そのリンクの `archive/<年>/<id>/` を手で消してください（分析の再実行では消えません）。画像は1枚5MB・最大8枚、動画は20MBまで1本、1回の実行で合計150MB、archive が2GBを超えたら動画の保存を止めます。fxtwitter で3回連続「見つからない」だと削除済み（`gone`）として週1回だけ再試行します。

`links/*.json`:

```json
{ "id": "20261014-120305-a1b2c3d4", "url": "https://x.com/...", "note": "メモ", "text": "貼り付けた原文",
  "created_at": "2026-10-14T21:03:05+09:00", "via": "share", "client": "link-vault-pwa" }
```

## 開発

```bash
cd link-vault/processor
npm test              # 単体テスト + E2E（偽の claude コマンド・偽の Claude API・偽の Web ページで process.mjs を実行）
npm run rebuild       # AI を呼ばずに index.json / knowledge だけ再生成
node process.mjs --no-git --data /path/to/data   # git 操作なし
node process.mjs --archive-only                  # 本文・画像・関連（related）の保存だけ（AI なし・20分ごとの launchd/cron ジョブ）
node process.mjs --reanalyze-related             # related.json があり analysis に primary_subject が無いリンクだけ分析し直す（他は触らない）
bash test/record-fixtures.sh                     # テスト用の実 API 応答（fxtwitter v2・GitHub・HF・arXiv・YouTube）を録り直す
# テスト用の環境変数: LV_FXTWITTER_BASE（fxtwitter の代わり）, LV_GITHUB_BASE / LV_HF_BASE / LV_ARXIV_BASE / LV_YOUTUBE_BASE, LV_NO_ENV_FILE=1, LV_LOCK_FILE=<path>
```
