import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceDef } from '@aidaily/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeFetchTarget,
  BlockedSsrfError,
  fetchWithSsrfGuard,
} from '../src/collector/ssrf.js';
import {
  type CollectorBrowserDriver,
  canonicalizeUrl,
  collectSources,
  computeArticleId,
  createCore,
  createRun,
  downloadArticleImage,
  extractArticleContent,
  extractTweetsFromGraphQlPayload,
  fetchArticleHtml,
  fetchXSourceItems,
  isXTimelineGraphQlUrl,
  looksLikeTruncatedTweetText,
  type Notifier,
  type NotifyEvent,
  normalizeTitle,
  type PipelineError,
  parseFeedXml,
  parseHtmlListPage,
  parsePublishedAt,
  parseXCookiesFromText,
  readStoredArticleContent,
  updateSettingsFile,
  updateSourcesFile,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 创建独立的采集测试工作区并写入信源配置 */
async function setupWorkspaceWithSources(sources: SourceDef[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-collect-'));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(dir, 'config', 'settings.yaml'),
  );
  await updateSettingsFile(path.join(dir, 'config', 'settings.yaml'), {
    clis: {
      biliup: { adapter: 'generic', bin: 'fixture-disabled-biliup', extraArgs: [] },
    },
    collector: {
      captureGithubCards: false,
      captureArticleSections: false,
    },
    publish: {
      mode: 'manual-review',
      bilibili: { cookieFile: path.join(dir, 'test-bili-cookies.json') },
    },
  });
  await updateSourcesFile(path.join(dir, 'config', 'sources.yaml'), sources);
  return dir;
}

const PNG_1X1_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=',
  'base64',
);

