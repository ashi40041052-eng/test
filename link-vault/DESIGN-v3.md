# Link Vault v3 設計書（関連キャプチャ: 親・引用・スレッド・リンク先リソース）

作成 2026-10-16。v2(archive/ai/dashboard)は維持。v3 は「**X のポストは、それが指しているもの(GitHub/HF/論文/サイト)のために保存される**」という最重要要件に応える。
v1/v2 の約束(`links/` `events/` `snapshot.json` 不変、`analysis/` 再生成可能)は全部維持し、新しい取得物は **別ファイル**に置く。

## 0. 現状の失敗(実データ 8 件、`~/link-vault-data/archive/2026/`)

| id | 何が起きたか |
|---|---|
| `012352-c07e399d` | 本文「ソースコード https://github.com/builderio/agent-native」の自己リプ。親(解説 14 行+Builder.io の動画付き引用)も README も読まずに要約が「推測」で終わった。さらに次の自己リプに公式ブログ URL がある |
| `012832-4aeb4268` | 本文が HF の URL だけ(`fishaudio/drama-3`)。親 `2110164446710775839` もモデルカードも未取得 |
| `011758-a27279bf` | Flux3 の解説。本文に「**リプのURL**をAIにぶん投げたら使える」とあるが、自己リプ 2 件(HF の comfy 版・base 版)を一切追っていない |
| `012146-84c52ab8` | 引用先 `@iru_cection` の本文に `github.com/MaryCache/imozuru`。引用の URL は snapshot にあるが、リポジトリは読んでいない |
| `012630-edf5281f` / `012940-4a559f19` | 引用先(MireloAI / 自分の過去ポスト)が主題。引用の中身は取れているが分析では脇役扱い |

共通点: **主題は X の外か、保存ポストの隣(親・引用・自己リプ)にある**。v2 は保存ポスト 1 枚だけを見ている。

## 1. 調査で確認した事実(2026-10-16、curl)

- `api.fxtwitter.com/2/thread/<id>` → `{status, thread:[...], author}`。`thread` は**投稿者本人の連なり**(先祖 → 保存ポスト → 本人の後続リプ)が時系列で入る。c07e399d なら [親解説, ソースコード, 公式サイト] の 3 件、a27279bf なら [本文, Comfy-UI版 HF, Basemodel HF] の 3 件。各要素に `raw_text.facets[type=url].replacement`(t.co 展開済み)・`card`・`quote`(1 段、本文+media)・`media`・`replying_to{status}` がある。**これだけで親チェーン・自己スレッド・引用が一度に取れる。** v1 `/status` に無かった `replying_to.status` も v2 には必ずある。
- `thread` は本人の自己リプだけ。他人の返信(「リプ欄の情報」)は取れない。X 公式 API は有料、`grok-api` CLI は image/video/auth のみで検索は MCP `search_x` だけ(利用枠あり・結果が本文の生データでない)。**→ 他人のリプは v3 の対象外**(やらないこと参照)。保存ポスト自身が他人への返信なら、親は `status.replying_to.status` を `/2/status/<id>` で辿る(本人以外でも取れる。N=3 まで)。
- GitHub: `gh api repos/<o>/<r>` と `/readme`(base64)。Mac の `gh` は認証済み(5000 req/h)。無認証でも 60/h で足りる(processor は `gh auth token` があれば使う)。
- Hugging Face: `huggingface.co/api/{models|datasets|spaces}/<id>`(200、`cardData, tags, pipeline_tag, downloads, likes, lastModified, siblings, gated`)+ `/<id>/raw/main/README.md`(モデルカード本文)。無認証で可。
- arXiv: `export.arxiv.org/api/query?id_list=` は連打で 429。`arxiv.org/abs/<id>` は HTML 200。**1 回/3 秒、1 ランに 20 件まで**。
- YouTube: `youtube.com/oembed?url=…&format=json`(title/author/thumbnail)。説明文は取れない(ログイン・API キー不要の範囲ではここまで)。
- 一般 Web: v2 の `fetchGeneric`(readable text、最大 200k 字)をそのまま使う。

## 2. 文脈グラフ `related.json`(取得物の台帳)

