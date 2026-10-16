---
license: cc-by-nc-sa-4.0
pipeline_tag: text-to-speech
---
# Drama 3

多話者の会話音声を生成する TTS モデル。

## 推奨環境
- 24GB VRAM (bf16)
- 12GB VRAM: int8 量子化版 (`--quant int8`)

## 使い方
```
python infer.py --text "こんにちは" --speakers 2
```
