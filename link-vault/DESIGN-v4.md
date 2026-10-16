# Link Vault v4 設計書(リソース優先ビュー: 「リンク先を全部見せて、全部読む」)

作成 2026-10-17。v3 の取得物(`related.json` / `related/res/*`)はそのまま使う。変えるのは **AI の出力の形** と **見せ方** だけ。
本人の不満: (1) ポストに付いているリポジトリ等がリンクとして並んでいない・読まれていない (2) 要約が読みにくい。
モックアップ: `app/mock-v4.html` は実装後に削除済み(git 履歴に無い。画面は `?mock=1` の fixtures で確認)。
**本人の変更(実装時)**: 詳細ペインの順は「リソース(AI の読み付きカード) → 見出し+TL;DR → ポイント → 畳む(要約・スレッド・リプ・アーカイブ)」。リソースを最上段に置く(§3 の順より優先)。

## 0. 現状の確認(実データ 8 件)
- リソースは `related.json.resources[]` に **既に全部ある**(c07e399d: GitHub + 公式ブログ + 作者サイト、06fd91fe: HF×2 + 本人リプの GitHub、a27279bf: HF×2)。本文(README/記事)も `related/res/<n>.md` に取得済み。
- だが AI は **主題 1 件だけ** README を読む(`prompt.mjs subjectBlock`)。他は `<resources>` に URL 1 行(`resourcesBlock`)。出力 `RESULT_PROPERTIES` にリソース別の項目が無い。
- 画面は主題カード 1 枚(description 1 行+README は `<details>` で畳む)→要約段落→スレッド。他リソースは最下部に chip。カードにはリソースが出ない。

## 1. やる順番(各段で動く状態を保つ。前の段を壊さない)
1. **スキーマ**(`prompt.mjs`): 出力に `tldr`(1 行 40 字以内)と `resources[]` を追加。`key_points` は 3〜5 個・各 40 字以内に指示を変更。
2. **プロンプト**(`prompt.mjs linkBlock`): `<resources>` を 1 行列挙から **本文付き `<resource n>` ブロック**に変える(§2)。主題は従来どおり `<subject>`。`MAX_LINK_CHARS` は 30,000、`batchSize` は 3(`process.mjs` の既定値)。
3. **再分析の移行**(`process.mjs` の todo 判定): `a.v !== 4` かつ related.json に `ok` なリソースが 1 件以上 → 再分析。8 件中 6 件が対象(4a559f19 / 6ab719ad はリソース無しなので v4 でも再分析しない。表示側で `resources` 不在を許す)。結果に `v: 4` を書く。
4. **ai/ 出力**(`ai-build.mjs`): `## TL;DR` → `## ポイント` → `## リソース`(リソースごとに §2 の 5 項目+URL)→ `## 要約`(長文)→ 以降は従来(README 全文・文脈・リプ・本文)。`subjects.md` の各主題の下に `tldr` を 1 行足す。`schema.md` の並び説明を更新。
5. **ダッシュボード**(`dash-logic.js` → `dashboard.js` → `dashboard.css`): 詳細ペインの順を §3 に。カードにリソース chip。
6. **テスト**(`app/test/`): `relatedView` のリソース出所ラベル、`resourceCards` の並び(主題→ポスト内の出現順→リプ由来→プロフィール)、リソース無しの link で v4 セクションが出ないこと。
7. **README / HANDOFF**: 移行コマンド `node processor/process.mjs --no-git`(gate が v4 未満を拾う)と、`v` の意味を書く。