```
archive/<YYYY>/<id>/
├── snapshot.json              ← v2 のまま。不変
├── related.json               ← v3。グラフ+リソース台帳。create-only(できたら上書きしない)
├── related/posts/<status_id>.json   ← fxtwitter v2 の status オブジェクトそのまま(親・引用・自己リプ 1 件 1 ファイル)
├── related/res/<n>-<slug>.json      ← リソースのメタ(種類別、§3)
├── related/res/<n>-<slug>.md        ← 本文(README / モデルカード / abstract / 記事本文)。1 ファイル 300k 字まで
└── related-attempts.json      ← 失敗記録。related.json ができたら触らない
```

```json
{ "schema": 1, "id": "20261016-012352-c07e399d", "captured_at": "…", "captured_by": "processor",
  "root": "2110552871565660462",
  "posts": [ { "sid": "2110552869531529601", "role": "parent", "depth": 1, "author": "@studio_yebisu", "text": "…全文…",
               "published_at": "…", "urls": ["https://…"], "quote_sid": "2110xxxx", "file": "related/posts/2110552869531529601.json" },
             { "sid": "2110552871565660462", "role": "self", "depth": 0, … },
             { "sid": "2110552873167958275", "role": "self_reply", "depth": 1, … },
             { "sid": "2110xxxx", "role": "quote", "of": "2110552869531529601", … } ],
  "resources": [ { "n": 1, "url": "https://github.com/builderio/agent-native", "type": "github", "key": "BuilderIO/agent-native",
                   "found_in": ["2110552871565660462"], "meta": "related/res/01-github-builderio-agent-native.json",
                   "text": "related/res/01-github-builderio-agent-native.md", "bytes": 11479, "ok": true, "error": null } ],
  "primary": { "kind": "resource", "n": 1, "reason": "self text is only this url; parent explains it" } }
```

- `role`: `self` / `parent`(先祖、depth=距離、**N=3 まで**)/ `self_reply`(本人の後続リプ、**5 件まで**)/ `quote`(`of` が引用元のポスト。**1 段のみ**、引用の引用は URL だけ記録)。
- `urls` は t.co 展開済みで、`x.com/*/status` へのリンクは `posts` 側へ(**再帰しない**、1 ホップ)。`card.url` も含める。
- リソースは **URL 正規化後にグラフ全体で dedupe**(末尾 `/`、`www.`、`utm_*`、GitHub は `/tree/main` 等を落として repo 単位、HF は `/blob/...` を落として repo 単位)。1 リンクあたり **最大 8 件**、優先順位は §4 の主題スコア順。
- 不変の運用は v2 と同じ: `related.json` は `wx` で作成、既存ならスキップ。再取得したい時はディレクトリ `related*` を手で消す。`related/res/*.md` の後追い追加は許す(`ok:false` のものを次のランが埋める。台帳の `ok` ではなくファイルの存在が正)。
- 失敗と再試行: `related-attempts.json = {count, last_at, last_error}`。fxtwitter 404 は v2 と同じ 3 回で `gone`。リソース側の失敗は `resources[].error` に残し **related.json 自体は作る**(グラフが取れれば価値がある)。`ok:false` のリソースは 20 分ランで最大 5 回、以後 1 日 1 回。

## 3. リソース取得(種類別、全部 `processor/lib/related.mjs` に集約)

| type | 判定(URL) | メタ(`.json`) | 本文(`.md`) | 上限 |
|---|---|---|---|---|
| `github` | `github.com/<o>/<r>` | `gh api repos/…`: full_name, description, stars, language, license, topics, pushed_at, default_branch, homepage | README(`/readme` を base64 decode) | 300k 字 |
| `hf` | `huggingface.co/(datasets\|spaces)?/<o>/<r>` | `api/{models\|datasets\|spaces}/…`: id, pipeline_tag, tags, downloads, likes, lastModified, gated, license(cardData) | `raw/main/README.md`(frontmatter は残す) | 300k 字 |
| `arxiv` | `arxiv.org/(abs\|pdf)/<id>` | `export.arxiv.org/api/query?id_list=`: title, authors, published, categories, abstract(3 秒間隔、429 なら `abs` HTML から title/abstract を抜く) | abstract のみ(PDF は取らない) | — |
| `youtube` | `youtube.com/watch`, `youtu.be` | oembed: title, author_name, thumbnail_url | なし(説明文は取れない。card.description があればそれ) | — |
| `web` | それ以外の http(s) | final_url, title, description(v2 `fetchGeneric`) | readable text | 200k 字(v2 と同じ) |

