#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--help')) {
  process.stdout.write('Usage of agy:\n  --model\n  -p\n  --json-schema\n');
  process.exit(0);
}

if (args[0] === 'models') {
  process.stdout.write(
    'gemini-4-carbon-high      Gemini 4 Carbon (High)\n' +
      'gemini-3.8-flash-high     Gemini 3.8 Flash (High)\n' +
      'gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)\n',
  );
  process.exit(0);
}

const pIdx = args.indexOf('-p');
const prompt = pIdx !== -1 ? (args[pIdx + 1] ?? '') : '';
const modelIdx = args.indexOf('--model');
const model = modelIdx !== -1 ? (args[modelIdx + 1] ?? '') : '';

function emitSuccess(structuredOutput) {
  process.stdout.write(
    JSON.stringify({
      conversation_id: `conv-fake-${Date.now()}`,
      status: 'SUCCESS',
      response: JSON.stringify(structuredOutput),
      structured_output: structuredOutput,
      usage: {
        input_tokens: 1500,
        output_tokens: 200,
      },
    }),
  );
  process.exit(0);
}

// 健康检查最小结构化探测
if (prompt.includes('Return JSON {"ok": true}')) {
  emitSuccess({ ok: true });
}

function detectStage(text) {
  const match = /<!--stage:([a-zA-Z0-9_-]+)-->/.exec(text);
  return match?.[1] ?? 'unknown';
}

const stage = detectStage(prompt);

// 若提供了脚本规则文件，先记录日志并检查匹配规则
const scriptFile = process.env.FAKE_AGY_SCRIPT_FILE;
if (scriptFile && fs.existsSync(scriptFile)) {
  const cfg = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
  const callLogFile = `${scriptFile}.calls.jsonl`;
  fs.appendFileSync(
    callLogFile,
    `${JSON.stringify({ stage, model, ts: Date.now(), promptHead: prompt.slice(0, 180) })}\n`,
  );

  const rules = cfg.rules ?? [];
  for (let rIdx = 0; rIdx < rules.length; rIdx++) {
    const rule = rules[rIdx];
    if (rule.stage && rule.stage !== stage) {
      continue;
    }
    if (rule.modelEquals && rule.modelEquals !== model) {
      continue;
    }
    const needles = rule.contains ?? [];
    if (!needles.every((n) => prompt.includes(n))) {
      continue;
    }
    const ruleStateFile = `${scriptFile}.rule-${rIdx}.state`;
    const count = fs.existsSync(ruleStateFile)
      ? Number.parseInt(fs.readFileSync(ruleStateFile, 'utf8'), 10) || 0
      : 0;
    const actions = rule.actions ?? [];
    const actionIdx = Math.min(count, Math.max(0, actions.length - 1));
    const action = actions[actionIdx];

    fs.writeFileSync(ruleStateFile, String(count + 1));

    if (!action) {
      continue;
    }
    if (action.passThrough) {
      break;
    }
    if (action.mode === 'exit_error') {
      process.stdout.write(
        JSON.stringify({ status: 'ERROR', error: action.error ?? 'Injected model error' }),
      );
      process.exit(1);
    }
    if (action.mode === 'auth_error') {
      process.stderr.write('Error: user is not logged in.\n');
      process.exit(1);
    }
    if (action.mode === 'bad_json') {
      process.stdout.write('INVALID_NOT_JSON');
      process.exit(0);
    }
    if (action.output) {
      emitSuccess(action.output);
    }
  }
}

// 从 prompt 自动解析上下文生成合乎校验与原文依据规则的默认结构化输出
function extractFirstArticle(text) {
  const m = /<article\s+id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/article>/.exec(text);
  if (!m) {
    return { id: 'unknown', body: '默认新闻正文说明。' };
  }
  return { id: m[1], body: m[2].trim() };
}

function extractCandidatesJson(text) {
  const marker = '## 候选文章列表（JSON）\n';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    return [];
  }
  try {
    return JSON.parse(text.slice(idx + marker.length).trim());
  } catch {
    return [];
  }
}

