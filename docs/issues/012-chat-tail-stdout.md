---
id: ISSUE-012
us: US-3.3
title: 异步任务 chat tail 日志流
parallel_group: S2A
type: AFK
blocked_by:
  - ISSUE-010
soft_blocked_by: []
files:
  - server/server.js
  - frontend/index.html
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: done
merged_commit: e04f0fa
closed_at: 2026-06-12
---

# ISSUE-012: 异步任务 chat tail 日志流

## What to build

复用 ISSUE-011 的 EventSource 通道,新增事件类型 `codexStdout:line` / `codexStderr:line`。卡片折叠区可展开"看 raw output",默认折叠。行数超 200 截断,提示"还有 N 行,点此查看完整"。

## Acceptance criteria

- [ ] 服务端:codex 子进程 stdout 每行 → `emitJob('codexStdout:line', {line})`(同 stderr)
- [ ] 前端:收到 `codexStdout:line` → 累加到折叠区 DOM,默认 `display: none`
- [ ] 点击"展开" → 显示前 200 行,超 200 提示"…还有 N 行,点此查看完整"→ 跳到 `/history/:runId` 看全量
- [ ] 行渲染 100ms 节流(避免高频率事件卡 UI)
- [ ] 同步 `/run` 不受影响(同步路径不 emit 此类事件)
- [ ] e2e:异步跑 `codex exec --help`(一定会输出多行)→ 折叠区至少 5 行

## Blocked by

ISSUE-010(stdout 路径已落 RDS,意味着输出已可定位)

## Notes

- 涉及文件:`server/server.js`(emitJob 新事件类型),`frontend/index.html`(折叠区 DOM)
- 估时 1.5 小时,1 个 commit
- 风险:codex CLI 输出 buffer 满 → 必须保留 100ms 节流
- 与 ISSUE-011 的 EventSource 通道共用,无新通道
