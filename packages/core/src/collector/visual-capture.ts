import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArticleMediaAsset, Settings, SourceDef } from '@aidaily/contracts';
import { writeFileAtomic } from '../storage/files.js';
import type { CollectorBrowserDriver, RawXTweet } from './browser-driver.js';
import type { ExtractedArticleContent } from './extractor.js';
import { downloadArticleImage } from './images.js';
import { fetchPublicTweetSyndication } from './x-collector.js';

/** 单篇文章视觉素材抓取与局部截图落盘的结果汇总 */
export interface CaptureArticleMediaResult {
  mediaAssets: ArticleMediaAsset[];
  primaryImagePath: string | null;
  writtenFiles: string[];
}

/** 将截图生成的 PNG 字节流原子写入本地图片缓存目录，并返回相对仓库根目录路径 */
async function savePngAssetFile(opts: {
  articleId: string;
  fileSuffix: string;
  png: Buffer;
  imagesDir: string;
  rootDir: string;
}): Promise<{ relPath: string; absPath: string }> {
  const safeSuffix = opts.fileSuffix.replace(/[^a-zA-Z0-9_-]/g, '');
  const destFile = path.join(opts.imagesDir, `${opts.articleId}-${safeSuffix}.png`);
  await writeFileAtomic(destFile, opts.png);
  return {
    relPath: path.relative(opts.rootDir, destFile),
    absPath: destFile,
  };
}

/**
 * 协调单篇文章或推文的全部一手视觉素材收集与落盘：
 * 包含 X 推文原帖截图、推文原图、网页原生评测/价格表格截图以及正文高分图表原图。
 * 若中途收到外部取消信号，自动清理本次已写入的临时图像文件。
 */
