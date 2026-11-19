# @aidaily/template-daily-deck

`AI 每日报` 独立前端视频合成模板（位于 `templates/daily-deck/`），面向 **1920×1080 (16:9)** 横屏播报场景设计。

## 设计原则

- **大标题 + 逐张出现的信息卡片 + 配图从右向左动态放大**：画面顶部居中突出核心结论大标题，主体是最多 **4 张**圆角卡片（左上角语义图标徽章、深色粗体小标题、10～28 字事实短语，关键数字自动强调色加粗且不折行）；信息显示板底色延展覆盖至画面最底缘，底部在板内预留干净区域供口播字幕悬浮展示。翻页时只显示第 1 张，其余卡片**对齐口播字幕句首逐张淡入**，最晚在口播进行到 70% 时出齐；主播正在讲的那张卡徽章变实心、边框高亮。无配图时 1～3 张单行、4 张 2×2；有配图时每条新闻固定只展示 **1 张**官方图注引用（左侧单列或 2×2 + 右侧图框），且卡片出齐并留出阅读停顿后，**配图框自动从右向左平滑展开铺满整块信息板正文区**（停留约 4～6 秒，切页前从左向右收回右侧），提升手机端图表可读性；暂停浏览时支持点击配图手动放大/收起。严禁堆砌主持人长篇口播稿、滚动字幕或气泡台词。
- **30 个预置卡片图标**：统一登记在 `src/icons/cardIconSet.ts`（发布、融资、上市、裁员、诉讼、开源、评测等事实类型）；数据没给图标或给了不认识的名字时，按卡片标题、再按正文关键词自动匹配，旧版 `grid` / `clipboard-check` 自动换算为 `cloud` / `trophy`。
- **顶部双层响应式章节进度条**：上层展示刊头、日期、期号、当值主播徽章与总计时器；下层展示 `[导览] + [01..0N 极简总结] + [速览]` 分段式连续进度轨道，字号随章节数量与胶囊可用空间自动放大撑满，随语音推进并支持点击跳页。
- **右下角 280×290 贴底破框 Live2D 看板娘舞台（大腿中部及以上构图）**：接入 `DeepSeek娘`、`GPT娘`、`Claude娘`、`Gemini娘` 离线 Cubism WebGL 模型，支持语音包络实时口型同步、呼吸眨眼物理微动与阵营微表情切换，高个角色仅展示大腿中部及以上以最大化信息显示板面积；当模型未配置或在无 WebGL 环境下自动回退到透明 PNG 立绘。
- **双模时钟驱动**：浏览器预览态通过原生音频驱动章节进度与自动翻页；无头成片合成态通过 `window.__NEWS_DECK__.seekTo(globalTimeMs)` 虚拟时钟逐帧确定性渲染。
- **五层零报错硬限制**：所有字段均经过零抛错清洗、安全 URL 过滤、码点级防截断、自适应缩字、坏图无感切回与局部 ErrorBoundary 隔离。

## 常用命令

```bash
npm install
npm run dev            # 启动本地预览台 (http://localhost:5173)
npm run validate:data  # 校验 public/data/latest.json 字段长度与上限
npm run test           # 运行防错、清洗、章节进度条与虚拟时钟单元测试
npm run build          # 严格 TypeScript 编译与生产打包
```

## 输入数据契约（对齐 `业务流程说明.md` 与 `项目架构说明.md`）