/** 为正文与配图抓取测试构造页面 */
function buildHtmlPage(opts: {
  title: string;
  bodyParagraphs: string[];
  ogImage?: string;
}): string {
  const metaImg = opts.ogImage ? `<meta property="og:image" content="${opts.ogImage}" />` : '';
  const paragraphs = opts.bodyParagraphs.map((p) => `<p>${p}</p>`).join('\n');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${opts.title}</title>
  ${metaImg}
</head>
<body>
  <article>
    <h1>${opts.title}</h1>
    ${paragraphs}
  </article>
</body>
</html>`;
}

describe('collector module and SourceService', () => {
  it('canonicalizes URLs, hashes article IDs, and normalizes titles consistently', () => {
    const u1 = canonicalizeUrl(
      'HTTPS://Example.COM:443/news/launch/?b=2&utm_source=x&fbclid=abc&a=1&ref=rss#comments',
    );
    const u2 = canonicalizeUrl('https://example.com/news/launch?a=1&b=2&utm_medium=social');
    expect(u1).toBe('https://example.com/news/launch?a=1&b=2');
    expect(u2).toBe(u1);
    expect(computeArticleId(u1)).toBe(computeArticleId(u2));
    expect(computeArticleId(u1)).toHaveLength(40);

    expect(canonicalizeUrl('/posts/hello/', 'https://blog.example.org/rss.xml')).toBe(
      'https://blog.example.org/posts/hello',
    );
    expect(normalizeTitle('【重磅】OpenAI 发布 GPT-5！')).toBe('重磅】openai 发布 gpt-5');
  });

  it('parses RSS 2.0 and Atom feeds and rejects HTML error pages', () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>AI News</title>
    <item>
      <title><![CDATA[OpenAI <b>Launches</b> Model]]></title>
      <link>/news/model-1</link>
      <pubDate>Mon, 16 Nov 2026 08:00:00 GMT</pubDate>
      <description>Short summary text.</description>
      <content:encoded><![CDATA[<p>Detailed content paragraph.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;
    const rssItems = parseFeedXml(rssXml, 'https://news.example.com/feed.xml');
    expect(rssItems).toHaveLength(1);
    expect(rssItems[0]?.url).toBe('https://news.example.com/news/model-1');
    expect(rssItems[0]?.title).toBe('OpenAI Launches Model');
    expect(rssItems[0]?.publishedAt).toBe('2026-11-16T08:00:00.000Z');
    expect(rssItems[0]?.content).toContain('Detailed content paragraph.');

    const atomXml = `<?xml version="1.0" encoding="utf-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xml:base="https://lab.example.com/blog/">
  <atom:title>Research Blog</atom:title>
  <atom:entry>
    <atom:title>Tom&#8217;s &amp; &mdash; <b>Inference</b> Engine</atom:title>
    <atom:link rel="alternate" type="application/atom+xml" href="https://lab.example.com/atom.xml" />
    <atom:link rel="alternate" type="text/html" href="posts/engine" />
    <atom:updated>2026-11-16 09:30:00</atom:updated>
    <atom:summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Engine <b>summary</b> text</p></div></atom:summary>
  </atom:entry>
</atom:feed>`;
    const atomItems = parseFeedXml(atomXml, 'https://lab.example.com/feed.xml', 'Asia/Shanghai');
    expect(atomItems).toHaveLength(1);
    expect(atomItems[0]?.title).toBe('Tom’s & — Inference Engine');
    expect(atomItems[0]?.url).toBe('https://lab.example.com/blog/posts/engine');
    expect(atomItems[0]?.publishedAt).toBe('2026-11-16T01:30:00.000Z');
    expect(atomItems[0]?.summary).toContain('Engine');
    expect(atomItems[0]?.summary).toContain('summary');

    expect(
      parseFeedXml('<rss version="2.0"><channel><title>Empty</title></channel></rss>'),
    ).toEqual([]);
    expect(() => parseFeedXml('<html><body>403 Forbidden</body></html>')).toThrow(/RSS 或 Atom/);
  });

  it('applies 400/200 char extraction thresholds and enforces image MIME and 5MB limits', async () => {
    const longParagraph =
      '人工智能力量正在快速普及到日常开发和办公软件场景中，并带来明显效率提升。'.repeat(14);
    const fullHtml = buildHtmlPage({
      title: '完整正文测试',
      bodyParagraphs: [longParagraph],
      ogImage: '/images/hero.png',
    });
    const okExtract = extractArticleContent({
      url: 'https://example.com/article/1',
      html: fullHtml,
      feedContent: null,
      feedSummary: 'brief',
    });
    expect(okExtract.extractStatus).toBe('ok');
    expect(okExtract.contentChars).toBeGreaterThanOrEqual(400);
    expect(okExtract.ogImageUrl).toBe('https://example.com/images/hero.png');

    const shortHtml = buildHtmlPage({
      title: '付费墙摘要',
      bodyParagraphs: ['请订阅以阅读全文。'],
    });
    const mediumFeedContent = `<p><img src="https://cdn.example.com/pic.jpg"/>${'这是订阅源里提供的详细新闻导读段落内容，足够帮助读者理解完整背景。'.repeat(8)}</p>`;
    const feedOnlyExtract = extractArticleContent({
      url: 'https://example.com/article/2',
      html: shortHtml,
      feedContent: mediumFeedContent,
      feedSummary: null,
    });
    expect(feedOnlyExtract.extractStatus).toBe('feed_only');
    expect(feedOnlyExtract.contentChars).toBeGreaterThanOrEqual(200);
    expect(feedOnlyExtract.ogImageUrl).toBe('https://cdn.example.com/pic.jpg');

    const tooShortExtract = extractArticleContent({
      url: 'https://example.com/article/3',
      html: '<html><body><p>太短了。</p></body></html>',
      feedContent: '<p>同样不足两百字。</p>',
      feedSummary: null,
    });
    expect(tooShortExtract.extractStatus).toBe('failed');

    // 验证网页抽取在 200-399 字之间但订阅内容不足 200 字时，仍应按订阅正文字数标为 failed
    const midHtmlShortFeed = extractArticleContent({
      url: 'https://example.com/article/4',
      html: buildHtmlPage({
        title: '半截网页正文',
        bodyParagraphs: [
          '这是网页抽出来的一段两百多字但不到四百字的正文介绍内容，用于测试严格遵循阈值规则。'.repeat(
            6,
          ),
        ],
      }),
      feedContent: '<p>订阅摘要很短。</p>',
      feedSummary: null,
    });
    expect(midHtmlShortFeed.extractStatus).toBe('failed');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-img-'));
    tempDirs.push(tmpDir);
    const imagesDir = path.join(tmpDir, 'storage', 'images');

    const okImgPath = await downloadArticleImage({
      articleId: 'art-ok',
      imageUrl: 'https://cdn.example.com/hero.png',
      imagesDir,
      rootDir: tmpDir,
      fetchImpl: async () =>
        new Response(PNG_1X1_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    });
    expect(okImgPath).toBe(path.join('storage', 'images', 'art-ok.png'));

    const bmpImgPath = await downloadArticleImage({
      articleId: 'art-bmp',
      imageUrl: 'https://cdn.example.com/hero.bmp',
      imagesDir,
      rootDir: tmpDir,
      fetchImpl: async () =>
        new Response(Buffer.from([0x42, 0x4d, 0x10, 0x00]), {
          status: 200,
          headers: { 'content-type': 'image/bmp' },
        }),
    });
    expect(bmpImgPath).toBe(path.join('storage', 'images', 'art-bmp.img'));

    const nonImage = await downloadArticleImage({
      articleId: 'art-html',
      imageUrl: 'https://cdn.example.com/bad',
      imagesDir,
      rootDir: tmpDir,
      fetchImpl: async () =>
        new Response('<html>oops</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    expect(nonImage).toBeNull();

    const oversized = await downloadArticleImage({
      articleId: 'art-big',
      imageUrl: 'https://cdn.example.com/huge.png',
      imagesDir,
      rootDir: tmpDir,
      fetchImpl: async () =>
        new Response(Buffer.alloc(6 * 1024 * 1024, 1), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    });
    expect(oversized).toBeNull();
  });

  it('reports 304 and source failures while preserving overlap dedup, expiry, and failure alerts', async () => {
    const rootDir = await setupWorkspaceWithSources([
      {
        id: 'primary-rss',
        name: '主力中文源',
        lang: 'zh',
        tier: 1,
        kind: 'rss',
        pool: 'primary',
        url: 'https://feed-a.example.com/rss.xml',
        enabled: true,
      },
      {
        id: 'flaky-rss',
        name: '波动英文源',
        lang: 'en',
        tier: 2,
        kind: 'rss',
        pool: 'primary',
        url: 'https://feed-b.example.com/atom.xml',
        enabled: true,
      },
      {
        id: 'backup-rss',
        name: '备用补抓源',
        lang: 'en',
        tier: 2,
        kind: 'rss',
        pool: 'backup',
        url: 'https://backup.example.com/rss.xml',
        enabled: true,
      },
    ]);

    const notifications: NotifyEvent[] = [];
    const notifier: Notifier = {
      id: 'spy',
      async notify(event) {
        notifications.push(event);
      },
    };

    let currentNow = new Date('2026-11-16T10:00:00.000Z');
    let phase = 1;
    let feedARequestHeaders: Headers | undefined;
    let backupFetched = false;
    const requestedUrls: string[] = [];

    const longBody =
      '人工智能新版本发布，支持本地高效推理，并在多家评测基准上大幅降低延迟与资源占用。'.repeat(12);

    /** 模拟信源在不同采集轮次返回文章、缓存命中或错误 */
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      requestedUrls.push(url);

      if (url === 'https://backup.example.com/rss.xml') {
        backupFetched = true;
        return new Response('<rss version="2.0"><channel></channel></rss>', { status: 200 });
      }

      if (url === 'https://feed-a.example.com/rss.xml') {
        feedARequestHeaders = new Headers(init?.headers);
        if (phase === 2) {
          if (feedARequestHeaders.get('if-none-match') === '"etag-p1"') {
            return new Response(null, { status: 304, headers: { etag: '"etag-p1"' } });
          }
        }
        if (phase >= 3) {
          return new Response(
            `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>主力新文章一</title>
      <link>https://feed-a.example.com/post-1?utm_medium=refresh</link>
      <pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate>
      <description>重叠窗口重复条目</description>
    </item>
    <item>
      <title>主力补充新文章二</title>
      <link>https://feed-a.example.com/post-2</link>
      <pubDate>Mon, 16 Nov 2026 09:30:00 GMT</pubDate>
      <description>增量新条目</description>
    </item>
    <item>
      <title>早于重叠窗口的新链接</title>
      <link>https://feed-a.example.com/outside-window</link>
      <pubDate>Mon, 16 Nov 2026 05:00:00 GMT</pubDate>
      <description>不应入库</description>
    </item>
    <item>
      <title>非法协议未来时间条目</title>
      <link>ftp://feed-a.example.com/invalid-proto</link>
      <pubDate>Mon, 16 Nov 2026 23:00:00 GMT</pubDate>
      <description>不能抬高游标</description>
    </item>
  </channel>
</rss>`,
            { status: 200, headers: { etag: '"etag-p3"' } },
          );
        }
        return new Response(
          `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>主力新文章一</title>
      <link>https://feed-a.example.com/post-1?utm_source=rss</link>
      <pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate>
      <description>概要描述</description>
    </item>
    <item>
      <title>超出回溯期旧闻</title>
      <link>https://feed-a.example.com/post-old</link>
      <pubDate>Tue, 10 Nov 2026 01:00:00 GMT</pubDate>
      <description>旧闻概要</description>
    </item>
  </channel>
</rss>`,
          {
            status: 200,
            headers: { etag: '"etag-p1"', 'last-modified': 'Mon, 16 Nov 2026 09:00:00 GMT' },
          },
        );
      }

      if (url === 'https://feed-b.example.com/atom.xml') {
        if (phase >= 2) {
          return new Response('Server Error', { status: 500 });
        }
        return new Response(
          `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Brief Ignored Item</title>
    <link rel="alternate" href="https://feed-b.example.com/short" />
    <updated>2026-11-16T08:30:00Z</updated>
    <summary>Too short.</summary>
  </entry>
</feed>`,
          { status: 200 },
        );
      }

      if (
        url === 'https://feed-a.example.com/post-1' ||
        url === 'https://feed-a.example.com/post-2'
      ) {
        return new Response(
          buildHtmlPage({
            title: url.endsWith('post-2') ? '主力补充新文章二' : '主力新文章一',
            bodyParagraphs: [longBody],
            ogImage: 'https://feed-a.example.com/hero.png',
          }),
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }

      if (url === 'https://feed-a.example.com/post-old') {
        return new Response(
          buildHtmlPage({
            title: '超出回溯期旧闻',
            bodyParagraphs: [longBody],
            ogImage: 'https://feed-a.example.com/old-hero.png',
          }),
          { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
        );
      }

      if (url === 'https://feed-a.example.com/hero.png') {
        return new Response(PNG_1X1_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }

      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } });
    };

    const core = await createCore({
      rootDir,
      notifier,
      fetchImpl: mockFetch,
      now: () => currentNow,
    });

    const runId = createRun(core.context, { trigger: 'manual-cli', itemCount: 3 });
    core.context.repos.articles.insertIfAbsent({
      id: 'previously-collected',
      sourceId: 'primary-rss',
      canonicalUrl: 'https://feed-a.example.com/previously-collected',
      title: '之前采入的旧闻',
      titleNorm: '之前采入的旧闻',
      lang: 'zh',
      publishedAt: '2026-11-10T01:00:00.000Z',
      firstSeenAt: '2026-11-11T01:00:00.000Z',
      excerpt: null,
      contentPath: null,
      contentChars: 0,
      imagePath: null,
      extractStatus: 'failed',
    });

    const first = await collectSources(core.context, {
      runId,
      retryDelayMs: 5,
    });
    expect(backupFetched).toBe(false);
    expect(first.sourcesOk.sort()).toEqual(['flaky-rss', 'primary-rss']);
    expect(first.sourcesFailed).toEqual([]);
    expect(first.newArticleIds).toHaveLength(1);
    expect(first.expiredCount).toBe(1);

    const post1Id = computeArticleId('https://feed-a.example.com/post-1');
    const postOldId = computeArticleId('https://feed-a.example.com/post-old');
    const shortId = computeArticleId('https://feed-b.example.com/short');

    const post1 = core.context.repos.articles.getById(post1Id);
    expect(post1?.extractStatus).toBe('ok');
    expect(post1?.status).toBe('new');
    expect(post1?.imagePath).toBe(path.join('storage', 'images', `${post1Id}.png`));
    const stored = await readStoredArticleContent(rootDir, post1?.contentPath ?? null);
    expect(stored?.text.length).toBeGreaterThanOrEqual(400);

    expect(core.context.repos.articles.getById(postOldId)).toBeNull();
    expect(requestedUrls).not.toContain('https://feed-a.example.com/post-old');
    expect(requestedUrls).not.toContain('https://feed-a.example.com/old-hero.png');
    expect(core.context.repos.articles.getById('previously-collected')?.status).toBe('expired');
    expect(core.context.repos.articles.getById(shortId)?.extractStatus).toBe('failed');

    // 第二轮采集：feed-a 返回 304 保留 ETag 且不新增文章；feed-b 开始连续失败
    phase = 2;
    currentNow = new Date('2026-11-16T11:00:00.000Z');
    const latestEventId = core.context.repos.runEvents.listAfter(runId, 0, 20).at(-1)?.id ?? 0;
    const second = await collectSources(core.context, {
      runId,
      retryDelayMs: 5,
    });
    expect(feedARequestHeaders?.get('if-none-match')).toBe('"etag-p1"');
    expect(second.sourcesOk).toEqual(['primary-rss']);
    expect(second.newArticleIds).toEqual([]);
    expect(core.context.repos.sourceState.get('primary-rss')?.etag).toBe('"etag-p1"');
    const secondEvents = core.context.repos.runEvents.listAfter(runId, latestEventId, 20);
    expect(secondEvents.map((event) => event.type)).toEqual([
      'source_collected',
      'source_collect_failed',
    ]);
    expect(secondEvents[0]).toMatchObject({
      stage: 'collect',
      level: 'info',
      message: '主力信源「主力中文源」抓取完成（1/2），新增 0 篇可用文章',
      data: { sourceId: 'primary-rss', completedSources: 1, totalSources: 2, newArticleCount: 0 },
    });
    expect(secondEvents[1]).toMatchObject({
      stage: 'collect',
      level: 'warn',
      message: expect.stringMatching(/^主力信源「波动英文源」抓取失败（2\/2），原因：.+/),
      data: {
        sourceId: 'flaky-rss',
        completedSources: 2,
        totalSources: 2,
        error: expect.any(String),
      },
    });

    // 第三、四轮采集：验证 2 小时重叠窗口跳过更早新链接、非法链接不抬高游标、仅入库新文章，并触发连续 3 次失败告警
    phase = 3;
    const third = await collectSources(core.context, { runId, retryDelayMs: 5 });
    expect(third.newArticleIds).toEqual([computeArticleId('https://feed-a.example.com/post-2')]);
    expect(
      core.context.repos.articles.getById(
        computeArticleId('https://feed-a.example.com/outside-window'),
      ),
    ).toBeNull();
    expect(core.context.repos.sourceState.get('primary-rss')?.lastItemPublishedAt).toBe(
      '2026-11-16T09:30:00.000Z',
    );
    const fourth = await collectSources(core.context, { runId, retryDelayMs: 5 });
    expect(fourth.newArticleIds).toEqual([]);

    const healthList = await core.sources.list();
    const flakyHealth = healthList.find((h) => h.source.id === 'flaky-rss');
    expect(flakyHealth?.healthy).toBe(false);
    expect(flakyHealth?.state?.consecutiveFailures).toBe(3);
    expect(notifications.some((n) => n.type === 'source_unhealthy')).toBe(true);
    expect(core.context.repos.runEvents.listAfter(runId, 0, 20)).toContainEqual(
      expect.objectContaining({ type: 'source_unhealthy', level: 'warn' }),
    );

    const testPrimary = await core.sources.test('primary-rss');
    expect(testPrimary.ok).toBe(true);
    expect(testPrimary.itemCount).toBe(3);
    expect(testPrimary.sampleTitles[0]).toBe('主力新文章一');

    const testMissing = await core.sources.test('nonexistent');
    expect(testMissing.ok).toBe(false);

    await core.close();
  });

  it.each([
    { pool: 'primary', cursor: null },
    { pool: 'primary', cursor: '2026-11-15T21:45:00.000Z' },
    { pool: 'backup', cursor: null },
  ] as const)(
    'caps $pool collection with cursor $cursor at the configured boundary',
    async ({ pool, cursor }) => {
      const sourceId = 'boundary-rss';
      const sourceUrl = 'https://boundary.example.com/rss.xml';
      const rootDir = await setupWorkspaceWithSources([
        {
          id: sourceId,
          name: '时间边界信源',
          lang: 'zh',
          tier: 1,
          kind: 'rss',
          pool,
          url: sourceUrl,
          enabled: true,
        },
      ]);
      const now = new Date('2026-11-16T10:00:00.000Z');
      const boundaryUrl = 'https://boundary.example.com/boundary';
      const oldUrl = 'https://boundary.example.com/too-old';
      const boundaryImage = 'https://boundary.example.com/boundary.png';
      const oldImage = 'https://boundary.example.com/too-old.png';
      const longBody =
        '人工智能新版本发布，支持本地高效推理，并在多家评测基准上大幅降低延迟与资源占用。'.repeat(
          12,
        );
      const requestedUrls: string[] = [];

      const core = await createCore({
        rootDir,
        now: () => now,
        fetchImpl: async (input) => {
          const url = input.toString();
          requestedUrls.push(url);
          if (url === sourceUrl) {
            return new Response(`<rss version="2.0"><channel>
            <item><title>正好位于截止时间</title><link>${boundaryUrl}</link>
              <pubDate>Sun, 15 Nov 2026 22:00:00 GMT</pubDate></item>
            <item><title>早于截止时间一秒</title><link>${oldUrl}</link>
              <pubDate>Sun, 15 Nov 2026 21:59:59 GMT</pubDate></item>
          </channel></rss>`);
          }
          if (url === boundaryUrl || url === oldUrl) {
            return new Response(
              buildHtmlPage({
                title: '新闻正文',
                bodyParagraphs: [longBody],
                ogImage: url === boundaryUrl ? boundaryImage : oldImage,
              }),
            );
          }
          return new Response(PNG_1X1_BYTES, { headers: { 'content-type': 'image/png' } });
        },
      });

      try {
        const { settings, repos } = core.context;
        if (cursor) {
          repos.sourceState.upsertSuccess({
            sourceId,
            lastFetchedAt: cursor,
            lastItemPublishedAt: cursor,
            etag: null,
            lastModified: null,
          });
        }
        const result = await collectSources(core.context, {
          pool,
          settings: {
            ...settings,
            issue: {
              ...settings.issue,
              refill: { ...settings.issue.refill, maxLookbackHours: 12 },
            },
          },
        });

        expect(requestedUrls).toEqual([sourceUrl, boundaryUrl, boundaryImage]);
        expect(result.newArticleIds).toEqual([computeArticleId(boundaryUrl)]);
        expect(repos.articles.getById(computeArticleId(oldUrl))).toBeNull();
        expect(repos.sourceState.get(sourceId)?.lastItemPublishedAt).toBe(
          '2026-11-15T22:00:00.000Z',
        );
      } finally {
        await core.close();
      }
    },
  );

  it('records fast-source progress while another source is still fetching', async () => {
    const fastUrl = 'https://fast.example.com/rss.xml';
    const slowUrl = 'https://slow.example.com/rss.xml';
    const rootDir = await setupWorkspaceWithSources([
      {
        id: 'fast-rss',
        name: '快速信源',
        lang: 'zh',
        tier: 1,
        kind: 'rss',
        pool: 'primary',
        url: fastUrl,
        enabled: true,
      },
      {
        id: 'slow-rss',
        name: '慢速信源',
        lang: 'zh',
        tier: 1,
        kind: 'rss',
        pool: 'primary',
        url: slowUrl,
        enabled: true,
      },
    ]);
    let releaseSlowFeed: (() => void) | undefined;
    const slowFeed = new Promise<void>((resolve) => {
      releaseSlowFeed = resolve;
    });
    const rss = '<rss version="2.0"><channel></channel></rss>';
    const core = await createCore({
      rootDir,
      fetchImpl: async (input) => {
        if (input.toString() === slowUrl) {
          await slowFeed;
        }
        return new Response(rss);
      },
    });
    const runId = createRun(core.context, { trigger: 'manual-cli', itemCount: 1 });
    const collection = collectSources(core.context, { runId });
    try {
      await vi.waitFor(() => {
        expect(core.context.repos.runEvents.listAfter(runId, 0, 10)).toContainEqual(
          expect.objectContaining({
            type: 'source_collected',
            data: expect.objectContaining({
              sourceId: 'fast-rss',
              completedSources: 1,
              totalSources: 2,
            }),
          }),
        );
      });
      expect(core.context.repos.sourceState.get('slow-rss')).toBeNull();
      releaseSlowFeed?.();
      await expect(collection).resolves.toMatchObject({ sourcesOk: ['fast-rss', 'slow-rss'] });
      expect(core.context.repos.runEvents.listAfter(runId, 0, 10).at(-1)).toMatchObject({
        type: 'source_collected',
        data: { sourceId: 'slow-rss', completedSources: 2, totalSources: 2 },
      });
    } finally {
      releaseSlowFeed?.();
      await collection.catch(() => undefined);
      await core.close();
    }
  });

  it('throws collect_all_failed when every enabled source in pool fails', async () => {
    const rootDir = await setupWorkspaceWithSources([
      {
        id: 'broken-rss',
        name: '故障信源',
        lang: 'en',
        tier: 1,
        kind: 'rss',
        pool: 'primary',
        url: 'https://broken.example.com/rss.xml',
        enabled: true,
      },
    ]);

    const core = await createCore({
      rootDir,
      fetchImpl: async () => new Response('Unavailable', { status: 503 }),
    });

    await expect(collectSources(core.context, { retryDelayMs: 5 })).rejects.toMatchObject({
      name: 'PipelineError',
      code: 'collect_all_failed',
    } satisfies Partial<PipelineError>);

    await core.close();
  });

  it('aborts cleanly mid-collection without writing partial articles or advancing cursor', async () => {
    const rootDir = await setupWorkspaceWithSources([
      {
        id: 'slow-rss',
        name: '慢速信源',
        lang: 'zh',
        tier: 1,
        kind: 'rss',
        pool: 'primary',
        url: 'https://slow.example.com/rss.xml',
        enabled: true,
      },
    ]);

    const ac = new AbortController();
    const longBody =
      '这是非常详尽的正文段落，包含完整的背景信息、关键数字与具体发布节奏说明。'.repeat(12);

    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-16T10:00:00.000Z'),
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://slow.example.com/rss.xml') {
          return new Response(
            `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><item>
  <title>中断文章测试</title>
  <link>https://slow.example.com/post-abort</link>
  <pubDate>Mon, 16 Nov 2026 09:00:00 GMT</pubDate>
</item></channel></rss>`,
            { status: 200 },
          );
        }
        // 在抓正文时触发任务取消信号
        ac.abort();
        return new Response(buildHtmlPage({ title: '中断文章测试', bodyParagraphs: [longBody] }), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    });

    const runId = createRun(core.context, { trigger: 'manual-cli', itemCount: 1 });
    await expect(collectSources(core.context, { runId, signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const articleId = computeArticleId('https://slow.example.com/post-abort');
    expect(core.context.repos.articles.getById(articleId)).toBeNull();
    expect(core.context.repos.sourceState.get('slow-rss')).toBeNull();
    expect(core.context.repos.runEvents.listAfter(runId, 0, 10).map((event) => event.type)).toEqual(
      ['run_created'],
    );

    await core.close();
  });

  it('collects html-list pages with DOM dates, prefers body benchmark charts over og:image, and captures table & embedded tweet screenshots', async () => {
    const rootDir = await setupWorkspaceWithSources([
      {
        id: 'lab-newsroom',
        name: '实验室官网新闻页',
        lang: 'en',
        tier: 1,
        kind: 'html-list',
        pool: 'primary',
        url: 'https://lab.example.com/news',
        listConfig: {
          linkSelector: 'a.news-card',
          urlPattern: '^https://lab\\.example\\.com/news/',
          renderJs: false,
        },
        enabled: true,
      },
    ]);

    const bodyPara =
      'Our flagship reasoning model scores 84.5% on SWE-bench Verified and cuts API cost to $0.40 per million tokens across enterprise workloads. '.repeat(
        6,
      );
    const articleHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Flagship Model Benchmark Release</title>
  <meta property="og:image" content="https://lab.example.com/static/brand-og-cover.png" />
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"NewsArticle","datePublished":"2026-11-16T07:30:00Z"}
  </script>
</head>
<body>
  <article>
    <h1>Flagship Model Benchmark Release</h1>
    <p>${bodyPara}</p>
    <figure>
      <img src="https://lab.example.com/charts/swe-bench-comparison.png" alt="SWE-bench benchmark comparison chart" width="1200" height="720" />
      <figcaption>SWE-bench Verified benchmark comparison vs peer models</figcaption>
    </figure>
    <table>
      <caption>API Pricing and Benchmark Comparison</caption>
      <thead><tr><th>Model</th><th>SWE-bench</th><th>Input Cost</th></tr></thead>
      <tbody>
        <tr><td>Flagship-2</td><td>84.5%</td><td>$0.40/M</td></tr>
        <tr><td>Baseline-1</td><td>71.2%</td><td>$1.20/M</td></tr>
      </tbody>
    </table>
    <p>Engineering lead discussion: <a href="https://x.com/thsottiaux/status/1990000000000000001">X post</a></p>
  </article>
</body>
</html>`;

    const undatedHtml = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Undated Evergreen Note</title></head>
<body><article><h1>Evergreen Note</h1><p>${bodyPara}</p></article></body>
</html>`;

    let tableRenderCount = 0;
    let tweetRenderCount = 0;
    const mockDriver: CollectorBrowserDriver = {
      async fetchRenderedHtml() {
        return '';
      },
      async fetchXTimeline() {
        return [];
      },
      async renderDomFragmentPng() {
        tableRenderCount += 1;
        return { png: PNG_1X1_BYTES, width: 1200, height: 640 };
      },
      async renderTweetCardPng() {
        tweetRenderCount += 1;
        return { png: PNG_1X1_BYTES, width: 1080, height: 680 };
      },
      async close() {},
    };

    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-16T10:00:00.000Z'),
      createCollectorDriver: () => mockDriver,
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url === 'https://lab.example.com/news') {
          return new Response(
            `<html><body>
              <a class="news-card" href="/news/flagship-benchmark">Flagship Model Benchmark Release</a>
              <a class="news-card" href="/news/undated-note">Undated Evergreen Note</a>
            </body></html>`,
            { status: 200, headers: { 'content-type': 'text/html' } },
          );
        }
        if (url === 'https://lab.example.com/news/flagship-benchmark') {
          return new Response(articleHtml, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        if (url === 'https://lab.example.com/news/undated-note') {
          return new Response(undatedHtml, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        if (url.startsWith('https://cdn.syndication.twimg.com/tweet-result')) {
          return Response.json({
            text: 'We just shipped a major throughput upgrade with 40% lower latency.',
            created_at: 'Mon Nov 16 08:00:00 +0000 2026',
            user: {
              name: 'Tibo',
              screen_name: 'thsottiaux',
              profile_image_url_https: 'https://pbs.twimg.com/profile_images/test/avatar.jpg',
            },
            mediaDetails: [],
          });
        }
        if (url.endsWith('.png')) {
          return new Response(PNG_1X1_BYTES, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    try {
      const ckpt = await collectSources(core.context);
      expect(ckpt.sourcesOk).toEqual(['lab-newsroom']);
      expect(tableRenderCount).toBe(1);
      expect(tweetRenderCount).toBe(1);

      const datedId = computeArticleId('https://lab.example.com/news/flagship-benchmark');
      const undatedId = computeArticleId('https://lab.example.com/news/undated-note');
      const datedRec = core.context.repos.articles.getById(datedId);
      const undatedRec = core.context.repos.articles.getById(undatedId);

      expect(datedRec?.publishedAt).toBe('2026-11-16T07:30:00.000Z');
      // 没有真实发布日期的文章必须保留 null，绝不能伪造抓取时间
      expect(undatedRec?.publishedAt).toBeNull();

      const stored = await readStoredArticleContent(rootDir, datedRec?.contentPath ?? null);
      const assets = stored?.mediaAssets ?? [];
      const kinds = new Set(assets.map((m) => m.kind));
      expect(kinds.has('chart')).toBe(true);
      expect(kinds.has('table_shot')).toBe(true);
      expect(kinds.has('tweet_shot')).toBe(true);
      const chartAsset = assets.find((m) => m.kind === 'chart');
      const coverAsset = assets.find((m) => m.kind === 'cover');
      expect(chartAsset?.imagePath).toBe(path.join('storage', 'images', `${datedId}.png`));
      if (coverAsset) {
        expect(chartAsset?.score ?? 0).toBeGreaterThan(coverAsset.score);
      }
      expect(datedRec?.imagePath).toBe(assets[0]?.imagePath ?? null);
    } finally {
      await core.close();
    }
  });

  it('skips x-timeline gracefully without cookie, and ingests short tweets with screenshots when cookies exist', async () => {
    const netscape = [
      '# Netscape HTTP Cookie File',
      '.x.com\tTRUE\t/\tTRUE\t1900000000\tauth_token\tabc123token',
      '.x.com\tTRUE\t/\tTRUE\t1900000000\tct0\tcsrf456val',
    ].join('\n');
    expect(parseXCookiesFromText(netscape).some((c) => c.name === 'auth_token')).toBe(true);

    const rootDir = await setupWorkspaceWithSources([
      {
        id: 'x-thsottiaux',
        name: 'Tibo (X)',
        lang: 'en',
        tier: 1,
        kind: 'x-timeline',
        pool: 'primary',
        url: 'https://x.com/thsottiaux',
        xConfig: {
          mode: 'user',
          handleOrListId: 'thsottiaux',
          includeReplies: false,
          includeRetweets: false,
          minChars: 20,
        },
        enabled: true,
      },
    ]);

    const mockDriver: CollectorBrowserDriver = {
      async fetchRenderedHtml() {
        return '';
      },
      async fetchXTimeline() {
        return [
          {
            tweetId: '1990000000000000777',
            url: 'https://x.com/thsottiaux/status/1990000000000000777',
            handle: 'thsottiaux',
            authorName: 'Tibo',
            avatarUrl: null,
            text: 'Codex cloud tasks just shipped 2x faster parallel sandboxes for every team.',
            publishedAt: '2026-11-16T08:45:00.000Z',
            isReply: false,
            isRetweet: false,
            mediaUrls: [],
            quotedTweet: null,
          },
        ];
      },
      async renderDomFragmentPng() {
        return null;
      },
      async renderTweetCardPng() {
        return { png: PNG_1X1_BYTES, width: 1080, height: 640 };
      },
      async close() {},
    };

    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-16T10:00:00.000Z'),
      createCollectorDriver: () => mockDriver,
      fetchImpl: async () => new Response('Not found', { status: 404 }),
    });

    try {
      // 1. 无 Cookie 时跳过且不报连续失败
      const noCookieRunId = createRun(core.context, { trigger: 'manual-cli', itemCount: 1 });
      const firstCkpt = await collectSources(core.context, { runId: noCookieRunId });
      expect(firstCkpt.sourcesSkipped).toContain('x-thsottiaux');
      expect(firstCkpt.sourcesFailed).toHaveLength(0);
      expect(core.context.repos.sourceState.get('x-thsottiaux')).toBeNull();

      // 2. 导入 Netscape Cookie 后成功采集短推文并附带原帖截图
      const imported = await core.sources.importXCookies(netscape);
      expect(imported.configured).toBe(true);
      const secondCkpt = await collectSources(core.context);
      expect(secondCkpt.sourcesOk).toEqual(['x-thsottiaux']);
      const tweetArticleId = computeArticleId(
        'https://x.com/thsottiaux/status/1990000000000000777',
      );
      const tweetRec = core.context.repos.articles.getById(tweetArticleId);
      expect(tweetRec?.extractStatus).toBe('ok');
      const stored = await readStoredArticleContent(rootDir, tweetRec?.contentPath ?? null);
      expect((stored?.mediaAssets ?? []).some((m) => m.kind === 'tweet_shot')).toBe(true);
    } finally {
      await core.close();
    }
  });

  it('parses timezone-less English month dates in source timezone, extracts inline dates, and uses UTC for English html-list sources', async () => {
    expect(parsePublishedAt('2026-11-18', 'UTC')).toBe('2026-11-18T00:00:00.000Z');
    expect(parsePublishedAt('2026-3-5', 'Asia/Shanghai')).toBe('2026-03-04T16:00:00.000Z');
    expect(parsePublishedAt('2026-3-5 9:05', 'Asia/Shanghai')).toBe('2026-03-05T01:05:00.000Z');
    expect(parsePublishedAt('3/5/2026 9:05 AM', 'America/New_York')).toBe(
      '2026-03-05T14:05:00.000Z',
    );
    expect(parsePublishedAt('11/16/2026 14:30', 'UTC')).toBe('2026-11-16T14:30:00.000Z');
    expect(parsePublishedAt('2026年3月5日 9:05', 'Asia/Shanghai')).toBe('2026-03-05T01:05:00.000Z');
    expect(parsePublishedAt('Nov 18, 2026', 'UTC')).toBe('2026-11-18T00:00:00.000Z');
    expect(parsePublishedAt('18 November 2026', 'UTC')).toBe('2026-11-18T00:00:00.000Z');
    expect(parsePublishedAt('Nov. 18, 2026 at 2:30 PM', 'UTC')).toBe('2026-11-18T14:30:00.000Z');
    expect(parsePublishedAt('2026/11/13', 'Asia/Shanghai')).toBe('2026-11-12T16:00:00.000Z');
    expect(parsePublishedAt('Wed, 18 Nov 2026 21:35:43 GMT', 'Asia/Shanghai')).toBe(
      '2026-11-18T21:35:43.000Z',
    );

    const parsedInline = parseHtmlListPage(
      `<html><body><a href="/zh-cn/news/news261113">DeepSeek 全家桶应用 API 发布 2026/11/13</a></body></html>`,
      {
        id: 'ds-inline',
        name: 'DeepSeek',
        lang: 'zh',
        tier: 1,
        kind: 'html-list',
        pool: 'primary',
        url: 'https://api-docs.deepseek.com/zh-cn/news/news0802',
        listConfig: {
          urlPattern: '^https://api-docs\\.deepseek\\.com/(?:zh-cn/)?news/news[0-9]+/?$',
          renderJs: false,
        },
        enabled: true,
      },
      'Asia/Shanghai',
    );
    expect(parsedInline).toHaveLength(1);
    expect(parsedInline[0]?.publishedAt).toBe('2026-11-12T16:00:00.000Z');

    const rootDir = await setupWorkspaceWithSources([
      {
        id: 'en-bench',
        name: 'English Bench',
        lang: 'en',
        tier: 1,
        kind: 'html-list',
        pool: 'primary',
        url: 'https://bench.example.com/articles',
        listConfig: {
          urlPattern: '^https://bench\\.example\\.com/articles/[a-z0-9-]+$',
          renderJs: true,
        },
        enabled: true,
      },
    ]);

    const bodyPara =
      'Gemini 4 Neon benchmark comparisons and cost numbers are now live across reasoning tests. '.repeat(
        8,
      );
    let listAttempts = 0;
    const mockDriver: CollectorBrowserDriver = {
      async fetchRenderedHtml(url) {
        if (url === 'https://bench.example.com/articles') {
          listAttempts += 1;
          if (listAttempts === 1) {
            throw new Error('Navigation timeout');
          }
          return `<html><body><a href="/articles/gemini-4-neon">Gemini 4 Neon Analysis</a></body></html>`;
        }
        return `<!doctype html><html><head><script type="application/ld+json">{"datePublished":"Nov 18, 2026"}</script></head><body><article><h1>Gemini 4 Neon Analysis</h1><p>${bodyPara}</p></article></body></html>`;
      },
      async fetchXTimeline() {
        return [];
      },
      async renderDomFragmentPng() {
        return null;
      },
      async renderTweetCardPng() {
        return null;
      },
      async close() {},
    };

    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-19T02:00:00.000Z'),
      createCollectorDriver: () => mockDriver,
      fetchImpl: async (input) => {
        // 模拟需要浏览器渲染的英文来源详情页在裸请求时返回 403 被拒，自动走渲染回退
        expect(input.toString()).toContain('gemini-4-neon');
        return new Response('Forbidden', { status: 403 });
      },
    });

    try {
      const ckpt = await collectSources(core.context, { retryDelayMs: 5 });
      expect(ckpt.sourcesOk).toEqual(['en-bench']);
      expect(listAttempts).toBe(2);
      const art = core.context.repos.articles.getById(
        computeArticleId('https://bench.example.com/articles/gemini-4-neon'),
      );
      expect(art?.extractStatus).toBe('ok');
      expect(art?.publishedAt).toBe('2026-11-18T00:00:00.000Z');
    } finally {
      await core.close();
    }
  });

  it('retries transient detail HTML failures and upgrades failed articles on subsequent runs', async () => {
    // 1. 验证 fetchArticleHtml 遇到 502 后自动重试恢复，遇到 404 不做无效重试
    let htmlCalls = 0;
    let notFoundCalls = 0;
    const recovered = await fetchArticleHtml(
      'https://example.com/transient',
      async () => {
        htmlCalls += 1;
        if (htmlCalls < 3) {
          return new Response('Bad Gateway', { status: 502 });
        }
        return new Response('<html><body><p>Recovered HTML</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
      { retries: 2, retryDelayMs: 5 },
    );
    expect(recovered).toContain('Recovered HTML');
    expect(htmlCalls).toBe(3);

    const missing = await fetchArticleHtml(
      'https://example.com/missing',
      async () => {
        notFoundCalls += 1;
        return new Response('Not Found', { status: 404 });
      },
      { retries: 2, retryDelayMs: 5 },
    );
    expect(missing).toBeNull();
    expect(notFoundCalls).toBe(1);

    // 2. 验证某篇文章初抓详情失败记为 failed 后，即使同源更新文章抬高了游标并带回 ETag，下一轮仍绕过 304 原地补全自愈
    const rootDir = await setupWorkspaceWithSources([
      {
        id: 'lab-rss',
        name: 'Lab RSS',
        lang: 'en',
        tier: 1,
        kind: 'rss',
        pool: 'primary',
        url: 'https://lab.example.com/rss.xml',
        enabled: true,
      },
    ]);

    const neonUrl = 'https://lab.example.com/gemini-4-neon';
    const newerUrl = 'https://lab.example.com/newer-post';
    const longBody =
      'Gemini 4 Neon delivers stronger reasoning with faster throughput and detailed developer benchmarks. '.repeat(
        8,
      );
    let round = 1;
    let conditionalHeaderSeen: string | null = null;

    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-19T02:00:00.000Z'),
      fetchImpl: async (input, init) => {
        const url = input.toString();
        if (url === 'https://lab.example.com/rss.xml') {
          conditionalHeaderSeen = new Headers(init?.headers).get('if-none-match');
          if (conditionalHeaderSeen) {
            return new Response(null, { status: 304, headers: { etag: '"etag-v1"' } });
          }
          return new Response(
            `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Newer Lab Note</title>
    <link>${newerUrl}</link>
    <pubDate>Wed, 18 Nov 2026 23:00:00 GMT</pubDate>
    <description>Brief note.</description>
  </item>
  <item>
    <title>Introducing Gemini 4 Neon</title>
    <link>${neonUrl}</link>
    <pubDate>Wed, 18 Nov 2026 20:00:00 GMT</pubDate>
    <description>Short RSS summary under 200 chars.</description>
  </item>
</channel></rss>`,
            { status: 200, headers: { etag: '"etag-v1"' } },
          );
        }
        if (url === newerUrl) {
          return new Response(
            buildHtmlPage({ title: 'Newer Lab Note', bodyParagraphs: [longBody] }),
            {
              status: 200,
              headers: { 'content-type': 'text/html' },
            },
          );
        }
        if (url === neonUrl) {
          if (round === 1) {
            throw new Error('ECONNRESET');
          }
          return new Response(
            buildHtmlPage({ title: 'Introducing Gemini 4 Neon', bodyParagraphs: [longBody] }),
            { status: 200, headers: { 'content-type': 'text/html' } },
          );
        }
        return new Response('Not found', { status: 404 });
      },
    });

    try {
      const neonId = computeArticleId(neonUrl);
      const newerId = computeArticleId(newerUrl);

      const firstCkpt = await collectSources(core.context, { retryDelayMs: 1 });
      expect(firstCkpt.newArticleIds).toEqual([newerId]);
      expect(core.context.repos.articles.getById(neonId)?.extractStatus).toBe('failed');
      // 因存在临时抓取失败文章，第一轮不缓存 etag，以便下轮自愈重试
      expect(core.context.repos.sourceState.get('lab-rss')?.etag).toBeNull();

      round = 2;
      const secondCkpt = await collectSources(core.context, { retryDelayMs: 1 });
      expect(conditionalHeaderSeen).toBeNull();
      expect(secondCkpt.newArticleIds).toEqual([neonId]);
      const healed = core.context.repos.articles.getById(neonId);
      expect(healed?.extractStatus).toBe('ok');
      expect(healed?.contentChars).toBeGreaterThanOrEqual(400);
      expect(core.context.repos.sourceState.get('lab-rss')?.etag).toBe('"etag-v1"');

      // 全部恢复后第三轮恢复增量 304 跳过
      round = 3;
      const thirdCkpt = await collectSources(core.context, { retryDelayMs: 1 });
      expect(conditionalHeaderSeen).toBe('"etag-v1"');
      expect(thirdCkpt.newArticleIds).toEqual([]);
    } finally {
      await core.close();
    }
  });

  it('单篇条目意外异常时等待同源其余并发任务收敛后才关闭浏览器驱动', async () => {
    const listUrl = 'https://example.com/js-list';
    const item1Url = 'https://example.com/posts/fail-item';
    const item2Url = 'https://example.com/posts/slow-item';

    const rootDir = await setupWorkspaceWithSources([
      {
        id: 'js-src',
        name: 'JS 渲染测试源',
        enabled: true,
        kind: 'html-list',
        pool: 'primary',
        tier: 2,
        url: listUrl,
        lang: 'en',
        listConfig: {
          itemSelector: 'a.post',
          renderJs: true,
        },
      },
    ]);

    let siblingAborted = false;
    let siblingSettledBeforeClose = false;
    let driverClosed = false;

    const longBody =
      'Artificial intelligence systems continue advancing across multimodal reasoning benchmarks. '.repeat(
        8,
      );
    const fakeDriver: CollectorBrowserDriver = {
      async fetchRenderedHtml(targetUrl, opts) {
        if (targetUrl === listUrl) {
          return `<html><body><a class="post" href="${item1Url}">Item 1</a><a class="post" href="${item2Url}">Item 2</a></body></html>`;
        }
        if (targetUrl === item1Url) {
          return `<html><head><title>Item 1</title></head><body><article><p>${longBody}</p></article></body></html>`;
        }
        if (targetUrl === item2Url) {
          await new Promise<void>((resolve) => {
            if (opts?.signal?.aborted) {
              siblingAborted = true;
              siblingSettledBeforeClose = !driverClosed;
              resolve();
              return;
            }
            opts?.signal?.addEventListener(
              'abort',
              () => {
                siblingAborted = true;
                setTimeout(() => {
                  siblingSettledBeforeClose = !driverClosed;
                  resolve();
                }, 20);
              },
              { once: true },
            );
          });
        }
        return '';
      },
      async fetchXTimeline() {
        return [];
      },
      async renderTweetCardPng() {
        return null;
      },
      async renderDomFragmentPng() {
        return null;
      },
      async close() {
        driverClosed = true;
      },
    };

    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-16T12:00:00.000Z'),
      createCollectorDriver: () => fakeDriver,
      fetchImpl: async () => new Response('Forbidden', { status: 403 }),
    });
    const originalInsert = core.context.repos.articles.insertIfAbsent.bind(
      core.context.repos.articles,
    );
    core.context.repos.articles.insertIfAbsent = (article) => {
      if (article.canonicalUrl === item1Url) {
        throw new Error('simulated item storage crash');
      }
      return originalInsert(article);
    };

    try {
      await expect(collectSources(core.context, { retryDelayMs: 1 })).rejects.toThrow(
        /simulated item storage crash/,
      );
      expect(driverClosed).toBe(true);
      expect(siblingAborted).toBe(true);
      expect(siblingSettledBeforeClose).toBe(true);
    } finally {
      await core.close();
    }
  });

  it('拦截内网、回环及云元数据图片与跨源文章地址和 302 内网重定向', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-ssrf-'));
    tempDirs.push(tmpDir);
    const imagesDir = path.join(tmpDir, 'storage', 'images');

    const imgRequests: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      imgRequests.push(url);
      if (url === 'https://cdn.example.com/redir-to-local.png') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:3000/secret.png' },
        });
      }
      if (url === 'https://example.com/redir-to-imds') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        });
      }
      return new Response('should not happen', { status: 200 });
    };

    for (const blockedImg of [
      'http://127.0.0.1:8080/internal.png',
      'http://localhost/internal.png',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/internal.png',
      'http://192.168.1.10/a.png',
      'http://[::ffff:127.0.0.1]/a.png',
      'https://cdn.example.com/redir-to-local.png',
    ]) {
      const res = await downloadArticleImage({
        articleId: 'art-ssrf',
        imageUrl: blockedImg,
        imagesDir,
        rootDir: tmpDir,
        fetchImpl: mockFetch,
      });
      expect(res).toBeNull();
    }
    expect(imgRequests).toEqual(['https://cdn.example.com/redir-to-local.png']);

    const extracted = extractArticleContent({
      url: 'https://news.example.com/post-1',
      html: '<html><head><meta property="og:image" content="http://127.0.0.1:3000/og.png"></head><body><article><img src="http://169.254.169.254/hero.png"><img src="https://cdn.example.com/real.png"><p>Body text enough to inspect images.</p></article></body></html>',
      feedContent: null,
      feedSummary: null,
    });
    expect(extracted.ogImageUrl).toBeNull();
    expect(extracted.candidateImages.map((img) => img.url)).toEqual([
      'https://cdn.example.com/real.png',
    ]);

    expect(
      await fetchArticleHtml('http://127.0.0.1:3000/admin', mockFetch, { retries: 1 }),
    ).toBeNull();
    expect(
      await fetchArticleHtml('https://example.com/redir-to-imds', mockFetch, { retries: 1 }),
    ).toBeNull();
  });

  it('允许公网域名经代理虚拟 DNS 解析到 198.18.0.0/15，但继续拦截直接访问与真实内网解析', async () => {
    const allowedFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === 'https://openai.com/redir-to-bench') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://198.18.0.5/internal.xml' },
        });
      }
      return new Response('<rss />', { status: 200 });
    };

    const res = await fetchWithSsrfGuard('https://openai.com/news/rss.xml', {
      fetchImpl: allowedFetch,
      lookupImpl: async () => [{ address: '198.18.0.5' }],
    });
    expect(res.status).toBe(200);

    await expect(
      fetchWithSsrfGuard('http://198.18.0.5/feed.xml', { fetchImpl: allowedFetch }),
    ).rejects.toBeInstanceOf(BlockedSsrfError);

    await expect(
      fetchWithSsrfGuard('https://openai.com/redir-to-bench', {
        fetchImpl: allowedFetch,
        lookupImpl: async () => [{ address: '198.18.0.5' }],
      }),
    ).rejects.toBeInstanceOf(BlockedSsrfError);

    for (const blockedIp of ['127.0.0.1', '192.168.1.10', '169.254.169.254']) {
      await expect(
        assertSafeFetchTarget(new URL('https://openai.com/news/rss.xml'), {
          lookupImpl: async () => [{ address: blockedIp }],
        }),
      ).rejects.toBeInstanceOf(BlockedSsrfError);
    }
  });

  it('永久 404 或非网页文章不阻塞后续订阅源的条件缓存 304 跳过', async () => {
    const missingUrl = 'https://perm.example.com/gone';
    const goodUrl = 'https://perm.example.com/good';
    const feedXml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Perm</title><item><title>Good</title><link>${goodUrl}</link><pubDate>Mon, 16 Nov 2026 11:00:00 GMT</pubDate></item><item><title>Gone</title><link>${missingUrl}</link><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const longBody = 'Open weights research release detailed architecture report. '.repeat(10);

    const rootDir = await setupWorkspaceWithSources([
      {
        id: 'perm-rss',
        name: 'Perm RSS',
        enabled: true,
        kind: 'rss',
        pool: 'primary',
        tier: 2,
        url: 'https://perm.example.com/feed.xml',
        lang: 'en',
      },
    ]);

    let sawIfNoneMatch: string | null = null;
    const core = await createCore({
      rootDir,
      now: () => new Date('2026-11-16T12:00:00.000Z'),
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url === 'https://perm.example.com/feed.xml') {
          const hdrs = new Headers(init?.headers);
          sawIfNoneMatch = hdrs.get('if-none-match');
          if (sawIfNoneMatch === '"etag-perm"') {
            return new Response(null, { status: 304, headers: { etag: '"etag-perm"' } });
          }
          return new Response(feedXml, {
            status: 200,
            headers: { 'content-type': 'application/rss+xml', etag: '"etag-perm"' },
          });
        }
        if (url === goodUrl) {
          return new Response(
            `<html><head><title>Good</title></head><body><article><p>${longBody}</p></article></body></html>`,
            { status: 200, headers: { 'content-type': 'text/html' } },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
    });

    try {
      const r1 = await collectSources(core.context, { retryDelayMs: 1 });
      expect(r1.newArticleIds).toEqual([computeArticleId(goodUrl)]);
      expect(core.context.repos.articles.getById(computeArticleId(missingUrl))?.extractStatus).toBe(
        'failed',
      );
      expect(core.context.repos.sourceState.get('perm-rss')?.etag).toBe('"etag-perm"');

      // 第二轮仍应发送 If-None-Match 并命中 304，不会被 404 永久失败条目标记阻断
      const r2 = await collectSources(core.context, { retryDelayMs: 1 });
      expect(sawIfNoneMatch).toBe('"etag-perm"');
      expect(r2.newArticleIds).toEqual([]);
    } finally {
      await core.close();
    }
  });

  it('matches updated X GraphQL endpoints, extracts full note_tweet with expanded URLs, and skips truncated tweets', async () => {
    expect(
      isXTimelineGraphQlUrl(
        'https://x.com/i/api/graphql/ZFKu1DFS63hgrkLzR3Hsdw/UserOriginalsTimeline?variables=%7B%7D',
      ),
    ).toBe(true);
    expect(
      isXTimelineGraphQlUrl('https://x.com/i/api/graphql/abc123/UserTweets?variables=%7B%7D'),
    ).toBe(true);
    expect(
      isXTimelineGraphQlUrl(
        'https://x.com/i/api/graphql/abc123/ListLatestTweetsTimeline?variables=%7B%7D',
      ),
    ).toBe(true);
    expect(
      isXTimelineGraphQlUrl('https://x.com/i/api/graphql/abc123/TweetDetail?variables=%7B%7D'),
    ).toBe(true);
    expect(
      isXTimelineGraphQlUrl(
        'https://x.com/i/api/graphql/I7FbT7Bfw_If9nT5q6PUQQ/ViewerBadgeCounts?variables=%7B%7D',
      ),
    ).toBe(false);
    expect(
      isXTimelineGraphQlUrl(
        'https://x.com/i/api/graphql/cM7LCaFTQnUWRA1jMWH6Pg/ExploreSidebar?variables=%7B%7D',
      ),
    ).toBe(false);

    const longBody =
      'Out of your element with the new Gemini 4 releases? Read the full table at https://t.co/xyz123 ' +
      'Carbon ($4/$20 per 1M input/output tokens), Neon ($3/$15), and Hydrogen ($1.50/$7.50) are benchmarked across coding, agentic workflows, and long-context retrieval with detailed latency measurements across providers.';
    const payload = {
      data: {
        items: [
          {
            rest_id: '2123513872095269336',
            core: {
              user_results: {
                result: {
                  legacy: {
                    screen_name: 'ArtificialAnlys',
                    name: 'Artificial Analysis',
                  },
                },
              },
            },
            note_tweet: {
              is_expandable: true,
              note_tweet_results: {
                result: {
                  text: longBody,
                  entity_set: {
                    urls: [
                      {
                        url: 'https://t.co/xyz123',
                        expanded_url: 'https://artificialanalysis.ai/models/gemini-4',
                      },
                    ],
                  },
                },
              },
            },
            legacy: {
              user_id_str: '174348786',
              created_at: 'Thu Nov 19 20:28:54 +0000 2026',
              full_text: 'Out of your element with the new Gemini 4 releases? https://t.co/trunc',
              entities: { urls: [] },
            },
          },
          {
            rest_id: '2123513872095269999',
            core: {
              user_results: {
                result: {
                  legacy: {
                    screen_name: 'ArtificialAnlys',
                    name: 'Artificial Analysis',
                  },
                },
              },
            },
            note_tweet: {
              is_expandable: true,
            },
            legacy: {
              user_id_str: '174348786',
              created_at: 'Thu Nov 19 20:20:00 +0000 2026',
              full_text:
                'Out of your element with the new Gemini 4 releases? Here are some key highlights on Gemini 4 Carbon, Neon and Hydrogen\n\nCarbon is the highest-priced model ($4/$20 per 1M input/output tokens), followed by Neon ($3/$15) and Hydrogen ($1.50/$7.50). At low effort, Carbon performs the',
              entities: { urls: [] },
            },
          },
        ],
      },
    };

    const parsed = extractTweetsFromGraphQlPayload(payload);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.isTruncated).toBe(false);
    expect(parsed[0]?.text).toContain('https://artificialanalysis.ai/models/gemini-4');
    expect(parsed[0]?.text).not.toContain('https://t.co/xyz123');
    expect(parsed[0]?.text.length).toBeGreaterThan(280);
    expect(parsed[1]?.isTruncated).toBe(true);

    expect(
      looksLikeTruncatedTweetText(
        'Out of your element with the new Gemini 4 releases? Here are some key highlights on Gemini 4 Carbon, Neon and Hydrogen\n\nCarbon is the highest-priced model ($4/$20 per 1M input/output tokens), followed by Neon ($3/$15) and Hydrogen ($1.50/$7.50). At low effort, Carbon performs the',
      ),
    ).toBe(true);
    expect(
      looksLikeTruncatedTweetText(
        'Reset everyone’s Gemini quota on Antigravity. The caching improvements have increased the amount you can get done per unit of quota by > 20%!',
      ),
    ).toBe(false);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-x-trunc-'));
    tempDirs.push(tmpDir);
    const cookiePath = path.join(tmpDir, 'x-cookies.json');
    await fs.writeFile(
      cookiePath,
      JSON.stringify({ auth_token: 'tok-test', ct0: 'ct0-test' }),
      'utf8',
    );
    const items = await fetchXSourceItems(
      {
        id: 'x-aa',
        name: 'AA',
        lang: 'en',
        tier: 2,
        kind: 'x-timeline',
        pool: 'primary',
        url: 'https://x.com/ArtificialAnlys',
        xConfig: {
          mode: 'user',
          handleOrListId: 'ArtificialAnlys',
          includeReplies: false,
          includeRetweets: false,
          minChars: 20,
        },
        enabled: true,
      },
      {
        cookieFileAbs: cookiePath,
        driver: {
          async fetchRenderedHtml() {
            return '';
          },
          async fetchXTimeline() {
            return parsed;
          },
          async renderTweetCardPng() {
            return null;
          },
          async renderDomFragmentPng() {
            return null;
          },
          async close() {},
        },
      },
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toContain('2123513872095269336');
  });
});
