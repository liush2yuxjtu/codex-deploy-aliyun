---
id: ISSUE-003
us: US-1.3 (front)
title: timeoutSec 前端下拉(60/120/300/600s)
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

# ISSUE-003: timeoutSec 前端下拉(60/120/300/600s)

## What to build

在 sendMessage 输入框旁加一个 `<select>` 下拉:`60s / 120s / 300s / 600s`,默认 120s;PDF 模式默认 300s。选中的值随 prompt 一起作为 `timeoutSec` 字段发到 `/run` 或 `/run-async`。

## Acceptance criteria

- [ ] 聊天模式下拉显示 4 个选项,默认 120s
- [ ] PDF 模式(tablist 切到 PDF)下拉默认切到 300s
- [ ] 选中值随请求体发出,字段名 `timeoutSec`
- [ ] 下拉 UI 风格与现有 ChatGPT 风格一致(no 新依赖)
- [ ] e2e:在 chat 模式选 600s → curl 抓包 `POST /run` 看到 `timeoutSec: 600`

## Blocked by

None

## Notes

- 涉及文件:`frontend/index.html` 的 sendMessage 表单区
- 估时 30 分钟,1 个 commit
- 后端 max 扩展见 ISSUE-004(本 issue 不依赖,但下拉的 600s 选项要等 004 落地才真正生效)
