---
id: ISSUE-011
us: US-1.4
title: SSE Last-Event-ID 断线重连
parallel_group: S2A
type: AFK
blocked_by:
  - ISSUE-010
soft_blocked_by: []
files:
  - server/server.js
  - frontend/index.html
risk: medium
effort: small
expected_commits: 1
ready_for_agent: true
status: pending
---

# ISSUE-011: SSE Last-Event-ID 断线重连

## What to build

EventSource 断线 → 重连时带 `Last-Event-ID`(来自上一次 `event.lastEvent.id`),服务端从 `lastEvent.ts` 之后的 snapshot 重发。超过 60min GC 窗口 → 自动降级为 `GET /job/:id` 一次性轮询。

## Acceptance criteria

- [ ] 服务端 `GET /job/:id/events` 读 `Last-Event-ID` header;若有,从 `JOBS.get(id).events.find(e => e.id === lastEventId)` 开始重发
- [ ] 内存 miss + 60min 内 → 降级查 RDS(last_event_ts 之后的状态)
- [ ] 内存 miss + 超 60min → 走 ISSUE-010 的"从 RDS 重建"路径,只发 `done` 终态事件
- [ ] 前端 EventSource 在 onerror 后,`new EventSource(url, { headers? })` 不直接支持 → 改用 query string `?resume=<lastEventId>`
- [ ] 卡片 UI:重连期间显示"重新连接中…";断线 < 5s 不重连,> 5s 才显示提示
- [ ] Playwright e2e:启异步 job → 2s 后 `eventSource.close()` → 5s 后重连 → 验证收到剩余事件 + 最终 done 状态

## Blocked by

ISSUE-010(必须先有 RDS 重建路径)

## Notes

- 涉及文件:`server/server.js`(events 路由 + Last-Event-ID 处理),`frontend/index.html`(重连逻辑)
- 估时 1.5 小时,1 个 commit
- 风险:EventSource API 不支持自定义 header,需用 query string 方案;查 Node `http` 文档确认
- 落地前先确认 codex CLI v0.139.0 的 stdout 流式输出能被 `startCodexJob` 收集成可重发的事件序列(不只是 done 一次性)
