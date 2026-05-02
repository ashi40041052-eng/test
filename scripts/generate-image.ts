import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

type CliOptions = {
  prompt: string;
  size: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality: "low" | "medium" | "high" | "auto";
  outputDir: string;
  model: string;
  count: number;
};

const DEFAULT_PROMPT = `添付LPの雰囲気を再現したヒーロービジュアル。
必須: ピンク/パステル配色、余白感、キラキラとハート装飾、ステージ照明、柔らかいぼかし。
被写体: 10代後半の別人女性、ロングヘア、笑顔、マイクを持って歌っている。
厳守: 元画像と同一人物の顔は使わない。文字・ロゴ・透かしは入れない。
構図: 3:4 縦長、高解像度、LPファーストビュー向け。`;

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.includes("=") ? arg.split("=", 2) : [arg, argv[i + 1]];
    if (!arg.includes("=")) i += 1;
    if (value) args.set(key.replace(/^--/, ""), value);
  }

  return {
    prompt: args.get("prompt") ?? DEFAULT_PROMPT,
    size: (args.get("size") as CliOptions["size"]) ?? "1024x1536",
    quality: (args.get("quality") as CliOptions["quality"]) ?? "high",
    outputDir: args.get("output-dir") ?? "outputs",
    model: args.get("model") ?? "gpt-image-2",
    count: Number(args.get("count") ?? "4")
  };
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (!process.env.OPENAI_API_KEY) return "APIキー未設定: 環境変数 OPENAI_API_KEY を設定してください。";
  if (/model|unsupported|not found|does not exist/i.test(message)) return "モデル未対応: gpt-image-2 の利用可否を確認してください。";
  if (/organization|project|permission|unauthorized|forbidden|401|403/i.test(message)) return "組織認証未完了: 組織/請求/プロジェクト権限を確認してください。";
  if (/network|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(message)) return "ネットワーク制限: 接続制限やDNS不達の可能性があります。";
  return `判定不能エラー: ${message}`;
}

function ensureApiKey(): void {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("APIキー未設定: 環境変数 OPENAI_API_KEY を設定してください。");
  }
}

export async function generateImageSet(options: CliOptions): Promise<string[]> {
  ensureApiKey();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const savedPaths: string[] = [];
  for (let i = 1; i <= options.count; i += 1) {
    const result = await openai.images.generate({
      model: options.model,
      prompt: `${options.prompt}\nバリエーション番号: ${i}`,
      size: options.size,
      quality: options.quality
    });

    const imageBase64 = result.data?.[0]?.b64_json;
    if (!imageBase64) throw new Error(`画像データが空です (variant ${i})`);

    const outPath = path.join(outputDir, `generated-${String(i).padStart(2, "0")}.png`);
    fs.writeFileSync(outPath, Buffer.from(imageBase64, "base64"));
    savedPaths.push(outPath);
  }

  return savedPaths;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  try {
    const files = await generateImageSet(options);
    console.log(`生成完了 (${files.length}案):`);
    files.forEach((f) => console.log(`- ${f}`));
    console.log("\n注意: 参照画像をAPIに直接渡していない場合、構図の一致は近似になります。");
  } catch (error) {
    console.error(classifyError(error));
    if (error instanceof Error) console.error(`詳細: ${error.message}`);
    process.exitCode = 1;
  }
}

void main();
