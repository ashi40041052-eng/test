# LLP Image Generation (OpenAI API)

OpenAI API (`gpt-image-2`) を使って、LP向けビジュアルを**4案まとめて**生成する最小実装です。

## なぜ「参考画像と全然違う」結果が出るのか

主な原因は次の4つです。

1. **参照画像そのものをモデルに渡していない**
   - テキストだけだと、色味や雰囲気は寄せられても、レイアウト・奥行き・被写体位置はズレやすいです。
2. **プロンプトの拘束力不足**
   - 「似せたい要素」と「絶対NG」を明確に分けないと、文字・装飾・構図が崩れます。
3. **モデルのランダム性**
   - 同じ指示でも毎回微妙に違うため、1枚だけでは当たりを引きにくいです。
4. **“人物は別人” 制約の影響**
   - 顔や髪型の再現を避ける方向に働き、参照印象から離れることがあります。

このリポジトリのスクリプトは上記を踏まえ、**高拘束プロンプト + 4案同時生成**で改善する構成にしています。

## セットアップ

```bash
npm install
```

## 実行

```bash
OPENAI_API_KEY=your_api_key npm run generate:image
```

実行後、`outputs/generated-01.png` 〜 `generated-04.png` を保存します。

## オプション

```bash
npm run generate:image -- \
  --prompt "ピンク/パステル、キラキラ、ハート、ステージ照明、ぼかし。被写体は別人の10代後半ロングヘア女性、笑顔でマイクを持って歌う。文字ロゴ透かしなし" \
  --size 1024x1536 \
  --quality high \
  --output-dir outputs \
  --count 4 \
  --model gpt-image-2
```

- `prompt`: 生成プロンプト
- `size`: `1024x1024` / `1024x1536` / `1536x1024` / `auto`
- `quality`: `low` / `medium` / `high` / `auto`
- `output-dir`: PNG保存先ディレクトリ（例: `outputs` / `public/generated`）
- `count`: 生成枚数（既定 `4`）
- `model`: 既定 `gpt-image-2`

## エラー判定

接続失敗時は、次の分類メッセージを表示します。

- APIキー未設定
- モデル未対応
- 組織認証未完了（権限/請求/プロジェクト）
- ネットワーク制限
