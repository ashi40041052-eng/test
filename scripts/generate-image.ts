import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

type ImageSize = "1024x1024" | "1024x1536" | "1536x1024" | "auto";
type ImageQuality = "low" | "medium" | "high" | "auto";

type CliOptions = {
  size: ImageSize;
  quality: ImageQuality;
  outputDir: string;
  model: string;
  count: number;
  prompt?: string;
};

type GenerationRecord = {
  index: number;
  prompt: string;
  outputPath: string;
  model: string;
  size: ImageSize;
  quality: ImageQuality;
  generatedAt: string;
};

const PROMPT_VARIANTS: string[] = [
  "LPファーストビュー。3:4縦長。ピンク/パステル。ステージ照明、キラキラ、ハート装飾、ソフトフォーカス。被写体は別人の10代後半女性、ロングヘア、笑顔、マイクで歌唱中。文字・ロゴ・透かしなし。",
  "アイドル募集LP向けKV。余白感を保った構図、前景ボケ、ネオンピンクの照明、きらめく粒子。別人の10代後半女性、ロングヘア、笑顔で歌っている。文字要素は入れない。",
  "華やかなライブ会場の雰囲気。パステルピンク中心、ハート型の光、柔らかいグロー。10代後半の別人女性シンガーがマイクを持ち、観客に向かって笑顔。テキスト/ロゴ/透かし禁止。",
  "商用LPで使える高品質ヒーロー画像。3:4、ピンクのステージライティング、キラキラ演出、奥行きのある被写界深度。別人のロングヘア少女(10代後半)が歌唱。文字なし。"
];

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
    prompt: args.get("prompt"),
    size: (args.get("size") as ImageSize) ?? "1024x1536",
    quality: (args.get("quality") as ImageQuality) ?? "high",
    outputDir: args.get("output-dir") ?? "outputs",
    model: args.get("model") ?? "gpt-image-2",
    count: Number(args.get("count") ?? "4")
  };
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!process.env.OPENAI_API_KEY) return "APIキー未設定: OPENAI_API_KEY を設定してください。";
  if (/model|unsupported|not found|does not exist/i.test(message)) return "モデル未対応: gpt-image-2 の利用可否を確認してください。";
  if (/organization|project|permission|unauthorized|forbidden|401|403/i.test(message)) return "組織認証未完了: 組織/請求/プロジェクト権限を確認してください。";
  if (/network|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(message)) return "ネットワーク制限: 接続制限やDNS不達の可能性があります。";
  return `判定不能エラー: ${message}`;
}

function ensureApiKey(): void {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY が未設定です。");
}

function resolvePrompt(index: number, custom?: string): string {
  if (custom) return `${custom}\nバリエーション番号: ${index + 1}`;
  const base = PROMPT_VARIANTS[index % PROMPT_VARIANTS.length];
  return `${base}\nバリエーション番号: ${index + 1}`;
}

export async function generateImageSet(options: CliOptions): Promise<GenerationRecord[]> {
  ensureApiKey();

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const records: GenerationRecord[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const prompt = resolvePrompt(i, options.prompt);
    const result = await openai.images.generate({
      model: options.model,
      prompt,
      size: options.size,
      quality: options.quality
    });

    const imageBase64 = result.data?.[0]?.b64_json;
    if (!imageBase64) throw new Error(`画像データが空です (variant ${i + 1})`);

    const outputPath = path.join(outputDir, `generated-${String(i + 1).padStart(2, "0")}.png`);
    fs.writeFileSync(outputPath, Buffer.from(imageBase64, "base64"));

    records.push({
      index: i + 1,
      prompt,
      outputPath,
      model: options.model,
      size: options.size,
      quality: options.quality,
      generatedAt: new Date().toISOString()
    });
  }

  fs.writeFileSync(path.join(outputDir, "generation-report.json"), JSON.stringify(records, null, 2));
  return records;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);

  try {
    const records = await generateImageSet(options);
    console.log(`生成完了: ${records.length}案`);
    records.forEach((r) => console.log(`- #${r.index}: ${r.outputPath}`));
    console.log(`- レポート: ${path.resolve(options.outputDir, "generation-report.json")}`);
  } catch (error) {
    console.error(classifyError(error));
    if (error instanceof Error) console.error(`詳細: ${error.message}`);
    process.exitCode = 1;
  }
}

void main();
