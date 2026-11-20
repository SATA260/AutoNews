import {
  ArticleStatusSchema,
  type ArticleTimeField,
  ArticleTimeFieldSchema,
  ExtractStatusSchema,
  SourceLangSchema,
} from '@aidaily/contracts';
import { ArticlesManager } from '@/components/ArticlesManager';
import { getCore } from '@/lib/core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_PAGE_SIZE = 50;

/** 解析正整数页码查询参数 */
function parsePositivePage(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return 1;
  }
  const n = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

/** 爬取新闻浏览与清理页：按信源、状态、提取状态、关键词及时间范围查看和删除抓取的文章 */
export default async function ArticlesPage({
  searchParams,
}: {
  searchParams: Promise<{
    sourceId?: string;
    status?: string;
    extractStatus?: string;
    lang?: string;
    q?: string;
    timeField?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  const sp = await searchParams;
  const sourceId = sp.sourceId?.trim() || '';
  const statusParsed = sp.status ? ArticleStatusSchema.safeParse(sp.status.trim()) : null;
  const extractParsed = sp.extractStatus
    ? ExtractStatusSchema.safeParse(sp.extractStatus.trim())
    : null;
  const langParsed = sp.lang ? SourceLangSchema.safeParse(sp.lang.trim()) : null;
  const queryText = sp.q?.trim() || '';
  const timeFieldParsed = sp.timeField
    ? ArticleTimeFieldSchema.safeParse(sp.timeField.trim())
    : null;
  const timeField: ArticleTimeField = timeFieldParsed?.success ? timeFieldParsed.data : 'effective';
  const from = sp.from?.trim() || '';
  const to = sp.to?.trim() || '';
  const page = parsePositivePage(sp.page);

  const core = await getCore();
  const settings = core.config.getSettings();
  const sources = (await core.sources.list()).map((entry) => ({
    id: entry.source.id,
    name: entry.source.name,
    enabled: entry.source.enabled,
  }));

  let listResult = {
    items: [] as Awaited<ReturnType<typeof core.articles.list>>['items'],
    total: 0,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
    statusCounts: { new: 0, reserved: 0, consumed: 0, expired: 0, rejected: 0 },
  };
  let filterError: string | null = null;

  try {
    listResult = await core.articles.list({
      ...(sourceId ? { sourceId } : {}),
      ...(statusParsed?.success ? { status: [statusParsed.data] } : {}),
      ...(extractParsed?.success ? { extractStatus: [extractParsed.data] } : {}),
      ...(langParsed?.success ? { lang: langParsed.data } : {}),
      ...(queryText ? { query: queryText } : {}),
      timeField,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      page,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  } catch (err) {
    filterError = err instanceof Error ? err.message : String(err);
  }

  return (
    <ArticlesManager
      articles={listResult.items}
      total={listResult.total}
      page={listResult.page}
      pageSize={listResult.pageSize}
      statusCounts={listResult.statusCounts}
      sources={sources}
      timezone={settings.timezone}
      initialFilter={{
        sourceId,
        status: statusParsed?.success ? statusParsed.data : '',
        extractStatus: extractParsed?.success ? extractParsed.data : '',
        lang: langParsed?.success ? langParsed.data : '',
        query: queryText,
        timeField,
        from,
        to,
      }}
      filterError={filterError}
    />
  );
}
