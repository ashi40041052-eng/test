// Backend "api": Claude API (pay-as-you-go, needs ANTHROPIC_API_KEY). One request per link.
import Anthropic from '@anthropic-ai/sdk';
import { RESULT_PROPERTIES, RESULT_REQUIRED, INSTRUCTIONS, categoryList, linkBlock, cleanResult } from './prompt.mjs';

const SCHEMA = { type: 'object', additionalProperties: false, required: RESULT_REQUIRED, properties: RESULT_PROPERTIES };

export function createApiAnalyzer({ model }) {
  const client = new Anthropic();
  // Server-side refusal fallback is not available for Haiku models.
  const useFallback = !/haiku/i.test(model);

  async function analyzeOne({ record, content }, categories) {
    const params = {
      model,
      max_tokens: 4000,
      system: INSTRUCTIONS,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: `既存カテゴリ:\n${categoryList(categories)}\n\n保存されたリンク:\n${linkBlock(record, content)}` }],
    };
    if (useFallback) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    const res = await client.beta.messages.create(params);
    if (res.stop_reason === 'refusal') throw new Error(`refused (${res.stop_details?.category ?? 'unknown'})`);
    if (res.stop_reason === 'max_tokens') throw new Error('output truncated (max_tokens)');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { ...cleanResult(JSON.parse(text)), model: res.model };
  }

  return {
    batchSize: 1,
    // Returns Map<id, result | Error>
    async analyzeBatch(items, categories) {
      const out = new Map();
      for (const it of items) {
        try { out.set(it.record.id, await analyzeOne(it, categories)); } catch (e) { out.set(it.record.id, e); }
      }
      return out;
    },
  };
}