- 対象外: `x.com`(posts 側)、`t.co` 展開失敗、画像/動画の直リンク、`mailto:`、50MB 超のレスポンス、HTML 以外の content-type(PDF 含む)。
- 全部 15 秒タイムアウト、1 リンクあたり合計 90 秒、1 ランのリソース取得は 40 件まで(v2 の media 予算と同じ考え)。
- GitHub のトークン: `gh auth token` が取れれば `Authorization: Bearer` を付ける(processor が `gh` の有無で分岐。無ければ無認証)。テストでは `LV_GITHUB_BASE` / `LV_HF_BASE` / `LV_ARXIV_BASE` で差し替え(`LV_FXTWITTER_BASE` と同じ流儀)。

## 4. 主題(primary subject)の決め方

`primary = { kind: "resource"|"post"|"self", n|sid, reason }` を **ルールで決めてから AI に渡す**(AI には「主題候補」として提示し、最終判断は AI が `primary_subject` で返す。両方記録する)。

スコア(高い順に採用):
1. 保存ポスト本文の URL(card 含む)のリソース → +5。本文が URL だけ(URL を除いた文字が 20 字未満)なら +3 追加。
2. 本人の自己リプに URL がある(「リプのURL」「ソースコード」「公式」パターン)→ +3。
3. 引用元の URL のリソース → +3。引用元そのものが公式アカウント(verification.type=business または本文に "Introducing"/"公開" 等)で URL が無ければ、`kind:"post"` の引用元が主題 → +2。
4. 親の URL → +2。親の本文(長文解説)は **文脈**で主題ではない。
5. 同じリソースが複数のポストに出る(`found_in` 複数)→ +2。
6. 何も無ければ `kind:"self"`(v2 と同じ振る舞い)。

同点なら github > hf > arxiv > web > youtube。「主題」はダッシュボードと ai/ の先頭に出すので、ルールは単純に保ち、迷ったら AI の `primary_subject` を優先表示する。

## 5. 分析(プロンプト・出力スキーマ)

- `loadContent(dir, record)` → `{...v2 content, related}`。`linkBlock` に次を追加(順番が重要。主題を先に):
  ```
  <subject type="github" url="…">   ← primary 候補のメタ(名前・説明・stars・license)+ README 先頭 6k 字
  <context>                          ← 親(depth 順)・引用・自己リプ を「@who (role): 本文」で各 1.5k 字まで
  <resources>                        ← 残りのリソースはタイトル+説明+URL(1 件 300 字)。本文は入れない
  ```
  保存ポストの本文は v2 どおり `<content>` に残す。**1 リンクの合計は 12k 字 → 20k 字に上限を上げる**(バッチ 8 件 → 5 件に下げて 1 回のプロンプト量を v2 と同程度に保つ)。
- `INSTRUCTIONS` に追記: 「ユーザーは多くの場合ポストが指す先(リポジトリ・モデル・論文・サイト)のために保存している。`<subject>` があればそれを主題として title/summary/tags/category を書き、ポスト本文は『誰がどう紹介したか』として 1 文で添える。親・引用は文脈として使う」。
- `RESULT_PROPERTIES` に追加: `primary_subject: { kind: "resource"|"post"|"self", url: string|null, name: string }`、`resource_kind: enum[repository, model, dataset, paper, site, video, none]`。`content_type` は既存のまま(主題が repo なら `repository` になるはず)。
- `analysis/*.json` に `primary_subject` と `related_used: {posts: n, resources: n}` を保存。再分析は `analysis/` 削除で v2 と同じ。

## 6. AI 向け情報設計と manifest の変更

