---
id: ISSUE-001
us: US-1.1
title: 关键词白名单扩展 + 中文意图识别
parallel_group: S1A
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - frontend/index.html
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: pending
---

# ISSUE-001: 关键词白名单扩展 + 中文意图识别

## What to build

把 `frontend/index.html` 里 sendMessage 的意图识别白名单从 v1 的 `/pdf|导出|export|render|渲染|生成.*pdf` 扩到覆盖中文变体(做个 PDF / 弄成 PDF / 转 PDF / 帮我 render 一下 / .pdf 文件名 等),命中后走 `sendAsync`。提供 `window.__codexAsyncKeywords` 暴露为可运行时热更新。

## Acceptance criteria

- [ ] 关键词正则升级为:`/pdf|导出|export|render|渲染|生成.*pdf|做.*pdf|转.*pdf|弄.*pdf|\.pdf/i`
- [ ] 命中后调用 `sendAsync`(而非 `sendSync`)
- [ ] 未命中但被误判走 sync 的请求:卡片不显示错误,但控制台 warn 一行 `<prompt[:30]> fell through to sync`
- [ ] `window.__codexAsyncKeywords` 可被 devtools 替换,替换后下一次 sendMessage 生效
- [ ] e2e:输入 "帮我 render 一份 PDF" → 卡片显式显示 `⏱` 状态(异步通道)

## Blocked by

None

## Notes

- 风险:误判让普通聊天也走异步 → 白名单收紧策略 = "PDF 主题词 + 至少一个动词"
- 涉及文件:`frontend/index.html` 的 sendMessage 函数体
- 估时 30 分钟,1 个 commit
