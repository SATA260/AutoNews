import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalizeUrl,
  collectSources,
  computeArticleId,
  createCore,
  createRun,
  downloadArticleImage,
  extractArticleContent,
  type Notifier,
  type NotifyEvent,
  normalizeTitle,
  type PipelineError,
  parseFeedXml,
  readStoredArticleContent,
  updateSourcesFile,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 创建独立的采集测试工作区并写入信源配置 */
async function setupWorkspaceWithSources(
  sources: Array<{
    id: string;
    name: string;
    lang: 'zh' | 'en';
    tier: 1 | 2 | 3;
    kind: 'rss';
    pool: 'primary' | 'backup';
    url: string;
    enabled: boolean;
  }>,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-collect-'));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'config', 'settings.yaml'),
    path.join(dir, 'config', 'settings.yaml'),
  );
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
});