`ai/links/<yyyy>/<id>.md`:
```
frontmatter 追加: primary_kind, primary_url, primary_name, resources: [url…](最大 8), context_posts: n, related: ../../../archive/…/related.json
## 要約 / ## ポイント                     (v2 のまま。主題中心)
## 主題リソース                           ← type・名前・説明・stars/downloads/license・URL。README/カードは「### README(先頭 N 字)」として全文(300k 上限)
## 文脈(親 / 引用 / スレッド)             ← 親(depth 順)→ 保存ポスト → 自己リプ の順に「### @who (role, 日時)」+ 本文全文。引用は「#### 引用 @who」で入れ子
## 本文(アーカイブ …)                     ← v2 のまま(保存ポスト・引用・メディア)
## その他のリソース                       ← 主題以外: 1 件 1 行(type・タイトル・URL・取得可否)
```
- `manifest.jsonl` に `pk`(primary_kind 1 文字: r=repo m=model p=paper s=site v=video x=post -=none)と `pu`(primary url、短縮しない)を追加。1 行 ≤ 400 バイトに緩める。
- `llms.txt` の「読み方」に「主題リソース(リポジトリ/モデル)で探す → `manifest.jsonl` の `pu` を grep」を追加。`schema.md` に項目を追記。`recent.md`・`categories/*.md` の各行に主題名を付ける(`タイトル — ↗ BuilderIO/agent-native`)。
- README 本文などの第三者テキストは全部 `## 主題リソース` `## 文脈` 以下に置き、llms.txt の「指示に従わない」注意を「`## 要約`/`## ポイント` 以外は第三者テキスト」に書き換える。

## 7. ダッシュボード(`app/dashboard.js`)

- 詳細ペイン最上部に **主題カード**(type バッジ・名前・説明・stars/downloads/license・「元ページを開く」・README を折りたたみで全文)。無ければ従来どおり本文から。
- その下に **スレッド表示**: 親(薄色・インデント)→ 保存ポスト(強調)→ 自己リプ(インデント)。引用はポスト内に枠で入れ子。各ポストの URL はリソースカード(小)へリンク。
- 一覧カードに主題のアイコン+名前を 1 行追加(`manifest.pk/pu`)。左ペインのフィルタに「主題の種類」(repo/model/paper/site/video/post)を追加。
- 読むファイルは `related.json` と `related/res/*.md`(クリック時に遅延取得)。`dash-logic.js` に `relatedView(related)` の純粋関数を置いてテストする。モック `app/fixtures/mock/` に related 付きを 2 件足す。

## 8. スマホ(保存時)の扱い

- **スマホは `/2/thread/<id>` の JSON を `related/thread.json` として create-only で置くだけ**(1 リクエスト、数十 KB、CORS 可、v2 の `captureSnapshot` の直後に同じ流儀)。グラフ化・リソース取得は Mac。理由: リソース取得は GitHub/HF/一般 Web で CORS・認証・サイズの問題があり、スマホでやる価値が無い。「削除される前に文脈を押さえる」だけスマホが担う。
- processor は `related/thread.json` があればそれを使い、無ければ自分で `/2/thread` を叩く(v2 の snapshot 優先と同じ後方互換)。
- `index.html`/`app.js` の UI は変えない。

## 9. バックフィル

- 既存 8 件: `related.json` が無い非削除リンクが todo(v2 の snapshot 同様、特別扱い不要)。`--archive-only` の初回ランで全件取得。
- 再分析: `node process.mjs --reanalyze-related`(新フラグ)= `related.json` があり `analysis.primary_subject` が無いものを `analysis/` から外して分析し直す(全削除ではなく対象だけ。他のリンクの分析を無駄に消費しない)。
- 完了条件: 8 件全部に `related.json`、c07e399d/4aeb4268/a27279bf/84c52ab8 の 4 件は `primary.kind=resource`、`ai/links/*.md` に `## 主題リソース` と README が入り、ダッシュボードで親・自己リプが見える。

## 10. フェーズと受け入れ条件

fixture は**実 API の応答を保存して使う**: `test/fixtures/related/fx2-thread-c07e399d.json`(= 本日の `/2/thread/2110552871565660462`)、`fx2-thread-a27279bf.json`(Flux3、自己リプ HF ×2)、`fx2-thread-84c52ab8.json`(引用に github)、`gh-repo-agent-native.json` + `gh-readme-agent-native.json`、`hf-model-drama-3.json` + `hf-readme-drama-3.md`、`arxiv-query-sample.xml`、`yt-oembed-sample.json`。記録スクリプト `test/record-fixtures.sh`(curl の列挙)を置き、再記録を 1 コマンドにする。

