'use client';

import type {
  ArticleDetail,
  ArticleListItem,
  ArticleStatus,
  ArticleStatusCounts,
  ArticleTimeField,
  DeleteArticlesInput,
  DeleteArticlesResult,
  ExtractStatus,
} from '@aidaily/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import {
  deleteArticlesAction,
  getArticleDetailAction,
  markArticlesUnplayedAction,
  previewDeleteArticlesAction,
} from '@/app/actions';
import {
  ARTICLE_STATUS_TEXT,
  articleStatusBadgeClass,
  EXTRACT_STATUS_TEXT,
  formatBytes,
  formatDateTimeLocalInTz,
  formatTimestamp,
} from '@/lib/format';

/** 爬取新闻列表与管理组件的参数定义 */
export interface ArticlesManagerProps {
  articles: ArticleListItem[];
  total: number;
  page: number;
  pageSize: number;
  statusCounts: ArticleStatusCounts;
  sources: Array<{ id: string; name: string; enabled: boolean }>;
  timezone: string;
  initialFilter: {
    sourceId: string;
    status: string;
    extractStatus: string;
    lang: string;
    query: string;
    timeField: ArticleTimeField;
    from: string;
    to: string;
  };
  filterError?: string | null;
}

const ARTICLE_STATUS_ORDER: readonly ArticleStatus[] = [
  'new',
  'reserved',
  'consumed',
  'expired',
  'rejected',
];

const EXTRACT_STATUS_ORDER: readonly ExtractStatus[] = ['ok', 'feed_only', 'failed', 'pending'];

const MEDIA_KIND_TEXT: Record<string, string> = {
  chart: '数据图表',
  table_shot: '表格截图',
  tweet_shot: '推文截图',
  tweet_media: '推文配图',
  screenshot: '网页截图',
  cover: '封面配图',
};

/** 构造带筛选和页码条件的爬取新闻页链接地址 */
function buildArticlesUrl(params: {
  sourceId?: string;
  status?: string;
  extractStatus?: string;
  lang?: string;
  query?: string;
  timeField?: ArticleTimeField;
  from?: string;
  to?: string;
  page?: number;
}): string {
  const sp = new URLSearchParams();
  if (params.sourceId) sp.set('sourceId', params.sourceId);
  if (params.status) sp.set('status', params.status);
  if (params.extractStatus) sp.set('extractStatus', params.extractStatus);
  if (params.lang) sp.set('lang', params.lang);
  if (params.query) sp.set('q', params.query);
  if (params.timeField && params.timeField !== 'effective') sp.set('timeField', params.timeField);
  if (params.from) sp.set('from', params.from);
  if (params.to) sp.set('to', params.to);
  if (params.page && params.page > 1) sp.set('page', String(params.page));
  const qs = sp.toString();
  return qs ? `/articles?${qs}` : '/articles';
}

