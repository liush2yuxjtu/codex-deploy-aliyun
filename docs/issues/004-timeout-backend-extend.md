---
id: ISSUE-004
us: US-1.3 (back)
title: timeoutSec 后端 max=900 + exitCode=124
parallel_group: S1B
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - server/server.js
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: pending
---

# ISSUE-004: timeoutSec 后端 max=900 + exitCode=124

## What to build

把 `server.js` 里 `MAX_TIMEOUT` 从 240 提到 900,`/run` 与 `/run-async` 的 `timeoutSec` 参数都按新上限校验。codex 进程被 kill 触发时,响应里 `exitCode=124` + `error: "timeout"`(沿用 GNU `timeout` 语义)。

## Acceptance criteria

- [ ] `MAX_TIMEOUT = 900` 常量
- [ ] `timeoutSec` 校验:超出 900 → 400 `{error: "bad_timeout", max: 900}`
- [ ] 超时触发时:`exitCode === 124 && error === "timeout"`
- [ ] 同步 `/run` 与异步 `/run-async` 两条路径行为一致
- [ ] `/healthz` 自检:e2e `curl /run -d '{"timeoutSec": 901}'` → 400
- [ ] e2e:`curl /run -d '{"prompt":"sleep 5","timeoutSec": 2}'` → exitCode=124, error="timeout"

## Blocked by

None

## Notes

- 涉及文件:`server/server.js`(常量 + handleRun / handleRunAsync 两处校验)
- 估时 20 分钟,1 个 commit
- 与 ISSUE-003(前端下拉)完全独立;前端 600s 选项在 004 落地后真正可用