export async function captureArticleVisualMedia(opts: {
  articleId: string;
  articleUrl?: string;
  source: SourceDef;
  extracted: ExtractedArticleContent;
  tweetData?: RawXTweet;
  imagesDir: string;
  rootDir: string;
  settings: Settings;
  fetchImpl: typeof fetch;
  driver: CollectorBrowserDriver;
  signal?: AbortSignal;
}): Promise<CaptureArticleMediaResult> {
  const {
    articleId,
    articleUrl,
    source,
    extracted,
    tweetData,
    imagesDir,
    rootDir,
    settings,
    fetchImpl,
    driver,
    signal,
  } = opts;

  const collectorCfg = settings.collector;
  const mediaAssets: ArticleMediaAsset[] = [];
  const writtenFiles: string[] = [];

  try {
    if (source.kind === 'x-timeline' && tweetData) {
      if (collectorCfg.captureTweetScreenshots) {
        if (signal?.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }
        const shot = await driver.renderTweetCardPng(
          {
            tweetId: tweetData.tweetId,
            url: tweetData.url,
            handle: tweetData.handle,
            authorName: tweetData.authorName,
            avatarUrl: tweetData.avatarUrl,
            text: tweetData.text,
            publishedAt: tweetData.publishedAt,
            quotedTweet: tweetData.quotedTweet,
            preferEmbed: false,
          },
          { signal },
        );
        if (shot) {
          const saved = await savePngAssetFile({
            articleId,
            fileSuffix: 'tw0',
            png: shot.png,
            imagesDir,
            rootDir,
          });
          writtenFiles.push(saved.absPath);
          mediaAssets.push({
            id: `${articleId}-tw0`,
            articleId,
            kind: 'tweet_shot',
            imagePath: saved.relPath,
            sourceUrl: tweetData.url,
            captionHint: `@${tweetData.handle} 原帖发言截图`,
            contextSnippet: tweetData.text.slice(0, 180),
            score: 92,
            width: shot.width,
            height: shot.height,
          });
        }
      }

      const tweetImages = tweetData.mediaUrls.slice(0, collectorCfg.maxImagesPerArticle);
      for (let i = 0; i < tweetImages.length; i++) {
        if (signal?.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }
        const mediaUrl = tweetImages[i];
        if (!mediaUrl) {
          continue;
        }
        const relPath = await downloadArticleImage({
          articleId,
          imageUrl: mediaUrl,
          imagesDir,
          rootDir,
          fetchImpl,
          fileSuffix: `tm${i + 1}`,
          signal,
        });
        if (relPath) {
          writtenFiles.push(path.join(rootDir, relPath));
          mediaAssets.push({
            id: `${articleId}-tm${i + 1}`,
            articleId,
            kind: 'tweet_media',
            imagePath: relPath,
            sourceUrl: mediaUrl,
            captionHint: `@${tweetData.handle} 推文原图`,
            contextSnippet: tweetData.text.slice(0, 180),
            score: Math.max(85, 95 - i),
          });
        }
      }
    } else {
      // 1. 提取文章正文中引用的 X 推文链接并生成发言卡片截图
      if (collectorCfg.captureTweetScreenshots && extracted.embeddedTweets.length > 0) {
        for (let i = 0; i < extracted.embeddedTweets.length; i++) {
          if (signal?.aborted) {
            throw new DOMException('已取消', 'AbortError');
          }
          const ref = extracted.embeddedTweets[i];
          if (!ref) {
            continue;
          }
          const publicTweet = await fetchPublicTweetSyndication(ref.tweetId, fetchImpl, signal);
          if (!publicTweet) {
            continue;
          }
          const shot = await driver.renderTweetCardPng(
            {
              tweetId: publicTweet.tweetId,
              url: publicTweet.url,
              handle: publicTweet.handle,
              authorName: publicTweet.authorName,
              avatarUrl: publicTweet.avatarUrl,
              text: publicTweet.text,
              publishedAt: publicTweet.publishedAt,
              quotedTweet: publicTweet.quotedTweet,
            },
            { signal },
          );
          if (shot) {
            const saved = await savePngAssetFile({
              articleId,
              fileSuffix: `tw${i + 1}`,
              png: shot.png,
              imagesDir,
              rootDir,
            });
            writtenFiles.push(saved.absPath);
            mediaAssets.push({
              id: `${articleId}-tw${i + 1}`,
              articleId,
              kind: 'tweet_shot',
              imagePath: saved.relPath,
              sourceUrl: publicTweet.url,
              captionHint: `@${publicTweet.handle} 发言截图`,
              contextSnippet: publicTweet.text.slice(0, 180),
              score: 92 - i,
              width: shot.width,
              height: shot.height,
            });
          }

          const firstMedia = publicTweet.mediaUrls[0];
          if (firstMedia) {
            const relMedia = await downloadArticleImage({
              articleId,
              imageUrl: firstMedia,
              imagesDir,
              rootDir,
              fetchImpl,
              fileSuffix: `twm${i + 1}`,
              signal,
            });
            if (relMedia) {
              writtenFiles.push(path.join(rootDir, relMedia));
              mediaAssets.push({
                id: `${articleId}-twm${i + 1}`,
                articleId,
                kind: 'tweet_media',
                imagePath: relMedia,
                sourceUrl: firstMedia,
                captionHint: `@${publicTweet.handle} 推文附带图表`,
                contextSnippet: publicTweet.text.slice(0, 180),
                score: 94 - i,
              });
            }
          }
        }
      }

      // 2. 对正文中识别出的评测跑分表或定价表执行白底高清局部截图
      if (collectorCfg.captureWebTables && extracted.domChartFragments.length > 0) {
        for (let i = 0; i < extracted.domChartFragments.length; i++) {
          if (signal?.aborted) {
            throw new DOMException('已取消', 'AbortError');
          }
          const fragment = extracted.domChartFragments[i];
          if (!fragment) {
            continue;
          }
          const shot = await driver.renderDomFragmentPng(fragment, { signal });
          if (shot) {
            const saved = await savePngAssetFile({
              articleId,
              fileSuffix: `tbl${i + 1}`,
              png: shot.png,
              imagesDir,
              rootDir,
            });
            writtenFiles.push(saved.absPath);
            mediaAssets.push({
              id: `${articleId}-tbl${i + 1}`,
              articleId,
              kind: 'table_shot',
              imagePath: saved.relPath,
              sourceUrl: null,
              captionHint: fragment.titleHint ?? '原文评测或定价对比表',
              contextSnippet: fragment.titleHint ?? '网页原生数据对比表',
              score: 90 - i,
              width: shot.width,
              height: shot.height,
            });
          }
        }
      }

      // 3. 按价值评分顺序下载正文中的高分原图（兼容保留首张图无后缀命名习惯）
      const candidates = extracted.candidateImages.slice(0, collectorCfg.maxImagesPerArticle);
      let downloadedCount = 0;
      for (const candidate of candidates) {
        if (signal?.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }
        const suffix = downloadedCount === 0 ? undefined : `m${downloadedCount + 1}`;
        const relPath = await downloadArticleImage({
          articleId,
          imageUrl: candidate.url,
          imagesDir,
          rootDir,
          fetchImpl,
          fileSuffix: suffix,
          signal,
        });
        if (!relPath) {
          continue;
        }
        downloadedCount += 1;
        writtenFiles.push(path.join(rootDir, relPath));
        mediaAssets.push({
          id: `${articleId}-m${downloadedCount}`,
          articleId,
          kind: candidate.kind,
          imagePath: relPath,
          sourceUrl: candidate.url,
          captionHint: candidate.captionHint,
          contextSnippet: candidate.contextSnippet,
          score: candidate.score,
          ...(candidate.width ? { width: candidate.width } : {}),
          ...(candidate.height ? { height: candidate.height } : {}),
        });
      }

      // 4. 结合白鸦工作流：对 GitHub/更新日志或缺少高信息密度原图的文章自动去弹窗截取 2x 高清片段
      const screenshotScale = collectorCfg.screenshotScale ?? 2;
      if (articleUrl && driver.captureCleanWebRegionPng) {
        const isGithubUrl = /^https?:\/\/(?:www\.)?github\.com\//i.test(articleUrl);
        const isReleaseUrl = /\/releases(?:\/tag)?\//i.test(articleUrl);
        if (isGithubUrl && (collectorCfg.captureGithubCards ?? true)) {
          if (signal?.aborted) {
            throw new DOMException('已取消', 'AbortError');
          }
          const regionKind = isReleaseUrl ? 'changelog_shot' : 'github_card';
          const shot = await driver.captureCleanWebRegionPng(
            { url: articleUrl, kind: regionKind, scale: screenshotScale },
            { signal },
          );
          if (shot) {
            const saved = await savePngAssetFile({
              articleId,
              fileSuffix: isReleaseUrl ? 'rel1' : 'gh1',
              png: shot.png,
              imagesDir,
              rootDir,
            });
            writtenFiles.push(saved.absPath);
            mediaAssets.push({
              id: `${articleId}-${isReleaseUrl ? 'rel1' : 'gh1'}`,
              articleId,
              kind: regionKind,
              imagePath: saved.relPath,
              sourceUrl: articleUrl,
              captionHint: isReleaseUrl ? 'GitHub 官方 Release 更新日志截图' : 'GitHub 开源项目页截图',
              contextSnippet: extracted.excerpt.slice(0, 180),
              score: 93,
              width: shot.width,
              height: shot.height,
            });
          }
        } else if (
          (collectorCfg.captureArticleSections ?? true) &&
          !mediaAssets.some((asset) =>
            ['chart', 'table_shot', 'tweet_shot', 'tweet_media', 'github_card', 'changelog_shot'].includes(
              asset.kind,
            ),
          )
        ) {
          if (signal?.aborted) {
            throw new DOMException('已取消', 'AbortError');
          }
          const shot = await driver.captureCleanWebRegionPng(
            { url: articleUrl, kind: 'article_section', scale: screenshotScale },
            { signal },
          );
          if (shot) {
            const saved = await savePngAssetFile({
              articleId,
              fileSuffix: 'sec1',
              png: shot.png,
              imagesDir,
              rootDir,
            });
            writtenFiles.push(saved.absPath);
            mediaAssets.push({
              id: `${articleId}-sec1`,
              articleId,
              kind: 'article_section',
              imagePath: saved.relPath,
              sourceUrl: articleUrl,
              captionHint: '原文核心内容去弹窗高清截图',
              contextSnippet: extracted.excerpt.slice(0, 180),
              score: 88,
              width: shot.width,
              height: shot.height,
            });
          }
        }
      }
    }

    mediaAssets.sort((a, b) => b.score - a.score);
    const primaryImagePath = mediaAssets[0]?.imagePath ?? null;

    return {
      mediaAssets,
      primaryImagePath,
      writtenFiles,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      await Promise.all(
        writtenFiles.map((filePath) => fs.rm(filePath, { force: true }).catch(() => undefined)),
      );
    }
    throw err;
  }
}