| 字段 | 类型 | 长度上限 | 用途说明 |
| :--- | :--- | :--- | :--- |
| `issueTitle` | string | 14 字 | 页眉刊名（默认 `AI 每日报`） |
| `issueNumber` | string | 20 字 | 期号标识（如 `NO. 042`） |
| `date` | string | 20 字 | 发布日期（如 `2026.11.16`） |
| `headline` | string | 48 字 | 封面焦点导语（缺省自动取首条短标题） |
| `footerCta` | string | 56 字 | 片尾动态引导语 |
| `hostMascotId` | enum | - | 默认角色（`deepseek`/`gpt`/`claude`/`gemini`/`grok`/`none`） |
| `hostDisplayName` | string | 16 字 | 顶部刊头主播徽章名称（如 `DeepSeek娘`） |
| `hostMascotUrl` | string \| null | - | 固定主播的自定义静态兜底立绘 |
| `hostLive2dUrl` | string \| null | - | 固定主播的 Live2D `.model3.json` 入口链接 |
| `mascotMode` | enum | - | `per-item`（按条目切换）或 `fixed-host`（全程固定） |
| `bgmAudioUrl` / `bgmVolumeDb` | string / number | - | 预览态可选循环背景音乐链接与分贝增益 |
| `pageTurnSfxUrl` / `pageTurnSfxVolumeDb` | string \| null / number | - | 预览态切换页面鼠标点击音效（不传用模板自带 `/sfx/page-click.wav`，传 `null` 关闭；默认 -9 dB）。成片中的音效由核心混音统一加入 |
| `pagePaddingSec` | number | 0~10s | 每页口播结束后的自然留白停顿秒数（默认 `0.6s`） |
| `coverDurationSec` / `coverSpeechStartSec` / `coverSpeechSec` | number | 1~120s | 封面总停留时长、开场口播起播延迟与人声时长 |
| `coverAudioUrl` / `coverLipSync` | string / number[] | - | 封面口播音频链接与 30fps 归一化口型序列 |
| `coverSubtitles` | `{text,startSec,endSec}[]` | - | 封面口播底部同步字幕列表 |
| `outroDurationSec` / `outroSpeechStartSec` / `outroSpeechSec` | number | 1~120s | 尾页总停留时长、口播起播延迟与人声时长 |
| `outroAudioUrl` / `outroLipSync` | string / number[] | - | 尾页口播音频链接与 30fps 归一化口型序列 |
| `outroSubtitles` | `{text,startSec,endSec}[]` | - | 尾页口播底部同步字幕列表 |
| `items[].shortTitle` | string | 30 字 | 封面/尾页目录短标题（留空自动截断主标题） |
| `items[].progressLabel` | string | 12 字 | 顶部章节进度条极简总结（建议 6~10 字，留空自动截取短标题） |
| `items[].title` | string | 48 字 | 单条新闻主标题 |
| `items[].cards` | `{icon?,title,body}[]` | 上屏 4 张 × (8/28 字建议) | 结构化事实信息卡片（数据最多接受 8 张，画面只展示前 4 张；留空自动从摘要与要点拆解补全；`icon` 取值见 `src/icons/cardIconSet.ts`） |
| `items[].summary` | string | 100 字 | 简短新闻梗概（尾页速览与兼容兜底用） |
| `items[].keyPoints` | string[] | 3条×32字 | 简明事实要点 |
| `items[].imageUrl` | string \| null | - | 唯一官方报告图表/公告截图（每条新闻最多 1 张，失效自动切全幅面板） |
| `items[].secondaryImageUrl` | string \| null | - | 兼容旧数据的废弃可选字段（每条新闻仅显示 1 张图，模板固定忽略） |
| `items[].imageCaption` | string | 44 字 | 图注引用说明 |
| `items[].officialQuote` | string | 120 字 | 兼容旧数据的官方原文摘录 |
| `items[].metrics` | `{label,value}[]` | 4组 | 兼容旧数据的官方参数规格行 |
| `items[].source` / `sourceUrl` | string | 24 / 42 | 原始信源名称与域名归属 |
| `items[].mascotMood` | enum | - | 阵营微表情（`neutral`/`proud`/`surprised`/`thinking`） |
| `items[].durationSec` / `speechStartSec` / `speechDurationSec` | number | 1~180s | 对应章节总停留时长、切页后起播延迟（如等待 `1s` 再播报）与实际人声播报秒数 |
| `items[].audioUrl` / `lipSyncFrames` | string / number[] | - | 单条新闻口播音频链接与 30fps 口型序列 |
| `items[].subtitles` | `{text,startSec,endSec}[]` | - | 单条新闻口播底部同步字幕列表 |

## 自动化合成参数与桥接接口

- `?clean=1`：隐藏底部控制栏，输出纯净 16:9 画面
- `?clock=manual`：进入确定性虚拟时钟模式，禁用自由动画与浏览器发声，完全由 `seekTo(ms)` 推进
- `?autoplay=1` / `?page=0` / `?theme=light|dark` / `?transition=fade|glide|flip|none`（默认 `fade` 平滑渐变，600ms 纯透明度交叉渐变） / `?motion=static` / `?reveal=all`（卡片一开始全部显示，不逐张出现）
- `T` 快捷键：切换「平滑渐变」「纸张滑移」「轻柔翻页」「无动效」；`M` 快捷键：切换有声预览静音（同时静音翻页音效）
- 卡片逐张出现只在「预览台自动播放中」或「`clock=manual` 逐帧渲染」时生效；暂停浏览时直接显示全部卡片，方便检查
- `window.__NEWS_DECK__.setNewsData(json)` / `waitUntilReady()` / `warmupPhysics(atMs, steps)` / `seekTo(globalTimeMs)` / `goToPage(i)` / `getHealthReport()`