| # | 内容 | 受け入れ条件(`npm test` 緑) |
|---|---|---|
| R1 | `lib/related.mjs`: `graphFromThread(threadJson, rootId)` → posts(role/depth/urls/quote)、`normalizeUrl`・`classifyUrl`・`dedupeResources`、`scorePrimary(graph)`。純粋関数 | unit: 3 つの thread fixture で posts の role/depth が期待どおり(c07e399d: parent1・self・self_reply1、quote は parent 由来)。URL 正規化(`/tree/main`、`utm`、末尾 `/`)。primary が c07e399d→github、a27279bf→hf(comfy か base のどちらか決定的)、84c52ab8→github(引用由来)、011607→self |
| R2 | フェッチャー(github/hf/arxiv/youtube/web)+ `writeRelatedIfAbsent`、related-attempts、サイズ上限、`LV_*_BASE` 差し替え | e2e(`test/fake-web` に偽 GitHub/HF/arXiv を追加): 4 件相当 → `related.json`・`related/posts/*.json`・`related/res/*.{json,md}` が生成、2 回目で `git status` 空。README 300k 超は切り詰め+`truncated:true`。fxtwitter 404 ×3 で gone。arXiv の呼び出し間隔 ≥3 秒(偽サーバーがタイムスタンプで検査) |
| R3 | `loadContent` に related を合流、`linkBlock` 拡張、`INSTRUCTIONS`・`RESULT_PROPERTIES` 更新、`analysis` に `primary_subject`、バッチ 5 件・20k 字 | unit: linkBlock の出力に `<subject>` が `<content>` より前にあり 20k 字以内。偽 claude(`fake-claude.mjs`)が `primary_subject` を返し analysis に保存される。`--reanalyze-related` が対象だけを再分析 |
| R4 | `ai-build.mjs`: §6 の全部。`build.mjs` に `related: Map<id, related>` を渡す | unit: md に `## 主題リソース` `## 文脈` が順番どおり。frontmatter を読み戻せる。manifest 1 行 ≤ 400 バイト、`pk/pu` あり。related 無しのリンクは v2 と **byte 同一**(既存テストが無変更で通る) |
| R5 | ダッシュボード §7 + モック | `node --test app/test` 緑(`relatedView` の純粋関数)。手動: `?mock=1` で主題カードとスレッドが出る。index.html/sw.js の差分なし |
| R6 | スマホ `captureThread`(§8)+ processor の thread.json 優先 | 手動: 実機で X リンク保存 → `related/thread.json` が 1 分以内にできる。processor がそれを使い fxtwitter を再度叩かない(ログで確認) |
| R7 | README「データの形式」「AI に読ませる」更新、HANDOFF に related の不変ルールと再取得手順、本設計書を `docs/` へ | README に `related.json` の説明と `--reanalyze-related` があること |

順序: R1 → R2 → R3 → R4 は直列。R5(R1 の fixture だけ依存)と R6(R2 の thread.json 仕様だけ依存)は並行可。R2 完了時点で実機バックフィル(§9)を 1 回走らせ、R3/R4 のレビューは実データで行う。

## 11. やらないこと

- 他人の返信の収集(無料・安定な経路が無い)。X 検索(Grok)・ログイン・HTML スクレイピング。fxtwitter 以外の X 経路の追加。
- 引用の引用(2 段以上)、親チェーン 3 段超、自己リプ 5 件超、x.com リンクの再帰取得(1 ホップで止める)。
- GitHub のコード本体・issues・リリース、HF の重みファイル、arXiv PDF、YouTube の字幕/説明文、Web ページの画像。PDF 全般。
- `snapshot.json`・`links/`・`events/` の変更、v2 の `ai/` 構造の破壊(追加のみ)、`index.html`/`app.js` の UI 変更、新しいサーバー・ストレージ。
- リソースの定期的な再取得(README の更新追従)。取った時点のものを残すのが目的。

## 12. リスク

- **fxtwitter v2 の仕様変更・停止**: `related/posts/*.json` に生データを残し、取得は `related.mjs` 1 か所。`thread` が空で返っても `status.replying_to.status` から親だけは辿れるようにフォールバックを持つ。
- **主題の誤判定**(引用元のリンクが宣伝、自己リプの URL が無関係): ルールのスコアと AI の `primary_subject` を両方記録し、ダッシュボードで AI 側を優先表示。誤りは `analysis/` 削除で再分析できる。
- **容量**: README/カードは最大 300k 字のテキストなので 1 リンク数百 KB。8 件/ランの上限と `du` ログ(v2)でそのまま監視。
- **プロンプトインジェクション面の拡大**: README・モデルカード・Web 本文は第三者テキスト。`<subject>`/`<context>` も `<content>` と同じ扱いを INSTRUCTIONS に明記。`ai/` 側も見出しで隔離(§6)。
- **レート制限**: GitHub は認証で回避、arXiv は 3 秒間隔+1 ラン 20 件、HF は無認証で十分。429 は `error` に残して次ランで再試行(related.json は作る)。
- **バッチ 8→5 件で分析ランの回数が増える**: 1 ラン最大 40 件の既定は変えず、1 回の `claude` 呼び出しのトークンが v2 と同程度に収まることを優先。