## 2. データ(決定)
`analysis/<id>.json` に入れる(`related/` は取得物の台帳=create-only なので AI 出力を混ぜない。analysis は再生成可能):
```json
{ "v": 4, "tldr": "人の操作と AI の操作が同じ画面に乗る TS フレームワーク",
  "resources": [ { "n": 1, "url": "https://github.com/builderio/agent-native", "name": "BuilderIO/agent-native", "type": "github",
      "what": "…1〜2文", "features": ["…", "…", "…"], "usage": "npx --yes @agent-native/core@latest create … / 無ければ空", "audience": "…1文",
      "my_note": "" } ] }
```
- `n`/`url`/`type` は `related.json.resources[]` と同じ番号で結ぶ(表示は related 側の `found_in` / `origin` で「保存ポスト内・親・引用・本人の続き・他人のリプ・プロフィール」を出す)。
- `my_note` は常に空文字で出力(本人が書く欄。AI は埋めない)。将来 `events` に `note` を足すまでは表示のみ。
- `ai/links/*.md` のリソース節は 5 項目を箇条書き。README 全文は従来の `## 主題リソース` 以下に残す(AI 用)。

プロンプト側のルール:
- `ok: true` で本文のあるリソースだけ `<resource n type url name>` に本文(先頭)を付けて渡す。主題 6,000 字・他 2,500 字から縮める(`steps` に列を足す)。本文の無いリソース(`empty body` / 取得失敗)は渡さず、画面はメタだけのカードにする(AI の推測で埋めない)。
- 「resources には渡した `<resource>` 全部について 1 件ずつ、README/本文から分かることだけを日本語で書く。`usage` はインストール・起動コマンドを本文からそのまま引く。無ければ空」。
- `tldr` は「何が・何のためのものか」を 1 行。`summary` は従来の 2〜4 文のまま(畳んで出す)。

## 3. 画面(決定。モック参照)
詳細ペインの順: **見出し+メタ → TL;DR(大きい字) → ポイント 3〜5 → リソース(全部、カード) → 要約(畳む) → スレッド(畳む) → 他の人のリプ(畳む) → アーカイブ/メディア(畳む) → 操作ボタン**。
- リソースカード: 種類バッジ・名前(=リンク、新規タブ)・URL 短縮表示・出所ラベル・facts(★/言語/⬇ など)・5 項目(「何」「できること」「使い方」「向く人」「自分メモ」)・README/本文は `<details>`。主題は枠線を accent にして最初。
- カード(一覧): タイトル→1 行要約(`tldr` があればそれ)→**リソース chip 最大 3 個+「+n」**→メタ。
- リソース 0 件のポスト(4a559f19 / 6ab719ad): リソース節を出さず TL;DR+ポイント+要約(畳まない)+スレッド。縦に短く。
- 見出しは 12px 大文字の既存 `h4` のまま、節の間隔を 22px に広げる。`tldr` は 17px 太字、`summary` は `details` の中。

## 4. 判断基準
- リソースの並び: 主題 → `found_in` が保存ポスト → 親/引用 → 本人の続き → 他人のリプ(`origin: x_replies*`) → プロフィール(`profile:`)。同じ URL は 1 回。
- AI の読みが無い(`v<4` / 本文無し / 再分析失敗)リソースも **リンクは必ず出す**(メタのみカード)。表示が analysis を待つことはしない。
- 再分析は既存の gate に 1 条件足すだけ。全件強制フラグは作らない(6 件 × 2 バッチで終わる)。
- 長さの上限で縮めるのは「他リソース本文 → 文脈 → 主題本文 → ポスト本文」の順。リソースを落とすのは最後。

## 5. やらないこと
- `related.mjs` の取得・順位付けには触らない(新しい URL を拾う話は v3 の範囲)。`links/` `snapshot.json` `related.json` は不変のまま。
- README を Markdown レンダリングしない(既存の `pre` 表示のまま。画像/HTML が多く危険)。
- リソースごとに別の AI 呼び出しをしない(1 リンク 1 ブロックのバッチのまま)。
- `my_note` の保存機能(events への書き込み)は v4 に入れない。表示だけ。
- スマホ版(`index.html` / `app.js`)は触らない。
- 要約の文章を短くするために情報を削らない(長文は畳む。消さない)。