/** 爬取新闻管理面板：支持多条件及时间范围查看正文详情、多选删除及按时间筛选批量清理 */
export function ArticlesManager({
  articles,
  total,
  page,
  pageSize,
  statusCounts,
  sources,
  timezone,
  initialFilter,
  filterError,
}: ArticlesManagerProps) {
  const router = useRouter();
  const [sourceId, setSourceId] = useState(initialFilter.sourceId);
  const [status, setStatus] = useState(initialFilter.status);
  const [extractStatus, setExtractStatus] = useState(initialFilter.extractStatus);
  const [lang, setLang] = useState(initialFilter.lang);
  const [query, setQuery] = useState(initialFilter.query);
  const [timeField, setTimeField] = useState<ArticleTimeField>(initialFilter.timeField);
  const [from, setFrom] = useState(initialFilter.from);
  const [to, setTo] = useState(initialFilter.to);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  // 单篇详情弹窗状态
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [activeDetail, setActiveDetail] = useState<ArticleDetail | null>(null);

  // 选择性删除预览确认弹窗状态
  const [selectedDeleteIds, setSelectedDeleteIds] = useState<string[] | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<DeleteArticlesResult | null>(null);
  const [selectedPreviewError, setSelectedPreviewError] = useState<string | null>(null);

  // 按时间筛选批量删除弹窗状态
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchPreset, setBatchPreset] = useState<'24h' | '3d' | '7d' | '30d' | 'custom'>('7d');
  const [batchTimeField, setBatchTimeField] = useState<ArticleTimeField>('effective');
  const [batchFrom, setBatchFrom] = useState('');
  const [batchTo, setBatchTo] = useState('');
  const [batchSourceId, setBatchSourceId] = useState('');
  const [batchStatus, setBatchStatus] = useState('');
  const [batchExtractStatus, setBatchExtractStatus] = useState('');
  const [batchPreview, setBatchPreview] = useState<DeleteArticlesResult | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  useEffect(() => {
    setSourceId(initialFilter.sourceId);
    setStatus(initialFilter.status);
    setExtractStatus(initialFilter.extractStatus);
    setLang(initialFilter.lang);
    setQuery(initialFilter.query);
    setTimeField(initialFilter.timeField);
    setFrom(initialFilter.from);
    setTo(initialFilter.to);
  }, [initialFilter]);

  const selectableIds = articles
    .filter((art) => art.status !== 'reserved' && art.reservedByRun === null)
    .map((art) => art.id);
  const selectableIdSet = new Set(selectableIds);
  const activeSelectedIds = selectedIds.filter((id) => selectableIdSet.has(id));
  const selectedConsumedIds = articles
    .filter((art) => activeSelectedIds.includes(art.id) && art.status === 'consumed')
    .map((art) => art.id);
  const allSelectableChecked =
    selectableIds.length > 0 && activeSelectedIds.length === selectableIds.length;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const statusSumAll =
    statusCounts.new +
    statusCounts.reserved +
    statusCounts.consumed +
    statusCounts.expired +
    statusCounts.rejected;

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAllOnPage = () => {
    if (allSelectableChecked) {
      setSelectedIds([]);
    } else {
      setSelectedIds(selectableIds);
    }
  };

  const handleFilterSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    router.push(
      buildArticlesUrl({
        sourceId,
        status,
        extractStatus,
        lang,
        query: query.trim(),
        timeField,
        from,
        to,
        page: 1,
      }),
    );
  };

  const applyFilterPreset = (preset: '24h' | '3d' | 'before7d' | 'reset') => {
    if (preset === 'reset') {
      setSourceId('');
      setStatus('');
      setExtractStatus('');
      setLang('');
      setQuery('');
      setTimeField('effective');
      setFrom('');
      setTo('');
      router.push('/articles');
      return;
    }

    const now = new Date();
    let nextFrom = '';
    let nextTo = '';
    if (preset === '24h') {
      nextFrom = formatDateTimeLocalInTz(new Date(now.getTime() - 24 * 3600_000), timezone);
    } else if (preset === '3d') {
      nextFrom = formatDateTimeLocalInTz(new Date(now.getTime() - 3 * 86_400_000), timezone);
    } else {
      nextTo = formatDateTimeLocalInTz(new Date(now.getTime() - 7 * 86_400_000), timezone);
    }
    setFrom(nextFrom);
    setTo(nextTo);
    router.push(
      buildArticlesUrl({
        sourceId,
        status,
        extractStatus,
        lang,
        query: query.trim(),
        timeField,
        from: nextFrom,
        to: nextTo,
        page: 1,
      }),
    );
  };

  const openDetailModal = (articleId: string) => {
    setActiveDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    startTransition(async () => {
      const res = await getArticleDetailAction(articleId);
      setDetailLoading(false);
      if (!res.ok || !res.data) {
        setDetailError(res.error ?? '读取文章正文失败');
        return;
      }
      setActiveDetail(res.data);
    });
  };

  const openSelectedDeleteModal = (ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    setSelectedDeleteIds(ids);
    setSelectedPreview(null);
    setSelectedPreviewError(null);
    startTransition(async () => {
      const res = await previewDeleteArticlesAction({ ids });
      if (!res.ok || !res.data) {
        setSelectedPreviewError(res.error ?? '预览待删除文章范围失败');
        return;
      }
      setSelectedPreview(res.data);
    });
  };

  const handleConfirmSelectedDelete = () => {
    if (!selectedDeleteIds || selectedDeleteIds.length === 0) {
      return;
    }
    startTransition(async () => {
      const res = await deleteArticlesAction({ ids: selectedDeleteIds });
      if (!res.ok) {
        setSelectedPreviewError(res.error ?? '删除文章失败');
        return;
      }
      setSelectedDeleteIds(null);
      setSelectedPreview(null);
      setActiveDetail(null);
      setSelectedIds([]);
      setFeedback({ ok: true, text: res.message ?? '删除完成' });
      router.refresh();
    });
  };

  const handleMarkUnplayed = (ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    setFeedback(null);
    startTransition(async () => {
      const res = await markArticlesUnplayedAction(ids);
      if (!res.ok) {
        setFeedback({ ok: false, text: res.error ?? '标记为未播失败' });
        return;
      }
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
      setActiveDetail((prev) =>
        prev && ids.includes(prev.article.id)
          ? { ...prev, article: { ...prev.article, status: 'new' } }
          : prev,
      );
      setFeedback({ ok: true, text: res.message ?? '已标记为未播' });
      router.refresh();
    });
  };

  const applyBatchPreset = (preset: '24h' | '3d' | '7d' | '30d' | 'custom') => {
    setBatchPreset(preset);
    setBatchPreview(null);
    setBatchError(null);
    if (preset === 'custom') {
      return;
    }
    const hoursMap: Record<'24h' | '3d' | '7d' | '30d', number> = {
      '24h': 24,
      '3d': 72,
      '7d': 24 * 7,
      '30d': 24 * 30,
    };
    const cutoffDate = new Date(Date.now() - hoursMap[preset] * 3600_000);
    setBatchFrom('');
    setBatchTo(formatDateTimeLocalInTz(cutoffDate, timezone));
  };

  const openBatchModal = () => {
    setBatchModalOpen(true);
    setBatchPreview(null);
    setBatchError(null);
    setBatchTimeField(timeField);
    setBatchSourceId(sourceId);
    setBatchStatus(status);
    setBatchExtractStatus(extractStatus);
    applyBatchPreset('7d');
  };

  const buildBatchInput = (): DeleteArticlesInput => {
    const input: DeleteArticlesInput = {
      timeField: batchTimeField,
    };
    if (batchSourceId) input.sourceId = batchSourceId;
    if (batchStatus) input.status = [batchStatus as ArticleStatus];
    if (batchExtractStatus) input.extractStatus = [batchExtractStatus as ExtractStatus];
    if (batchFrom.trim()) input.from = batchFrom.trim();
    if (batchTo.trim()) input.to = batchTo.trim();
    return input;
  };

  const handlePreviewBatch = () => {
    setBatchError(null);
    setBatchPreview(null);
    const input = buildBatchInput();
    startTransition(async () => {
      const res = await previewDeleteArticlesAction(input);
      if (!res.ok || !res.data) {
        setBatchError(res.error ?? '预演失败');
        return;
      }
      setBatchPreview(res.data);
    });
  };

  const handleExecuteBatch = () => {
    setBatchError(null);
    const input = buildBatchInput();
    startTransition(async () => {
      const res = await deleteArticlesAction(input);
      if (!res.ok) {
        setBatchError(res.error ?? '批量删除失败');
        return;
      }
      setBatchModalOpen(false);
      setBatchPreview(null);
      setSelectedIds([]);
      setFeedback({ ok: true, text: res.message ?? '批量删除完成' });
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200/80 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">爬取新闻浏览与清理</h1>
          <p className="mt-1 text-sm text-slate-600">
            逐条查看所有信源抓回的新闻原文与正文提取状态，支持多选删除或按时间范围清理本地缓存（展示时区：
            {timezone}）。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedConsumedIds.length > 0 && (
            <button
              type="button"
              disabled={isPending}
              onClick={() => handleMarkUnplayed(selectedConsumedIds)}
              className="rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-medium text-amber-800 shadow-xs transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              标为未播（{selectedConsumedIds.length} 篇已播）
            </button>
          )}
          <button
            type="button"
            disabled={isPending || activeSelectedIds.length === 0}
            onClick={() => openSelectedDeleteModal(activeSelectedIds)}
            className="rounded-lg border border-rose-300 bg-white px-3.5 py-2 text-xs font-medium text-rose-700 shadow-xs transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            删除选中（{activeSelectedIds.length} 条）
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={openBatchModal}
            className="rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-medium text-white shadow-xs transition hover:bg-rose-700 disabled:opacity-50"
          >
            按时间筛选批量删除
          </button>
        </div>
      </div>

      {filterError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-700">
          时间筛选参数有误：{filterError}
        </div>
      )}

      {feedback && (
        <div
          role={feedback.ok ? 'status' : 'alert'}
          className={`rounded-lg border px-4 py-2.5 text-xs ${
            feedback.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-700'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={buildArticlesUrl({
            sourceId,
            extractStatus,
            lang,
            query: query.trim(),
            timeField,
            from,
            to,
            page: 1,
          })}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            status === ''
              ? 'border-slate-900 bg-slate-900 text-white'
              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
          }`}
        >
          全部（{statusSumAll}）
        </Link>
        {ARTICLE_STATUS_ORDER.map((st) => {
          const active = status === st;
          return (
            <Link
              key={st}
              href={buildArticlesUrl({
                sourceId,
                status: st,
                extractStatus,
                lang,
                query: query.trim(),
                timeField,
                from,
                to,
                page: 1,
              })}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
              }`}
            >
              {ARTICLE_STATUS_TEXT[st]}（{statusCounts[st]}）
            </Link>
          );
        })}
      </div>

      <form
        onSubmit={handleFilterSubmit}
        className="space-y-3 rounded-2xl border border-slate-200/90 bg-white p-4 shadow-xs"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label htmlFor="art-q" className="block text-[11px] font-medium text-slate-600">
              关键词（标题 / 摘要 / 链接）
            </label>
            <input
              id="art-q"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="输入关键词…"
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
            />
          </div>

          <div>
            <label htmlFor="art-source" className="block text-[11px] font-medium text-slate-600">
              信源
            </label>
            <select
              id="art-source"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              <option value="">全部信源</option>
              {sources.map((src) => (
                <option key={src.id} value={src.id}>
                  {src.name}
                  {src.enabled ? '' : '（已停用）'}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="art-status" className="block text-[11px] font-medium text-slate-600">
              文章状态
            </label>
            <select
              id="art-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              <option value="">全部状态</option>
              {ARTICLE_STATUS_ORDER.map((st) => (
                <option key={st} value={st}>
                  {ARTICLE_STATUS_TEXT[st]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="art-extract" className="block text-[11px] font-medium text-slate-600">
              正文提取状态
            </label>
            <select
              id="art-extract"
              value={extractStatus}
              onChange={(e) => setExtractStatus(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              <option value="">全部</option>
              {EXTRACT_STATUS_ORDER.map((es) => (
                <option key={es} value={es}>
                  {EXTRACT_STATUS_TEXT[es]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="art-lang" className="block text-[11px] font-medium text-slate-600">
              语言
            </label>
            <select
              id="art-lang"
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              <option value="">全部语言</option>
              <option value="zh">中文 (zh)</option>
              <option value="en">英文 (en)</option>
            </select>
          </div>
        </div>

        <div className="grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label
              htmlFor="art-time-field"
              className="block text-[11px] font-medium text-slate-600"
            >
              时间筛选口径
            </label>
            <select
              id="art-time-field"
              value={timeField}
              onChange={(e) => setTimeField(e.target.value as ArticleTimeField)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900"
            >
              <option value="effective">优先发布时间（无则按入库时间）</option>
              <option value="first_seen">仅按抓取入库时间</option>
            </select>
          </div>

          <div>
            <label htmlFor="art-from" className="block text-[11px] font-medium text-slate-600">
              起始时间
            </label>
            <input
              id="art-from"
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
            />
          </div>

          <div>
            <label htmlFor="art-to" className="block text-[11px] font-medium text-slate-600">
              截止时间
            </label>
            <input
              id="art-to"
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900"
            />
          </div>

          <div className="flex flex-wrap items-end gap-1.5">
            <button
              type="submit"
              className="rounded-lg bg-slate-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              筛选查询
            </button>
            <button
              type="button"
              onClick={() => applyFilterPreset('24h')}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
            >
              近 24 小时
            </button>
            <button
              type="button"
              onClick={() => applyFilterPreset('3d')}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
            >
              近 3 天
            </button>
            <button
              type="button"
              onClick={() => applyFilterPreset('before7d')}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
            >
              7 天前旧闻
            </button>
            <button
              type="button"
              onClick={() => applyFilterPreset('reset')}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
            >
              清空
            </button>
          </div>
        </div>
      </form>

      <section className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5 text-xs text-slate-600">
          <span>
            共匹配 <strong className="text-slate-900">{total}</strong> 篇爬取文章（第 {page} /{' '}
            {totalPages} 页）
          </span>
          {selectableIds.length > 0 && (
            <span className="text-[11px] text-slate-500">
              本页可勾选删除 {selectableIds.length} 篇（正被运行或待审任务占用的文章自动受保护）
            </span>
          )}
        </div>

        {articles.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            当前筛选条件下暂无已爬取的新闻记录。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="全选本页可删除新闻"
                      checked={allSelectableChecked}
                      disabled={selectableIds.length === 0}
                      onChange={toggleAllOnPage}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                    />
                  </th>
                  <th className="px-3 py-2.5 font-medium">新闻标题与摘要</th>
                  <th className="px-3 py-2.5 font-medium">信源 / 语言</th>
                  <th className="px-3 py-2.5 font-medium">状态</th>
                  <th className="px-3 py-2.5 font-medium">正文提取</th>
                  <th className="px-3 py-2.5 font-medium">发布 / 抓取时间</th>
                  <th className="px-3 py-2.5 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {articles.map((art) => {
                  const isReserved = art.status === 'reserved' || art.reservedByRun !== null;
                  const checked = activeSelectedIds.includes(art.id);
                  return (
                    <tr key={art.id} className="align-top hover:bg-slate-50">
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          aria-label={`选择新闻 ${art.title}`}
                          checked={checked}
                          disabled={isReserved}
                          title={
                            isReserved
                              ? `正被任务 ${art.reservedByRun ?? ''} 占用，受保护不可删除`
                              : '勾选用于批量删除'
                          }
                          onChange={() => toggleOne(art.id)}
                          className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      </td>
                      <td className="max-w-md px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => openDetailModal(art.id)}
                          className="text-left font-medium text-slate-900 hover:text-sky-700 hover:underline"
                        >
                          {art.title}
                        </button>
                        {art.excerpt && (
                          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-slate-600">
                            {art.excerpt}
                          </p>
                        )}
                        <a
                          href={art.canonicalUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-block max-w-md truncate font-mono text-[11px] text-sky-700 hover:underline"
                        >
                          {art.canonicalUrl}
                        </a>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">
                        <div>{art.sourceName}</div>
                        <div className="mt-0.5 text-[11px] text-slate-400">
                          {art.lang === 'zh' ? '中文' : '英文'} · {art.sourceId}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${articleStatusBadgeClass(art.status)}`}
                        >
                          {ARTICLE_STATUS_TEXT[art.status]}
                        </span>
                        {art.reservedByRun && (
                          <div className="mt-1">
                            <Link
                              href={`/runs/${encodeURIComponent(art.reservedByRun)}`}
                              className="font-mono text-[11px] text-amber-700 hover:underline"
                            >
                              {art.reservedByRun}
                            </Link>
                          </div>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-slate-700">
                        <div>{EXTRACT_STATUS_TEXT[art.extractStatus]}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {art.contentChars !== null ? `${art.contentChars} 字` : '-'}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-[11px] text-slate-600">
                        <div>发布：{formatTimestamp(art.publishedAt, timezone)}</div>
                        <div className="mt-0.5 text-slate-500">
                          入库：{formatTimestamp(art.firstSeenAt, timezone)}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openDetailModal(art.id)}
                            className="font-medium text-sky-700 hover:underline"
                          >
                            查看正文
                          </button>
                          {art.status === 'consumed' && (
                            <button
                              type="button"
                              disabled={isPending}
                              onClick={() => handleMarkUnplayed([art.id])}
                              className="font-medium text-amber-700 hover:underline disabled:opacity-50"
                            >
                              标为未播
                            </button>
                          )}
                          {!isReserved && (
                            <button
                              type="button"
                              disabled={isPending}
                              onClick={() => openSelectedDeleteModal([art.id])}
                              className="font-medium text-rose-600 hover:underline disabled:opacity-50"
                            >
                              删除
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs">
            <span className="text-slate-500">
              当前第 {page} 页，每页 {pageSize} 条
            </span>
            <div className="flex items-center gap-2">
              {page > 1 ? (
                <Link
                  href={buildArticlesUrl({
                    sourceId,
                    status,
                    extractStatus,
                    lang,
                    query: query.trim(),
                    timeField,
                    from,
                    to,
                    page: page - 1,
                  })}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                >
                  上一页
                </Link>
              ) : (
                <span className="rounded-lg border border-slate-200 px-3 py-1.5 text-slate-400">
                  上一页
                </span>
              )}
              {page < totalPages ? (
                <Link
                  href={buildArticlesUrl({
                    sourceId,
                    status,
                    extractStatus,
                    lang,
                    query: query.trim(),
                    timeField,
                    from,
                    to,
                    page: page + 1,
                  })}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50"
                >
                  下一页
                </Link>
              ) : (
                <span className="rounded-lg border border-slate-200 px-3 py-1.5 text-slate-400">
                  下一页
                </span>
              )}
            </div>
          </div>
        )}
      </section>

      {(detailLoading || detailError || activeDetail) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-slate-900">
                  {activeDetail?.article.title ?? '新闻正文详情'}
                </h3>
                {activeDetail && (
                  <p className="mt-1 text-xs text-slate-500">
                    {activeDetail.article.sourceName} ·{' '}
                    {ARTICLE_STATUS_TEXT[activeDetail.article.status]} ·{' '}
                    {EXTRACT_STATUS_TEXT[activeDetail.article.extractStatus]} · 发布：
                    {formatTimestamp(activeDetail.article.publishedAt, timezone)} · 入库：
                    {formatTimestamp(activeDetail.article.firstSeenAt, timezone)}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setActiveDetail(null);
                  setDetailError(null);
                  setDetailLoading(false);
                }}
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-100"
              >
                关闭
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-5 text-xs">
              {detailLoading && <p className="text-slate-500">正在加载文章缓存正文…</p>}
              {detailError && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                  {detailError}
                </div>
              )}
              {activeDetail && (
                <>
                  <div className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-3 py-2">
                    <span className="font-mono text-slate-600">ID: {activeDetail.article.id}</span>
                    <a
                      href={activeDetail.article.canonicalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-sky-700 hover:underline"
                    >
                      打开原文链接 ↗
                    </a>
                  </div>

                  {activeDetail.article.excerpt && (
                    <div>
                      <h4 className="font-semibold text-slate-700">摘要预览</h4>
                      <p className="mt-1 rounded-lg border border-slate-200 bg-slate-50 p-3 leading-relaxed text-slate-700">
                        {activeDetail.article.excerpt}
                      </p>
                    </div>
                  )}

                  <div>
                    <h4 className="font-semibold text-slate-700">
                      抓取正文内容（
                      {activeDetail.article.contentChars !== null
                        ? `${activeDetail.article.contentChars} 字`
                        : '未记录字数'}
                      ）
                    </h4>
                    {activeDetail.contentFileExists && activeDetail.contentText ? (
                      <div className="mt-1 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 leading-6 text-slate-800">
                        {activeDetail.contentText}
                      </div>
                    ) : (
                      <p className="mt-1 rounded-lg border border-dashed border-slate-200 p-4 text-slate-500">
                        {activeDetail.contentFileExists
                          ? '该文章正文为空。'
                          : '本地磁盘中暂无该文章的正文缓存文件（可能尚未提取成功或已被清理）。'}
                      </p>
                    )}
                  </div>

                  {activeDetail.mediaAssets.length > 0 && (
                    <div>
                      <h4 className="font-semibold text-slate-700">
                        已提取配图素材（{activeDetail.mediaAssets.length} 项）
                      </h4>
                      <ul className="mt-1.5 space-y-1.5">
                        {activeDetail.mediaAssets.map((asset) => (
                          <li
                            key={asset.id}
                            className="rounded-lg border border-slate-200 bg-white px-3 py-2"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium text-slate-800">
                                {MEDIA_KIND_TEXT[asset.kind] ?? asset.kind}（评分 {asset.score}）
                              </span>
                              <span className="font-mono text-[11px] text-slate-500">
                                {asset.imagePath}
                                {asset.width && asset.height
                                  ? ` · ${asset.width}x${asset.height}`
                                  : ''}
                              </span>
                            </div>
                            {asset.captionHint && (
                              <p className="mt-0.5 text-slate-600">{asset.captionHint}</p>
                            )}
                            {asset.sourceUrl && (
                              <a
                                href={asset.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-0.5 inline-block max-w-full truncate text-[11px] text-sky-700 hover:underline"
                              >
                                {asset.sourceUrl}
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>

            {activeDetail && (
              <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3">
                <span className="text-xs text-slate-500">
                  {activeDetail.article.status === 'reserved' ||
                  activeDetail.article.reservedByRun !== null
                    ? `正被任务 ${activeDetail.article.reservedByRun ?? ''} 占用，不可删除`
                    : '删除会同时移除该文章对应的本地正文与配图缓存'}
                </span>
                <div className="flex items-center gap-2">
                  {activeDetail.article.status === 'consumed' && (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => handleMarkUnplayed([activeDetail.article.id])}
                      className="rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                    >
                      标记为未播
                    </button>
                  )}
                  {activeDetail.article.status !== 'reserved' &&
                    activeDetail.article.reservedByRun === null && (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => openSelectedDeleteModal([activeDetail.article.id])}
                        className="rounded-lg bg-rose-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                      >
                        删除此文章
                      </button>
                    )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {selectedDeleteIds && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h4 className="text-base font-semibold text-slate-900">
              确认删除选中的 {selectedDeleteIds.length} 篇爬取新闻？
            </h4>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              将从文章库移除记录并清理不再被其他文章引用的本地正文与配图缓存；正被任务占用的文章会自动跳过。
            </p>

            {selectedPreview && (
              <div className="mt-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <div>匹配篇数：{selectedPreview.matchedCount} 篇</div>
                <div>
                  实际可删除：<strong>{selectedPreview.deletableCount} 篇</strong>
                  {selectedPreview.skippedReservedCount > 0
                    ? `（受保护跳过 ${selectedPreview.skippedReservedCount} 篇）`
                    : ''}
                </div>
                <div>
                  将清理本地文件：{selectedPreview.deletedFileCount} 个（预计释放{' '}
                  <strong>{formatBytes(selectedPreview.reclaimedBytes)}</strong>）
                </div>
              </div>
            )}

            {!selectedPreview && !selectedPreviewError && (
              <p className="mt-3 text-xs text-slate-500">正在统计待清理文件大小…</p>
            )}

            {selectedPreviewError && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {selectedPreviewError}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  setSelectedDeleteIds(null);
                  setSelectedPreview(null);
                }}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={isPending || !selectedPreview || selectedPreview.deletableCount === 0}
                onClick={handleConfirmSelectedDelete}
                className="rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {isPending ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {batchModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
            <h4 className="text-base font-semibold text-slate-900">按时间筛选批量删除爬取新闻</h4>
            <p className="mt-1 text-xs text-slate-600">
              先选择时间条件并点击「预览待删范围」核对影响篇数与回收空间，再确认执行删除；正被任务占用的文章会被自动保护跳过。
            </p>

            <div className="mt-4 space-y-3 text-xs">
              <div>
                <span className="block font-medium text-slate-700">快捷时间范围</span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(
                    [
                      ['24h', '24 小时前之前'],
                      ['3d', '3 天前之前'],
                      ['7d', '7 天前之前'],
                      ['30d', '30 天前之前'],
                      ['custom', '自定义起止时间'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => applyBatchPreset(key)}
                      className={`rounded-full border px-2.5 py-1 transition ${
                        batchPreset === key
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label htmlFor="batch-art-tf" className="block font-medium text-slate-700">
                  时间筛选口径
                </label>
                <select
                  id="batch-art-tf"
                  value={batchTimeField}
                  onChange={(e) => {
                    setBatchTimeField(e.target.value as ArticleTimeField);
                    setBatchPreview(null);
                  }}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-slate-900"
                >
                  <option value="effective">优先发布时间（无则按入库时间）</option>
                  <option value="first_seen">仅按抓取入库时间</option>
                </select>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="batch-art-from" className="block font-medium text-slate-700">
                    起始时间（含，留空不限）
                  </label>
                  <input
                    id="batch-art-from"
                    type="datetime-local"
                    value={batchFrom}
                    onChange={(e) => {
                      setBatchPreset('custom');
                      setBatchFrom(e.target.value);
                      setBatchPreview(null);
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-slate-900"
                  />
                </div>
                <div>
                  <label htmlFor="batch-art-to" className="block font-medium text-slate-700">
                    截止时间（含，留空不限）
                  </label>
                  <input
                    id="batch-art-to"
                    type="datetime-local"
                    value={batchTo}
                    onChange={(e) => {
                      setBatchPreset('custom');
                      setBatchTo(e.target.value);
                      setBatchPreview(null);
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-slate-900"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="batch-art-src" className="block font-medium text-slate-700">
                    限定信源
                  </label>
                  <select
                    id="batch-art-src"
                    value={batchSourceId}
                    onChange={(e) => {
                      setBatchSourceId(e.target.value);
                      setBatchPreview(null);
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-slate-900"
                  >
                    <option value="">全部信源</option>
                    {sources.map((src) => (
                      <option key={src.id} value={src.id}>
                        {src.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="batch-art-status" className="block font-medium text-slate-700">
                    限定状态
                  </label>
                  <select
                    id="batch-art-status"
                    value={batchStatus}
                    onChange={(e) => {
                      setBatchStatus(e.target.value);
                      setBatchPreview(null);
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-slate-900"
                  >
                    <option value="">全部状态</option>
                    {ARTICLE_STATUS_ORDER.filter((s) => s !== 'reserved').map((st) => (
                      <option key={st} value={st}>
                        {ARTICLE_STATUS_TEXT[st]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="batch-art-extract" className="block font-medium text-slate-700">
                    限定提取状态
                  </label>
                  <select
                    id="batch-art-extract"
                    value={batchExtractStatus}
                    onChange={(e) => {
                      setBatchExtractStatus(e.target.value);
                      setBatchPreview(null);
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-slate-900"
                  >
                    <option value="">全部</option>
                    {EXTRACT_STATUS_ORDER.map((es) => (
                      <option key={es} value={es}>
                        {EXTRACT_STATUS_TEXT[es]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {batchPreview && (
                <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 text-slate-800">
                  <div>命中总计：{batchPreview.matchedCount} 篇</div>
                  <div>
                    实际可删除：<strong>{batchPreview.deletableCount} 篇</strong>
                    {batchPreview.skippedReservedCount > 0
                      ? `（其中 ${batchPreview.skippedReservedCount} 篇正被任务占用将保留）`
                      : ''}
                  </div>
                  <div>
                    待清理本地文件：{batchPreview.deletedFileCount} 个（预计释放{' '}
                    <strong>{formatBytes(batchPreview.reclaimedBytes)}</strong>）
                  </div>
                </div>
              )}

              {batchError && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">
                  {batchError}
                </div>
              )}
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setBatchModalOpen(false)}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={handlePreviewBatch}
                className="rounded-lg border border-slate-900 bg-white px-3.5 py-2 text-xs font-medium text-slate-900 hover:bg-slate-100 disabled:opacity-50"
              >
                {isPending ? '计算中…' : '预览待删范围'}
              </button>
              <button
                type="button"
                disabled={isPending || !batchPreview || batchPreview.deletableCount === 0}
                onClick={handleExecuteBatch}
                className="rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {isPending ? '删除中…' : '确认批量删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