## 付録: v3.1 補足取得(プロフィールのサイト・Grok X 検索)

§11 の「他人の返信は取らない」を、**条件付き・枠つき**で緩める。コードは `processor/lib/related-extra.mjs`。どちらも best effort で、失敗してもアーカイブ・分析は止めない。

- **A) プロフィールのサイト(無料)**: 引用/親ポストの投稿者で、そのポストに URL が無いアカウント(動画だけの公式引用など。最大 2 人)について `https://api.fxtwitter.com/<handle>` の `user.website.url` と `raw_description.facets` の URL を候補にする。linktr.ee / lit.link / bento.me / beacons.ai 等のハブなら HTML を取り、アフィリエイト・SNS・フォント等を除いた外向きリンクから**公式ドメイン(アカウント名・表示名に近いホスト)優先**で 1 サイト 1 リンク、最大 3 件。`resources[].origin = "profile:@handle"`、主題スコア **+1**(他に何も無いときだけ勝つ。公式引用ポスト主題=2 には負ける)。
- **B) 他人のリプ(Grok X 検索、枠つき)**: 発動条件は (1) 保存/親ポスト本文が `リプ|リプライ|コメント欄|返信|👇|below|in replies|link in reply|comments` を含み、かつ本人スレッド(self/self_reply)にリソース URL が無い、または (2) 全部取ったあとリソースが 0 件(プロフィール由来は数えない)で本文がツール/製品の話(`ツール|アプリ|モデル|公開|Introducing|launch|SDK|open source…`)。`grok-api search x --query … --output json --from-date --to-date`(保存日の前日〜+3 日)を実行し、結果中の URL を `origin = "x_search"`(主題スコア +2)で資源にする。生の応答は `related/x-search.json` に **create-only** で保存(1 リンク 1 回。エラー時は `x-search-attempts.json` に記録、3 回失敗で 1 日 1 回)。
- **既存の related.json への追記**: 既存の項目(posts・resources・primary の根拠)は変えず、`resources` の末尾に `origin` 付きで足し、`supplement` に `profile_done` / `xsearch_done` / `resources_added_at` を書く(一時ファイル→rename)。資源が増えた分析済みリンクは `--reanalyze-related` が `resources_added_at > analyzed_at` で拾い直す。プロフィール取得が通信エラーのときは次ランに回し、5 回で諦める。rebase で archive/ が衝突したら従来どおりリモート側が勝つ(次ランで足し直す)。
- 枠: 1 ランあたり `LV_XSEARCH_PER_RUN`(既定 3)。応答/終了コードが spending-limit・quota・rate・auth 系なら `processor/logs/xsearch-cooldown.json`(`LV_XSEARCH_COOLDOWN_FILE`)に 24 時間のクールダウンを書き、その間は検索しない。`LV_XSEARCH=0` で無効、`LV_GROK_BIN` でコマンド差し替え(テストは偽バイナリ)、`LV_XSEARCH_FORCE=1` は動作確認用(条件を無視)。`LV_FXTWITTER_BASE` を差し替えているのに `LV_GROK_BIN` が無い環境では実バイナリを絶対に呼ばない。
- **既存の related.json への追記**: `related.json` は作成時のみ書くが、補足取得だけは**追記専用**で既存台帳を更新する(既存の資源・番号は変えない。新資源は番号を続けて付け、`primary` だけ再計算、`supplement:{v:1,profile_done,xsearch_done}` を記録。tmp+rename)。`supplement` が済んだリンクは再実行しても何も変わらない。
- 実応答 fixture: `test/fixtures/related/fx-user-MireloAI.json`, `fx-user-bfl_ai.json`, `hub-linktree-mirelo.html`(`record-fixtures.sh` に追記)。テスト: `test/related.extra.test.mjs`。
