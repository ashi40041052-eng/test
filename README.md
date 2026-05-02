# LLP Image Generation (OpenAI API)

`gpt-image-2` を使って、LP向けビジュアルを4案生成し、PNG保存まで行うCLIです。

## これ展開してほしい（拡張版）について

この実装は「最小接続確認」から、次のように展開しています。

- 4案を自動生成（`--count`）
- 4種類の高拘束デフォルトプロンプトを内蔵
- 出力PNGに加えて `generation-report.json` を保存（各案のプロンプト/設定/保存先）
- 失敗時メッセージを原因別に分類

## セットアップ

```bash
npm install
```

## 実行

```bash
OPENAI_API_KEY=your_api_key npm run generate:image
```

出力:
- `outputs/generated-01.png` ... `outputs/generated-04.png`
- `outputs/generation-report.json`

## オプション

```bash
npm run generate:image -- \
  --count 4 \
  --size 1024x1536 \
  --quality high \
  --output-dir outputs \
  --model gpt-image-2
```

カスタムプロンプトを使う場合:

```bash
npm run generate:image -- \
  --prompt "ピンク/パステル、ハート、キラキラ、ステージ照明。別人の10代後半女性が笑顔でマイク歌唱。文字ロゴ透かしなし" \
  --count 4
```

## 接続エラーの判定

- APIキー未設定
- モデル未対応
- 組織認証未完了（権限/請求/プロジェクト）
- ネットワーク制限
