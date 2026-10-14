import { safeFileName } from './util.mjs';

// Builds the dashboard index and AI-readable markdown from raw records + analyses.
// Pure function: returns { files: {relativePath: content} }.
// Deleted links stay in index.json (flagged, so the app can show them in the trash) but are
// left out of counts and of everything under knowledge/.
export function buildOutputs({ records, analyses, categories, deleted = new Set(), now = new Date() }) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const items = [];
  const extras = new Map(); // original id -> duplicate records

  for (const r of records) {
    const a = analyses.get(r.id);
    if (a?.status === 'duplicate' && byId.has(a.duplicate_of) && !deleted.has(r.id)) {
      if (!extras.has(a.duplicate_of)) extras.set(a.duplicate_of, []);
      extras.get(a.duplicate_of).push(r);
    }
  }

  for (const r of records) {
    const a = analyses.get(r.id);
    if (a?.status === 'duplicate' && byId.has(a.duplicate_of)) continue;
    const dups = extras.get(r.id) || [];
    const notes = [r.note, ...dups.map((d) => d.note)].filter(Boolean);
    const item = {
      id: r.id,
      url: r.url,
      note: [...new Set(notes)].join(' / ') || null,
      created_at: r.created_at,
      status: a?.status === 'analyzed' ? 'analyzed' : a?.status === 'failed' ? 'failed' : 'pending',
    };
    if (dups.length) item.also_saved_at = dups.map((d) => d.created_at);
    if (deleted.has(r.id)) item.deleted = true;
    if (a?.status === 'analyzed') {
      Object.assign(item, {
        title: a.title,
        summary: a.summary,
        key_points: a.key_points,
        category: a.category,
        tags: a.tags,
        content_type: a.content_type,
        author: a.source?.author || null,
        analyzed_at: a.analyzed_at,
      });
    }
    items.push(item);
  }
  items.sort((x, y) => new Date(y.created_at) - new Date(x.created_at) || y.id.localeCompare(x.id));

  const visible = items.filter((i) => !i.deleted);
  const counts = new Map();
  visible.forEach((i) => { if (i.category) counts.set(i.category, (counts.get(i.category) || 0) + 1); });
  const cats = categories
    .map((c) => ({ name: c.name, description: c.description || '', count: counts.get(c.name) || 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
  // Categories used by analyses but missing from the registry (e.g. edited by hand).
  for (const [name, count] of counts) if (!cats.some((c) => c.name === name)) cats.push({ name, description: '', count });

  const generated_at = now.toISOString();
  const files = {};
  files['index.json'] = JSON.stringify({
    version: 1,
    generated_at,
    total: visible.length,
    categories: cats,
    known_ids: records.map((r) => r.id),
    items,
  }, null, 1) + '\n';

  files['knowledge/links.jsonl'] = visible.map((i) => JSON.stringify(i)).join('\n') + (visible.length ? '\n' : '');

  const used = cats.filter((c) => c.count > 0);
  const pendingCount = visible.filter((i) => i.status !== 'analyzed').length;
  files['knowledge/README.md'] = [
    '# Link Vault ナレッジベース',
    '',
    'ユーザーがSNS等で「良い」と思って保存したリンク集です。各リンクはAIが本文を読んで要約・カテゴリ分けしています。',
    'AIへ: このディレクトリはユーザーの関心・アイデアの情報源です。質問に関連するカテゴリのファイルを読んでください。',
    '',
    `- 最終更新: ${generated_at}`,
    `- 総件数: ${visible.length}（未分析 ${pendingCount}）`,
    '',
    '## ファイル構成',
    '',
    '- `timeline.md` … 全リンクを新しい順に',
    '- `categories/<カテゴリ名>.md` … カテゴリ別',
    '- `links.jsonl` … 機械処理用（1行1リンク）',
    '',
    '## カテゴリ一覧',
    '',
    ...used.map((c) => `- [${c.name}](categories/${encodeURI(safeFileName(c.name))}.md)（${c.count}件）: ${c.description}`),
    '',
  ].join('\n');

  files['knowledge/timeline.md'] = ['# 時系列（新しい順）', '', ...groupByMonth(visible)].join('\n');

  for (const c of used) {
    const list = visible.filter((i) => i.category === c.name);
    files[`knowledge/categories/${safeFileName(c.name)}.md`] = [
      `# ${c.name}`,
      '',
      c.description ? `> ${c.description}` : '',
      '',
      `${list.length}件・新しい順`,
      '',
      ...list.map(itemMarkdown),
    ].join('\n');
  }
  return { files, stats: { total: visible.length, deleted: items.length - visible.length, pending: pendingCount, categories: used.length } };
}

function groupByMonth(items) {
  const out = [];
  let cur = '';
  for (const i of items) {
    const m = (i.created_at || '').slice(0, 7);
    if (m !== cur) { out.push(`## ${m}`, ''); cur = m; }
    out.push(itemMarkdown(i));
  }
  return out;
}

function itemMarkdown(i) {
  const title = i.title || i.url || 'メモ';
  const head = i.url ? `### [${title.replace(/[[\]]/g, '')}](${i.url})` : `### ${title}`;
  const meta = [`保存: ${(i.created_at || '').replace('T', ' ').slice(0, 16)}`];
  if (i.category) meta.push(`カテゴリ: ${i.category}`);
  if (i.tags?.length) meta.push(`タグ: ${i.tags.join(', ')}`);
  if (i.author) meta.push(`投稿者: ${i.author}`);
  const lines = [head, '', `- ${meta.join(' / ')}`];
  if (i.note) lines.push(`- メモ: ${i.note}`);
  if (i.status !== 'analyzed') lines.push('- （未分析）');
  lines.push('');
  if (i.summary) lines.push(i.summary, '');
  if (i.key_points?.length) lines.push(...i.key_points.map((p) => `- ${p}`), '');
  return lines.join('\n');
}
