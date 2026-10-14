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
| AI 処理 | `links/` は**読むだけ**で絶対に書き換えない。分析結果は別フォルダ。失敗しても元データは無傷で、次回再挑戦（3回まで） |
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

### 4. PC 側（AI 分析）

必要なもの: [Node.js](https://nodejs.org/) 20.12 以上、git、[Claude API キー](https://console.anthropic.com/)

```bash
git clone https://github.com/<ユーザー名>/link-vault-data.git   # データリポジトリ
cd <このリポジトリ>/link-vault/processor
npm install
cp .env.example .env    # Windows: copy .env.example .env
```

`.env` に `ANTHROPIC_API_KEY` と `LV_DATA_DIR`（上でクローンしたフォルダのパス）を記入。

手動で1回実行して確認:

```bash
npm run process
```

#### 1日5回の自動実行

**Windows**（8:00 / 11:00 / 14:00 / 18:00 / 22:00。PCが切れていた時間の分は次に起動したときに実行）:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows-task.ps1
```

時刻を変えたいとき: `.\install-windows-task.ps1 -Times "07:30","12:00","20:00"`

**Mac / Linux**（`crontab -e`）:

```cron
0 8,11,14,18,22 * * * cd /path/to/link-vault/processor && /usr/local/bin/node process.mjs
```

ログは `processor/logs/` に残ります。

## 使い方

### スマホでリンクを入れる

- **Android**: X などで「共有」→ **Link Vault** を選ぶだけ（アプリが開いて即保存）
- **iPhone / 共通**: リンクをコピー → アプリを開いて **「📋 コピーしたリンクを保存」** をタップ
- 入力欄に URL を貼り付けても即保存。メモを付けたいときは文章と一緒に書いて「保存」
- 1回に複数の URL を貼ると、それぞれ別のリンクとして保存
- LINE に貼っていた文章ごと貼っても OK（URL 以外の部分はメモとして残り、AI の分類の参考になります）

### 見る

「一覧」タブ: **時系列**（日付ごと）と**カテゴリ**の切り替え、キーワード検索、カテゴリで絞り込み。
まだ PC で分析されていないものも「送信済み・分析待ち」「端末に保存済み・送信待ち」として表示されます。

### AI に読ませる

データリポジトリの `knowledge/` フォルダが AI 用です。

- `knowledge/README.md` … 目次（カテゴリ一覧と件数）
- `knowledge/timeline.md` … 全リンク（新しい順、要約・ポイント付き）
- `knowledge/categories/<カテゴリ>.md` … カテゴリ別
- `knowledge/links.jsonl` … 機械処理用

例:
- Claude Code / Cursor 等でデータリポジトリを開いて「knowledge を読んで、最近保存したAI活用のアイデアをまとめて」
- Claude の Projects に `knowledge/` の md をアップロード
- GitHub 連携できる AI に `link-vault-data` リポジトリを渡す

## カテゴリについて

- AI は既存カテゴリから選び、どれにも合わないときだけ新カテゴリを作ります
- カテゴリ一覧はデータリポジトリの `categories.json`。名前や説明を手で直しても OK（説明は AI の判断材料になります）
- 最初からカテゴリを決めておきたい場合は、`categories.json` に `[{"name": "AI活用", "description": "..."}]` の形で書いておく
- 全部分類し直したいとき: データリポジトリの `analysis/` フォルダを消して `npm run process`（元データは `links/` にあるので何も失われません）

## X（旧Twitter）のポストについて

X のページはログインなしで本文が読めないため、公開 API の [FxTwitter](https://github.com/FxEmbed/FxEmbed) 経由で本文を取得しています。
取得できなかったときは URL とメモだけで分類し、要約に「推測」と書かれます。

## 費用の目安

1リンクあたり（本文〜数千字の場合）:

| モデル (`LV_MODEL`) | 目安 |
|---|---|
| `claude-opus-5-5`（既定・最高精度） | 約 $0.02〜0.05 |
| `claude-haiku-5-5`（分類には十分） | 約 $0.001 |

月に300リンクなら Opus で $6〜15 程度、Haiku なら 50円程度です。コストを抑えたいときは `.env` で `LV_MODEL=claude-haiku-5-5` にしてください。

## データの形式

```
link-vault-data/
├── links/2026/10/20261014-120305-a1b2c3d4.json   ← スマホが作る（不変）
├── analysis/2026/20261014-120305-a1b2c3d4.json    ← AI 分析結果
├── categories.json
├── index.json                                       ← アプリの一覧が読む
└── knowledge/                                       ← AI 用 Markdown
```

`links/*.json`:

```json
{ "id": "20261014-120305-a1b2c3d4", "url": "https://x.com/...", "note": "メモ", "text": "貼り付けた原文",
  "created_at": "2026-10-14T21:03:05+09:00", "via": "share", "client": "link-vault-pwa" }
```

## 開発

```bash
cd link-vault/processor
npm test              # 単体テスト + E2E（偽の Claude API・偽の Web ページで process.mjs を実行）
npm run rebuild       # AI を呼ばずに index.json / knowledge だけ再生成
node process.mjs --no-git --data /path/to/data   # git 操作なし
```
