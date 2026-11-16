# AI 娘化立绘资产目录

本目录内置以下来自 `genderswapai.com/zh-CN/ai-gijinka`（原设出处 ZipZipPipe《大AI和小AI们》）的透明背景 RGBA PNG 立绘，并在页面右下角以轻量角标形式呈现：

- `deepseek.png` — **DeepSeek娘**（默认主讲 / 蓝色大肥鱼）
- `gpt.png` — **GPT娘**（白发龙娘）
- `claude.png` — **Claude娘**（橙发文学少女）
- `gemini.png` — **Gemini娘**（异色瞳星猫耳）
- `grok.png` — **Grok娘**（金发黑礼服）

## 使用与自定义

- 在新闻 JSON 中设置 `"mascotId": "deepseek" | "gpt" | "claude" | "gemini" | "grok" | "none"` 即可切换对应角色或隐藏立绘；
- 如需使用自己的立绘（PNG / WebP / GIF / 透明 WebM），直接设置 `"customMascotUrl": "/mascots/your-character.png"`，若路径失效会自动安全回退，绝不出现裂图。
