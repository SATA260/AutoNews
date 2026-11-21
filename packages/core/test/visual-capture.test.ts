import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Settings, SourceDef } from '@aidaily/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEANUP_OVERLAYS_CSS,
  type CollectorBrowserDriver,
  captureArticleVisualMedia,
} from '../src/index.js';

const PNG_1X1_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=',
  'base64',
);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('M2 clean web region visual capture', () => {
  it('defines overlay cleanup CSS and captures changelog_shot / article_section when needed', async () => {
    expect(CLEANUP_OVERLAYS_CSS).toContain('cookie');
    expect(CLEANUP_OVERLAYS_CSS).toContain('aria-modal');

    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aidaily-vis-'));
    tempDirs.push(rootDir);
    const imagesDir = path.join(rootDir, 'storage', 'images');

    const calls: Array<{ url: string; kind: string; scale?: number }> = [];
    const driver: CollectorBrowserDriver = {
      async fetchRenderedHtml() {
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
      async captureCleanWebRegionPng(input) {
        calls.push({ url: input.url, kind: input.kind, scale: input.scale });
        return { png: PNG_1X1_BYTES, width: 1600, height: 900 };
      },
      async close() {},
    };

    const source: SourceDef = {
      id: 'demo-src',
      name: 'Demo Source',
      lang: 'en',
      tier: 1,
      kind: 'rss',
      pool: 'primary',
      url: 'https://example.com/feed.xml',
      enabled: true,
    };

    const settings = {
      collector: {
        xCookieFile: 'storage/secrets/x-cookies.json',
        maxImagesPerArticle: 4,
        captureWebTables: true,
        captureTweetScreenshots: true,
        captureArticleSections: true,
        captureGithubCards: true,
        screenshotScale: 2 as const,
      },
    } as Settings;

    const extracted = {
      text: 'Detailed release notes text for visual capture verification.',
      excerpt: 'Detailed release notes',
      contentChars: 500,
      extractStatus: 'ok' as const,
      ogImageUrl: null,
      detectedPublishedAt: null,
      candidateImages: [],
      domChartFragments: [],
      embeddedTweets: [],
    };

    const ghRes = await captureArticleVisualMedia({
      articleId: 'art-gh',
      articleUrl: 'https://github.com/org/repo/releases/tag/v2.0.0',
      source,
      extracted,
      imagesDir,
      rootDir,
      settings,
      fetchImpl: globalThis.fetch,
      driver,
    });
    expect(ghRes.mediaAssets.some((m) => m.kind === 'changelog_shot')).toBe(true);

    const secRes = await captureArticleVisualMedia({
      articleId: 'art-sec',
      articleUrl: 'https://example.com/blog/update',
      source,
      extracted,
      imagesDir,
      rootDir,
      settings,
      fetchImpl: globalThis.fetch,
      driver,
    });
    expect(secRes.mediaAssets.some((m) => m.kind === 'article_section')).toBe(true);
    expect(calls).toEqual([
      { url: 'https://github.com/org/repo/releases/tag/v2.0.0', kind: 'changelog_shot', scale: 2 },
      { url: 'https://example.com/blog/update', kind: 'article_section', scale: 2 },
    ]);
  });
});
