import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceLang } from '@aidaily/contracts';

/** 传入提示词模板的单篇原始文章上下文结构 */
export interface ArticlePromptInput {
  id: string;
  lang: SourceLang;
  sourceName: string;
  tier: 1 | 2 | 3;
  publishedAt: string | null;
  text: string;
}

const SAFE_TEMPLATE_NAME = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?\.md$/;

/** 定位提示词模板目录（兼容源码目录直跑与打包产物目录运行） */
export function resolvePromptsDir(overrideDir?: string): string {
  if (overrideDir) {
    return path.resolve(overrideDir);
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '..', '..', 'prompts'),
    path.resolve(currentDir, '..', 'prompts'),
  ];
  for (const dir of candidates) {
    if (fsSync.existsSync(dir)) {
      return dir;
    }
  }
  throw new Error(`未找到提示词模板目录，已排查路径: ${candidates.join(', ')}`);
}

/**
 * 读取指定名称的提示词模板文件，并用单次遍历替换全部 `{{变量名}}` 占位符，
 * 确保替换后文章正文中若恰巧包含双花括号也不会被二次展开。
 */
export async function renderPromptTemplate(
  templateName: string,
  vars: Record<string, string>,
  promptsDir?: string,
): Promise<string> {
  if (templateName.includes('..') || !SAFE_TEMPLATE_NAME.test(templateName)) {
    throw new Error(`非法的提示词模板文件名: ${templateName}`);
  }
  const baseDir = resolvePromptsDir(promptsDir);
  const templatePath = path.join(baseDir, templateName);
  const raw = await fs.readFile(templatePath, 'utf8');

  return raw.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (full, key: string) => {
    return Object.hasOwn(vars, key) ? (vars[key] ?? '') : full;
  });
}

/** 对 XML 属性值中的特殊字符进行安全转义 */
function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** 防止文章正文中出现闭合标签破坏提示词结构 */
function escapeArticleBody(body: string): string {
  return body.replace(/<\/article>/gi, '&lt;/article&gt;');
}

/**
 * 将事件关联的多篇原始文章拼装为带元信息的 XML 片段：
 * 优先保证信源等级更高（tier 更小）的文章获得完整字数配额，确保总字符数严格不超过上限。
 */
export function buildArticlesXml(articles: ArticlePromptInput[], sourceMaxChars: number): string {
  if (articles.length === 0 || sourceMaxChars <= 0) {
    return '';
  }

  const prioritized = articles
    .map((article, idx) => ({ article, idx }))
    .sort((a, b) => a.article.tier - b.article.tier || a.idx - b.idx);

  let remainingChars = sourceMaxChars;
  const blocksByIndex = new Map<number, string>();

  for (const { article, idx } of prioritized) {
    const header = `<article id="${escapeXmlAttr(article.id)}" lang="${escapeXmlAttr(article.lang)}" source="${escapeXmlAttr(article.sourceName)}" publishedAt="${escapeXmlAttr(article.publishedAt ?? 'unknown')}">`;
    const footer = '</article>';
    const wrapperLen = header.length + footer.length + 2;
    const minBudget = wrapperLen + 40;

    if (remainingChars < minBudget) {
      break;
    }

    const bodyRaw = escapeArticleBody(article.text.trim());
    const availableBodyChars = remainingChars - wrapperLen;
    let bodySlice = bodyRaw;
    if (bodyRaw.length > availableBodyChars) {
      const cutLen = Math.max(1, availableBodyChars - 1);
      bodySlice = `${bodyRaw.slice(0, cutLen)}…`;
    }

    const block = `${header}\n${bodySlice}\n${footer}`;
    blocksByIndex.set(idx, block);
    remainingChars -= block.length + 1;
  }

  const orderedBlocks: string[] = [];
  for (let i = 0; i < articles.length; i++) {
    const block = blocksByIndex.get(i);
    if (block) {
      orderedBlocks.push(block);
    }
  }
  return orderedBlocks.join('\n');
}
