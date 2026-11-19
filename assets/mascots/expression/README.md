# AI 每日报看板娘 Live2D 素材

打开对应的 `.model3.json` 即可在支持 Cubism 4 的查看器里加载模型。搬运时请带上整套目录，入口文件引用的贴图、物理、表情和动作使用相对路径。

| 角色 | 模型入口 |
| --- | --- |
| DeepSeek 娘 | [deepseek.model3.json](deepseek/deepseek.model3.json) |
| GPT 娘 | [gpt.model3.json](gpt/gpt.model3.json) |
| Gemini 娘 | [gemini.model3.json](gemini/gemini.model3.json) |
| Claude 娘 | [claude.model3.json](claude/claude.model3.json) |

四个模型沿用同目录的透明立绘。原画的轮廓、配色、发饰和服装图案都保留，闭眼和缺失的口型用图像生成补齐。DeepSeek 原画为张嘴笑，在模型里将口型设为 1 即可恢复该表情；其余三个角色待机时沿用原画的嘴型。

| 参数 | 范围与用途 |
| --- | --- |
| `ParamMouthOpenY` | 0–1，停顿时写 0，说话时写当前开口度 |
| `ParamEyeLOpen` / `ParamEyeROpen` | 0–1，角色的左眼和右眼，默认 1 |
| `ParamBreath` | 0–1，默认 0.5 |
| `ParamAngleX` / `ParamAngleY` / `ParamAngleZ` | −30–30，用于小幅转头、抬低头和侧倾 |
| `ParamHairSwing` | −1–1，发梢摆动，由随包物理文件驱动 |
| `ParamMouthForm` | −1–1，微调嘴角；随包表情通过此参数控制 |

`Idle` 动作用于查看待机，`Talk` 动作用于无音频预演口型。用真实音频驱动时，请向 `ParamMouthOpenY` 写入音频开口度，不播放 `Talk`。这些是用于播报看板的轻量绑定：小幅动作下保留原画观感，手臂和服装没有单独绑定。当前日报模板仍需接入 Live2D 渲染。

图像生成采用内置 ImageGen。四个角色的提示词都以对应原图为参考，要求保留眼形、线重、赛璐珞光影及原有配色，在透明底上分开放置左右闭眼线、闭嘴微笑和含牙齿与舌头的说话口型；不重画头部，不加标签或背景。生成贴图经裁切和对齐后，只用在原稿缺失的局部。
