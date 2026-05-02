# OpenAI画像生成CLI（簡易版）

不要な機能を削って、`gpt-image-2` で画像を生成してPNG保存するだけの構成に整理しました。

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
  --prompt "ピンク/パステル、キラキラ、ハート、ステージ照明。別人の10代後半女性が笑顔でマイク歌唱。文字なし" \
  --size 1024x1536 \
  --quality medium \
  --count 4 \
  --output-dir outputs \
  --model gpt-image-2
```

出力: `outputs/generated-01.png` 形式

## エラー分類
- APIキー未設定
- モデル未対応
- 組織認証未完了
- ネットワーク制限
