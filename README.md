# LLP Image Generation (OpenAI API)

OpenAI APIの最新画像生成モデルを使って、LP向け画像を生成する最小実装です。

## セットアップ

```bash
npm install
```

## 実行

```bash
OPENAI_API_KEY=your_api_key npm run generate:image
```

## オプション

```bash
npm run generate:image -- \
  --prompt "添付参考に忠実なピンク系ステージ画像、被写体は別人、ロングヘア、笑顔でマイクを持って歌う" \
  --size 1024x1536 \
  --quality medium \
  --output outputs/llp-visual-v1.png \
  --model gpt-image-2
```

- `prompt`: 画像生成プロンプト
- `size`: `1024x1024` / `1024x1536` / `1536x1024` / `auto`
- `quality`: `low` / `medium` / `high` / `auto`
- `output`: 保存先PNGパス（例: `outputs/generated.png` または `public/generated/generated.png`）
- `model`: 既定は `gpt-image-2`

## エラー判定

接続失敗時は、次を判定しやすいメッセージを表示します。

- APIキー未設定
- モデル未対応
- 組織認証未完了（権限/請求/プロジェクト）
- ネットワーク制限
