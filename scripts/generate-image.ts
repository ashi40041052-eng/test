import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

type CliOptions = {
  prompt: string;
  size: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality: "low" | "medium" | "high" | "auto";
  output: string;
  model: string;
};

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.includes("=")
      ? arg.split("=", 2)
      : [arg, argv[i + 1]];
    if (!arg.includes("=")) i += 1;
    if (value) args.set(key.replace(/^--/, ""), value);
  }

  return {
    prompt:
      args.get("prompt") ??
      "かわいいアイドル募集LPのファーストビュー画像。ピンク、キラキラ、ステージ照明、若い女性向け、ポップで華やか、商用LP向け",
    size: (args.get("size") as CliOptions["size"]) ?? "1024x1536",
    quality: (args.get("quality") as CliOptions["quality"]) ?? "medium",
    output: args.get("output") ?? "outputs/generated.png",
    model: args.get("model") ?? "gpt-image-2"
  };
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (!process.env.OPENAI_API_KEY) {
    return "APIキー未設定: 環境変数 OPENAI_API_KEY を設定してください。";
  }
  if (/model|unsupported|not found|does not exist/i.test(message)) {
    return "モデル未対応: gpt-image-2 が利用可能か、契約プランで画像生成APIが有効か確認してください。";
  }
  if (/organization|project|permission|unauthorized|forbidden|401|403/i.test(message)) {
    return "組織認証未完了: 組織/プロジェクト設定、請求設定、権限を確認してください。";
  }
  if (/network|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(message)) {
    return "ネットワーク制限: 外部接続がブロックされているか、名前解決できない可能性があります。";
  }

  return `判定不能エラー: ${message}`;
}

export async function generateImage(options: CliOptions): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("APIキー未設定: 環境変数 OPENAI_API_KEY を設定してください。");
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const result = await openai.images.generate({
    model: options.model,
    prompt: options.prompt,
    size: options.size,
    quality: options.quality
  });

  const imageBase64 = result.data?.[0]?.b64_json;
  if (!imageBase64) {
    throw new Error("画像データが空です。レスポンス形式を確認してください。");
  }

  const outputPath = path.resolve(options.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(imageBase64, "base64"));
  return outputPath;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);

  try {
    const saved = await generateImage(options);
    console.log(`画像を保存しました: ${saved}`);
  } catch (error) {
    console.error(classifyError(error));
    if (error instanceof Error) {
      console.error(`詳細: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

void main();
