import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

type Size = "1024x1024" | "1024x1536" | "1536x1024" | "auto";
type Quality = "low" | "medium" | "high" | "auto";

type Options = {
  prompt: string;
  size: Size;
  quality: Quality;
  model: string;
  outputDir: string;
  count: number;
};

const DEFAULT_PROMPT =
  "かわいいアイドル募集LPのファーストビュー画像。ピンク、パステル、キラキラ、ハート装飾、ステージ照明、柔らかいぼかし。被写体は別人の10代後半女性、ロングヘア、笑顔でマイクを持って歌っている。文字・ロゴ・透かしなし。";

function parseArgs(argv: string[]): Options {
  const map = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [k, v] = arg.includes("=") ? arg.split("=", 2) : [arg, argv[i + 1]];
    if (!arg.includes("=")) i += 1;
    if (v) map.set(k.replace(/^--/, ""), v);
  }

  return {
    prompt: map.get("prompt") ?? DEFAULT_PROMPT,
    size: (map.get("size") as Size) ?? "1024x1536",
    quality: (map.get("quality") as Quality) ?? "medium",
    model: map.get("model") ?? "gpt-image-2",
    outputDir: map.get("output-dir") ?? "outputs",
    count: Number(map.get("count") ?? "4")
  };
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!process.env.OPENAI_API_KEY) return "APIキー未設定: OPENAI_API_KEY を設定してください。";
  if (/model|unsupported|not found|does not exist/i.test(message)) return "モデル未対応: gpt-image-2 の利用可否を確認してください。";
  if (/organization|project|permission|unauthorized|forbidden|401|403/i.test(message)) return "組織認証未完了: 組織/請求/権限を確認してください。";
  if (/network|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(message)) return "ネットワーク制限: 接続制限の可能性があります。";
  return `判定不能エラー: ${message}`;
}

async function run(options: Options): Promise<void> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY が未設定です");

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const dir = path.resolve(options.outputDir);
  fs.mkdirSync(dir, { recursive: true });

  for (let i = 1; i <= options.count; i += 1) {
    const result = await openai.images.generate({
      model: options.model,
      prompt: `${options.prompt}\nvariation ${i}`,
      size: options.size,
      quality: options.quality
    });

    const b64 = result.data?.[0]?.b64_json;
    if (!b64) throw new Error(`画像データが空です: ${i}`);

    const out = path.join(dir, `generated-${String(i).padStart(2, "0")}.png`);
    fs.writeFileSync(out, Buffer.from(b64, "base64"));
    console.log(`saved: ${out}`);
  }
}

(async () => {
  try {
    await run(parseArgs(process.argv));
  } catch (error) {
    console.error(classifyError(error));
    if (error instanceof Error) console.error(`詳細: ${error.message}`);
    process.exitCode = 1;
  }
})();
