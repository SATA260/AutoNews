# @aidaily/template-daily-deck

`AI 每日报` 独立前端视频合成模板（位于 `templates/daily-deck/`），面向 **1920×1080 (16:9)** 横屏播报场景设计。

## 设计原则

- **画布只呈梗概与官方引用**：画面严禁堆砌主持人长篇口播稿或气泡台词。左侧仅展示简练的事实标题、新闻梗概与要点；右侧大片区域专用于展示官方发布截图/技术图表及出处引用（无配图时切换为全幅结论面板）。
- **紧凑右下角 AI 娘角标**：内置来自 `genderswapai.com/zh-CN/ai-gijinka` 抠图透明化后的 `DeepSeek娘`、`GPT娘`、`Claude娘`、`Gemini娘`、`Grok娘` 透明 PNG，置于画布右下角安全留白区（支持按新闻切换或全期固定主讲）。
- **五层零报错硬限制**：所有字段均经过零抛错清洗、安全 URL 过滤、码点级防截断、自适应缩字、坏图无感切回与局部 ErrorBoundary 隔离。

## 常用命令

```bash
npm install
npm run dev            # 启动本地预览台 (http://localhost:5173)
npm run validate:data  # 校验 public/data/latest.json 字段长度与上限
npm run test           # 运行防错、清洗与翻页单元测试
npm run build          # 严格 TypeScript 编译与生产打包
```

## 输入数据契约（对齐 `业务流程说明.md` 与 `项目架构说明.md`）

| 字段 | 类型 | 长度上限 | 用途说明 |
| :--- | :--- | :--- | :--- |
| `issueTitle` | string | 14 字 | 页眉刊名（默认 `AI 每日报`） |
| `issueNumber` | string | 20 字 | 期号标识（如 `NO. 042`） |
| `date` | string | 20 字 | 发布日期（如 `2026.11.16`） |
| `headline` | string | 48 字 | 封面焦点导语（缺省自动取首条短标题） |
| `footerCta` | string | 56 字 | 第 3 段片尾动态引导语 |
| `hostMascotId` | enum | - | 默认角色（`deepseek`/`gpt`/`claude`/`gemini`/`grok`/`none`） |
| `hostMascotUrl` | string \| null | - | 固定主播的自定义立绘，留空时使用模板内置立绘 |
| `mascotMode` | enum | - | `per-item`（按条目切换）或 `fixed-host`（全程固定） |
| `coverDurationSec` | number | 1~120s | 封面停留/TTS 时长（支持 0.1s 小数） |
| `outroDurationSec` | number | 1~120s | 尾页停留/TTS 时长（支持 0.1s 小数） |
| `items[].shortTitle` | string | 30 字 | 封面/尾页目录短标题（留空自动截断主标题） |
| `items[].title` | string | 48 字 | 单条新闻主标题 |
| `items[].summary` | string | 100 字 | 简短新闻梗概（非口播台词） |
| `items[].keyPoints` | string[] | 3条×32字 | 简明事实要点 |
| `items[].imageUrl` | string \| null | - | 官方报告图表/公告截图（失效自动切全幅面板） |
| `items[].secondaryImageUrl` | string \| null | - | 可选第二张官方参考图（双图拼版） |
| `items[].imageCaption` | string | 44 字 | 图注引用说明 |
| `items[].officialQuote` | string | 120 字 | 兼容旧数据的官方原文摘录 |
| `items[].metrics` | `{label,value}[]` | 4组 | 兼容旧数据的官方参数规格行 |
| `items[].source` / `sourceUrl` | string | 24 / 42 | 原始信源名称与域名归属 |
| `items[].durationSec` | number | 1~180s | 对应 TTS 音频精确时长（支持 0.1s 小数） |

## 自动化合成参数与桥接接口

- `?clean=1`：隐藏底部控制栏，输出纯净 16:9 画面
- `?autoplay=1` / `?page=0` / `?theme=light|dark` / `?transition=glide|flip|fade|none` / `?motion=static`
- `T` 快捷键（或点击底部控制台动效按钮）：实时切换「纸张滑移」「轻柔翻页」「平滑叠化」「无动效」
- `window.__NEWS_DECK__.setNewsData(json)` / `goToPage(i)` / `getHealthReport()`
