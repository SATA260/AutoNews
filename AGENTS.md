# AI 每日报 — 项目开发与协作规范

## 项目定位

`AI 每日报`是一套面向大众受众的 AI 新闻自动化生产与 B 站发布系统：定时或手动触发 → 增量抓取中外 AI 资讯 → 跨源聚类与选题（条数可随时指定、缺条自动替补/补抓） → 通俗总结 → 中文口播表达润色 → 独立事实核查（偏差打回润色微调、无据剔除补位） → 整期编排与标题简介生成 → TTS 配音与前端模板合成 MP4 → 成片质检与人工审核后发布 B 站。

工程形态为 **TypeScript + `npm workspaces` Monorepo**（运行环境要求 Node.js >= 24）。

---

## 核心设计文档索引（修改或实现功能前必读）

- [docs/业务流程说明.md](./docs/业务流程说明.md)：8 步核心业务流、通俗总结 → 中文润色 → 独立事实核查打回微调闭环、缺条自动替补与扩窗补抓规则。
- [docs/项目架构说明.md](./docs/项目架构说明.md)：Monorepo 薄壳双入口（`apps/web` + `apps/cli`）+ 100% 共享业务内核（`@aidaily/core`）分层设计。
- [docs/开发设计文档.md](./docs/开发设计文档.md)：唯一实施技术规范，包含技术选型、配置 Schema、SQLite（WAL）数据模型、§4.6 阶段中断与重试规则、各包接口定义及 M0–M11 里程碑验收标准。
- [templates/daily-deck/README.md](./templates/daily-deck/README.md)：独立前端视频模板（`templates/daily-deck/`）的输入数据契约与 `window.__NEWS_DECK__` 桥接接口。

---

## 架构红线与关键业务约束

1. **薄壳原则**：`apps/cli` 与 `apps/web` 严禁包含业务逻辑，也禁止直接导入 `@aidaily/core/src/*`、`@aidaily/cli-bridge` 或 `@aidaily/tts`，只能调用 `@aidaily/core` 与 `@aidaily/contracts` 公开入口。
2. **配置驱动，零硬编码**：每个 AI 阶段（`select` / `summarize` / `polish` / `factcheck` / `package`）使用的 CLI 与模型均读取动态配置，严禁写死；每期新闻条数 `N` 与定时执行时间不设全局默认值，必须在手动触发或新建定时任务时显式填写。
3. **兼容层边界**：外部命令行统一走 `@aidaily/cli-bridge`（v1 内置 `agy`）；TTS（`@aidaily/tts`）与通知（`Notifier`）在 v1 仅实现抽象接口、管线与测试/空桩，具体引擎与飞书通知按接口扩展；B 站发布强制开启 AI 生成内容声明。
4. **可重入与可随时重试**：各阶段必须幂等；失败、取消或进程崩溃中断后保留预留文章与检查点，支持从中断处继续、从指定阶段重跑（旧产物归档至 `archive/`）及单条新闻重试；上传中断（`publish_uncertain`）禁止自动重传。
5. **模板隔离**：`templates/` 下的前端视频模板独立维护与构建，核心引擎只通过 `TemplateAdapter` 接口对接，不擅自改动模板内部代码。

---

## 工程与编码规范

- **语言与模块**：纯 ESM，TypeScript `strict` 模式；公开 API 禁止使用 `any`。
- **可测试 IO**：所有外部 IO（网络、子进程、文件系统、时间）经由 `CoreContext` 注入，不把真实外网或真实 CLI 耦合进单元测试。
- **契约校验与时间**：所有外部数据与 LLM 输出必须经过 Zod 校验；数据库时间统一存储 UTC ISO 字符串，展示时按配置的时区转换。
- **原子写入**：所有配置与阶段产物文件写入均采用「写同目录临时文件 + `rename`」方式，防止崩溃产生半截文件。
- **日志规范**：面向用户的事件与日志使用中文，错误码与代码标识使用英文。
- **提交前校验**：完成改动后必须确保 `npm run build && npm run typecheck && npm run lint && npm test` 全部通过。
