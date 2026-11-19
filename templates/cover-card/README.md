# 视频封面模板（cover-card）

`AI 每日报` 上传 B 站用的封面模板，输出 **1920×1080（16:9）JPG**。纯静态页面（`index.html` + `cover.css` + `cover.js`），不需要构建。

## 版式

- 左侧：刊名、日期、期号 → 特大字主标题 → 黑底副标题。
- 右侧：当期主播立绘 + 主题色圆形色块 + “本期主播”贴纸。
- 主题色随主播切换：DeepSeek 海蓝、GPT 翠绿、Gemini 星紫、Claude 琥珀橙。
- 文字放在左右各 200px 以内的安全区，按 4:3 居中裁切时不会被切掉；底部 120px 不放关键文字，避开 B 站信息流里的播放量和时长角标。

## 文字怎么填

| 字段 | 建议字数 | 说明 |
| --- | --- | --- |
| 主标题 | 4～14 字 | 可以用一对 `*星号*` 包住要高亮的词，如 `GPT-6.2 *翻车了*`；支持用换行符手动换行（最多 3 行，如 `英伟达\n*停发*H200`），换行符不计入字数。英文词（如 `Qwen4-Max`）不会被拆到两行。 |
| 副标题 | 8～22 字 | 一句话补充数字、价格或悬念，可留空，不支持星号。 |

字号会自动缩放：若主标题包含手动换行符，优先按用户指定行号保持每行完整；未手动换行时主标题优先排成两行，太长时才缩小并允许三行；副标题优先一行，太长时排成两行。

## 三种用法

1. **流水线自动出图**：`config/settings.yaml` 配了 `template.cover.dir: templates/cover-card` 时，合成视频阶段会用编排阶段生成的封面文字出图，结果写到 `storage/runs/<任务>/output/cover.jpg`，投稿时直接使用。模板出图失败时会自动改用视频第一帧。
2. **审核时改字**：网页后台「发布审核」页签的封面卡片里改主标题和副标题，点“保存并重新生成封面”，只重新出封面，不重新合成视频。命令行写法如下：

   ```bash
   aidaily cover <任务ID>                                   # 查看当前封面文字
   aidaily cover <任务ID> --title 'GPT-6.2 *翻车了*' --subtitle '成本砍到三分之一'
   ```

3. **手动预览**：直接用浏览器打开 `index.html`，用地址参数填字：

   ```
   index.html?title=GPT-6.2%20*翻车了*&subtitle=成本砍到三分之一&host=gemini
   ```

   可用参数：`title`、`subtitle`、`host`（`deepseek` / `gpt` / `gemini` / `claude`）、`hostName`、`date`、`issue`、`mascot`（立绘图片地址）。

## 对接接口

页面加载后提供 `window.__COVER__`：

```ts
window.__COVER__.setData({
  title: string,        // 主标题
  subtitle: string,     // 副标题，可为空
  masthead: string,     // 刊名
  date: string,         // 展示日期，如 “11月18日 周三”
  issueNumber: string,  // 期号，如 “VOL.2026.11.18”
  hostId: 'deepseek' | 'gpt' | 'gemini' | 'claude',
  hostName: string,     // 主播显示名
  mascotUrl: string,    // 立绘地址，可为空
});
await window.__COVER__.waitUntilReady(); // => { ok: boolean, warnings: string[] }
```

自动出图时地址带 `?external=1`，页面不会先填示例数据。立绘由本地服务挂在 `/__mascot_assets__/<主播>.png`，对应项目里的 `assets/mascots/<主播>.png`。

调整立绘大小和位置：改 `cover.js` 顶部的 `MASCOT_LAYOUT`。调整配色：改 `cover.css` 里各主播的 `--accent` 变量。
