---
id: ISSUE-013
us: US-2.1
title: 并发信号量 + FIFO 队列(MAX_CONCURRENT_CODEX)
parallel_group: S2B
type: AFK
blocked_by:
  - ISSUE-010
soft_blocked_by: []
files:
  - server/server.js
risk: medium
effort: medium
expected_commits: 1
ready_for_agent: true
status: done
closed_at: 2026-06-12
merged_commit: e3b3eb2
---

# ISSUE-013: 并发信号量 + FIFO 队列(MAX_CONCURRENT_CODEX)

## What to build

全局信号量 `MAX_CONCURRENT_CODEX`(默认 3,可由 env 覆盖)。第 4 个请求进 FIFO 队列;卡片显示"等待中 · 队列位 1/3"。队列满(假设容量 6)→ 503 + `Retry-After: 10`。任务完成后释放 slot,队列下一个立即开始。

## Acceptance criteria

- [ ] `MAX_CONCURRENT_CODEX` env 变量,默认 3
- [ ] `MAX_QUEUE_SIZE` 默认 6(env 可配)
- [ ] 5 个并发请求(2s 内发出):前 3 立即 `running`,后 2 状态 `queued`;第一个完成后第 4 个立即升 `running`
- [ ] 第 7 个并发请求 → 503 + `Retry-After: 10` + `error: "queue_full"`
- [ ] 队列等待 > 30s → 503 + `error: "queue_timeout"`
- [ ] 状态机新增 `queued`(ISSUE-010 schema 已含)
- [ ] UI 卡片:queued 状态显示"等待中 · 队列位 1/3" + 灰色 spinner
- [ ] 涉及文件:`server/server.js` 顶层加 semaphore + queue + setImmediate drain
- [ ] e2e:5 并发跑 60s sleep → 第 4 个状态 `queued` 持续 ~60s,前 3 个完成后第 4 个立即 `running`

## Blocked by

ISSUE-010(queued 状态需要 RDS 持久化才能跨重启)

## Notes

- 涉及文件:`server/server.js`(信号量 + 队列 + startCodexJob 改造)
- 估时 3 小时,1 个 commit
- 风险:信号量饥饿 → max wait 30s 超时返 503,避免永久等
- 优先级:信号量(防止 SWAS OOM)> 队列(用户体验)> 503(底线)
