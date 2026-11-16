import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  collectSources,
  computeArticleId,
  createCore,
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
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Research Blog</title>
  <entry>
    <title>New Inference Engine</title>
    <link rel="self" href="https://lab.example.com/feed.xml" />
    <link rel="alternate" href="https://lab.example.com/posts/engine" />
    <updated>2026-11-16T09:30:00+08:00</updated>
    <summary>Engine summary</summary>
  </entry>
</feed>`;
    const atomItems = parseFeedXml(atomXml);
    expect(atomItems).toHaveLength(1);
    expect(atomItems[0]?.url).toBe('https://lab.example.com/posts/engine');
    expect(atomItems[0]?.publishedAt).toBe('2026-11-16T01:30:00.000Z');

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

  it('runs incremental collection twice with 304, overlap dedup, expiry, and failure alerts', async () => {
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

    const longBody =
      '人工智能新版本发布，支持本地高效推理，并在多家评测基准上大幅降低延迟与资源占用。'.repeat(12);

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();

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

    core.context.repos.runs.create({
      id: 'run-collect-1',
      trigger: 'manual-cli',
      itemCount: 3,
      configSnapshotJson: JSON.stringify(core.context.settings),
      createdAt: currentNow.toISOString(),
    });

    const first = await collectSources(core.context, {
      runId: 'run-collect-1',
      retryDelayMs: 5,
    });
    expect(backupFetched).toBe(false);
    expect(first.sourcesOk.sort()).toEqual(['flaky-rss', 'primary-rss']);
    expect(first.sourcesFailed).toEqual([]);
    expect(first.newArticleIds).toHaveLength(2);
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

    expect(core.context.repos.articles.getById(postOldId)?.status).toBe('expired');
    expect(core.context.repos.articles.getById(shortId)?.extractStatus).toBe('failed');

    // 第二轮采集：feed-a 返回 304 保留 ETag 且不新增文章；feed-b 开始连续失败
    phase = 2;
    currentNow = new Date('2026-11-16T11:00:00.000Z');
    const second = await collectSources(core.context, {
      runId: 'run-collect-1',
      retryDelayMs: 5,
    });
    expect(feedARequestHeaders?.get('if-none-match')).toBe('"etag-p1"');
    expect(second.sourcesOk).toEqual(['primary-rss']);
    expect(second.newArticleIds).toEqual([]);
    expect(core.context.repos.sourceState.get('primary-rss')?.etag).toBe('"etag-p1"');

    // 第三、四轮采集：HTTP 200 下验证 2 小时重叠窗口对已有链接去重、仅入库新文章，并让 flaky-rss 达到连续 3 次失败告警阈值
    phase = 3;
    const third = await collectSources(core.context, { runId: 'run-collect-1', retryDelayMs: 5 });
    expect(third.newArticleIds).toEqual([computeArticleId('https://feed-a.example.com/post-2')]);
    const fourth = await collectSources(core.context, { runId: 'run-collect-1', retryDelayMs: 5 });
    expect(fourth.newArticleIds).toEqual([]);

    const healthList = await core.sources.list();
    const flakyHealth = healthList.find((h) => h.source.id === 'flaky-rss');
    expect(flakyHealth?.healthy).toBe(false);
    expect(flakyHealth?.state?.consecutiveFailures).toBe(3);
    expect(notifications.some((n) => n.type === 'source_unhealthy')).toBe(true);

    const testPrimary = await core.sources.test('primary-rss');
    expect(testPrimary.ok).toBe(true);
    expect(testPrimary.itemCount).toBe(2);
    expect(testPrimary.sampleTitles[0]).toBe('主力新文章一');

    const testMissing = await core.sources.test('nonexistent');
    expect(testMissing.ok).toBe(false);

    await core.close();
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
});
