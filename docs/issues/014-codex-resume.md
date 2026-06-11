---
id: ISSUE-014
us: US-2.4
title: codex resume(sessionId 沿用)
parallel_group: S2B
type: AFK
blocked_by:
  - ISSUE-010
soft_blocked_by: []
files:
  - server/server.js
  - migrations/00Y_codex_runs_session.sql
risk: medium
effort: medium
expected_commits: 1
ready_for_agent: true
status: pending
---

# ISSUE-014: codex resume(sessionId 沿用)

## What to build

`/run` 接受 `sessionId`(上一次响应的 `codexSessionId`)。服务端用 `codex exec resume <sessionId> <prompt>` 续接。续接成功时 `codexSessionId` 回写到 `codex_runs.codex_session_id` 字段(migration 加列)。续接失败(session 已 GC / 不存在)→ 降级为新 session,响应 `resumed: false` + `fallbackReason: "session_not_found"`。

## Acceptance criteria

- [ ] `codex_runs.codex_session_id TEXT NULL` + `parent_session_id TEXT NULL` 两个新列,加 INDEX
- [ ] migration 文件 `migrations/00Y_codex_runs_session.sql`
- [ ] `/run` body 接受 `sessionId`;`/run-async` 同
- [ ] startCodexJob 检测 sessionId:`codex exec resume <sid> <prompt>` 替换 `codex exec <prompt>`
- [ ] codex CLI 输出含 `codexSessionId` 字段(从 `--json` 输出解析),持久化到 `codex_runs.codex_session_id`
- [ ] resume 失败:`exitCode !== 0` → 降级为新 session,响应加 `resumed: false` + `fallbackReason`
- [ ] e2e:第一次 `/run` 拿 sessionId → 第二次带 sessionId 调 → 第二次响应里 `codexSessionId === 第一次`

## Blocked by

ISSUE-010(parent_session_id 需要从 codex_jobs 查)

## Notes

- 涉及文件:`server/server.js`(startCodexJob 改造),`migrations/00Y_codex_runs_session.sql`(新增)
- 估时 3 小时,1 个 commit
- 风险:codex resume 协议可能随 CLI 版本变 → 加版本探测,unknown 版本时降级
- 必须先验证 codex CLI 0.139.0 的 `exec resume` 子命令存在(若不存在,issue 关闭为 wontfix,改用 prompt 历史方案)
