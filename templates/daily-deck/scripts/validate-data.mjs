import fs from 'node:fs';
import path from 'node:path';

const LIMITS = {
  maxItems: 12,
  issueTitle: 14,
  issueNumber: 20,
  date: 20,
  headline: 48,
  footerCta: 56,
  category: 10,
  shortTitle: 30,
  title: 48,
  summary: 100,
  keyPointsCount: 3,
  keyPoint: 32,
  imageCaption: 44,
  officialQuote: 120,
  metricsCount: 4,
  metricLabel: 12,
  metricValue: 18,
  source: 24,
  sourceUrl: 42,
  publishedAt: 16,
};

const targetPath = path.resolve(process.cwd(), process.argv[2] || 'public/data/latest.json');

if (!fs.existsSync(targetPath)) {
  console.error(`❌ Data file not found: ${targetPath}`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
const warnings = [];

const len = (s) => Array.from(String(s ?? '')).length;
const checkLen = (field, value, max) => {
  if (typeof value === 'string' && len(value) > max) {
    warnings.push(`${field}: length ${len(value)} exceeds limit ${max}`);
  }
};

checkLen('issueTitle', raw.issueTitle, LIMITS.issueTitle);
checkLen('issueNumber', raw.issueNumber, LIMITS.issueNumber);
checkLen('date', raw.date, LIMITS.date);
checkLen('headline', raw.headline, LIMITS.headline);
checkLen('footerCta', raw.footerCta, LIMITS.footerCta);

const items = Array.isArray(raw.items) ? raw.items : [];
if (items.length === 0) {
  warnings.push('items: must contain at least 1 news item');
}
if (items.length > LIMITS.maxItems) {
  warnings.push(`items: count ${items.length} exceeds max ${LIMITS.maxItems}`);
}

items.forEach((item, idx) => {
  const prefix = `items[${idx}]`;
  checkLen(`${prefix}.category`, item.category, LIMITS.category);
  checkLen(`${prefix}.shortTitle`, item.shortTitle, LIMITS.shortTitle);
  checkLen(`${prefix}.title`, item.title, LIMITS.title);
  checkLen(`${prefix}.summary`, item.summary, LIMITS.summary);
  checkLen(`${prefix}.imageCaption`, item.imageCaption, LIMITS.imageCaption);
  checkLen(`${prefix}.officialQuote`, item.officialQuote, LIMITS.officialQuote);
  checkLen(`${prefix}.source`, item.source, LIMITS.source);
  checkLen(`${prefix}.sourceUrl`, item.sourceUrl, LIMITS.sourceUrl);
  checkLen(`${prefix}.publishedAt`, item.publishedAt, LIMITS.publishedAt);
  if (Array.isArray(item.keyPoints)) {
    if (item.keyPoints.length > LIMITS.keyPointsCount) {
      warnings.push(`${prefix}.keyPoints: count ${item.keyPoints.length} exceeds ${LIMITS.keyPointsCount}`);
    }
    item.keyPoints.forEach((kp, kpIdx) => checkLen(`${prefix}.keyPoints[${kpIdx}]`, kp, LIMITS.keyPoint));
  }
  if (Array.isArray(item.metrics)) {
    if (item.metrics.length > LIMITS.metricsCount) {
      warnings.push(`${prefix}.metrics: count ${item.metrics.length} exceeds ${LIMITS.metricsCount}`);
    }
    item.metrics.forEach((m, mIdx) => {
      checkLen(`${prefix}.metrics[${mIdx}].label`, m?.label, LIMITS.metricLabel);
      checkLen(`${prefix}.metrics[${mIdx}].value`, m?.value, LIMITS.metricValue);
    });
  }
});

console.log(`📰 Validated ${path.relative(process.cwd(), targetPath)} (${items.length} news items, ${items.length + 2} total slides)`);
if (warnings.length === 0) {
  console.log('✅ All fields strictly within limits (0 warnings).');
} else {
  console.log(`⚠️ ${warnings.length} guardrail warning(s):`);
  warnings.forEach((w) => console.log(`  - ${w}`));
}