function extractJsonSection(text, heading) {
  const marker = `${heading}\n`;
  const idx = text.indexOf(marker);
  if (idx === -1) {
    return null;
  }
  const rest = text.slice(idx + marker.length);
  const nextHeading = rest.search(/\n## /);
  const block = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  try {
    return JSON.parse(block);
  } catch {
    return null;
  }
}

if (stage === 'select') {
  const candidates = extractCandidatesJson(prompt);
  const events = candidates.map((c, idx) => ({
    title: c.title,
    articleIds: [c.id],
    category: '人工智能',
    entity: idx % 2 === 0 ? 'OpenAI' : 'Google',
    score: Math.max(1, 10 - idx),
    publicAppeal: Math.max(1, 9 - idx),
    reason: `重点行业进展：${c.title.slice(0, 12)}`,
    duplicateOfHistory: false,
  }));
  emitSuccess({ events });
}

if (stage === 'summarize') {
  const art = extractFirstArticle(prompt);
  const quote = art.body.slice(0, 80).trim();
  emitSuccess({
    facts: ['相关机构发布了人工智能更新，带来效率提升。'],
    relevance: '普通用户可以更快地体验该功能并提升日常效率。',
    availability: 'available_now',
    availabilityNote: '目前已面向常规用户陆续开放使用。',
    evidence: [
      {
        claim: '官方原文给出了相关功能更新说明。',
        articleId: art.id,
        quote,
      },
    ],
  });
}

if (stage === 'polish') {
  const draft = extractJsonSection(prompt, '## 事实摘要草稿（JSON）') ?? {
    facts: ['人工智能新工具正式上线。'],
    relevance: '普通用户已可直接在日常场景中使用。',
    availabilityNote: '目前开放使用。',
    evidence: [{ claim: '可用性说明', articleId: 'unknown', quote: '默认引语' }],
  };
  const titleMatch = /- 事件标题：(.+)/.exec(prompt);
  const rawTitle = (titleMatch?.[1] ?? '重点 AI 进展发布').trim();
  const title = rawTitle.slice(0, 24);
  const shortTitle = rawTitle.slice(0, 12);

  emitSuccess({
    title,
    shortTitle,
    category: '大模型',
    entity: 'OpenAI',
    summary: '主流机构推出新一轮人工智能更新，当前用户已可使用。',
    ...(prompt.includes('总字数110～180字')
      ? { highlight: '人工智能技术获得更新', preferArticleImage: false }
      : {}),
    keyPoints: ['新功能已正式推出', '面向普通用户开放体验'],
    detail: '本次发布重点围绕实用性优化，降低了普通人的使用门槛。',
    hostComment: '这项更新对日常工作很有帮助。',
    narration: prompt.includes('总字数110～180字')
      ? [
          '今天我们一起来关注一项人工智能领域的新进展。',
          '有关团队介绍了这次更新，并说明目前的使用范围。',
          '这项进展为关注人工智能技术的用户提供了新的信息。',
          '具体的能力和适用范围，还需要结合官方说明来了解。',
          '我们也会继续关注这项技术之后带来的实际变化。',
        ]
      : ['今天来看一条新动态。', '新功能已经面向大众用户正式推出。'],
    evidence: draft.evidence,
  });
}

if (stage === 'revise') {
  const prev = extractJsonSection(prompt, '## 上一版润色稿（JSON）') ?? {};
  const art = extractFirstArticle(prompt);
  const quote = art.body.slice(0, 80).trim();
  emitSuccess({
    ...prev,
    title: String(prev.title ?? '修正后 AI 动态').slice(0, 24),
    shortTitle: String(prev.shortTitle ?? '修正动态').slice(0, 12),
    summary: '经过核对修正，该功能目前在测试范围外暂未全部开放。',
    narration: ['经过仔细核对原文信息。', '该新能力目前仅在局部范围内开放测试。'],
    evidence:
      Array.isArray(prev.evidence) && prev.evidence.length > 0
        ? prev.evidence
        : [{ claim: '依据原文核对', articleId: art.id, quote }],
  });
}

if (stage === 'factcheck') {
  emitSuccess({
    verdict: 'pass',
    claims: [
      {
        text: '稿件中主要事实均有原文依据支撑',
        status: 'supported',
        note: '核对原文后确认完全一致',
      },
    ],
    revisionNotes: [],
  });
}

if (stage === 'package') {
  const items = extractJsonSection(prompt, '## 本期已过审新闻列表（JSON）') ?? [];
  const order = items.map((i) => i.itemId);
  emitSuccess({
    order,
    headlineItemId: order[0] ?? 'item-1',
    headline: '今日头条看点：大模型应用再迎实用升级',
    leadSummary: '今天重点为你盘点几条贴近日常工作的人工智能新动向。',
    intro: {
      narration: ['大家好，欢迎收看今天的 AI 每日报。', '马上带你速览今日热点。'],
      hostComment: '今天每条动态都值得留意。',
    },
    outro: {
      narration: ['以上就是本期全部内容。', '感谢大家收看。'],
      hostComment: '期待在评论区看到你的真实体验。',
      cta: '本期更新里你最期待哪项功能？评论区聊聊吧。',
    },
    publish: {
      title: 'AI每日报｜实用新功能上线，普通人也能轻松用',
      descriptionIntro: '本期整理了今日最值得关注的几条实用 AI 进展。',
      tags: ['科技前沿', '效率工具'],
    },
  });
}

emitSuccess({ ok: true });
