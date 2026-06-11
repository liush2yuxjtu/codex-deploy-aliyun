---
id: ISSUE-005
us: US-2.3
title: killJobTree helper(SIGTERM→SIGKILL)
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
status: done
---

# ISSUE-005: killJobTree helper(SIGTERM→SIGKILL)

## What to build

在 `server.js` 顶层加一个 `killJobTree(child, { gracefulMs = 5000 })` helper:先 SIGTERM,等 `gracefulMs`,还在就 SIGKILL(走 `process.kill(-child.pid, sig)` 杀进程组,见 `reference-deployment-gotchas` #6)。helper 接受 `child === null`(job 还没 spawn),捕 ESRCH 不抛错。

## Acceptance criteria

- [ ] helper 签名:`async function killJobTree(child, { gracefulMs = 5000 } = {})`
- [ ] child === null → return `{killed: false, reason: "no_child"}`
- [ ] child 已死 → catch ESRCH,return `{killed: false, reason: "already_dead"}`
- [ ] SIGTERM 后 gracefulMs 内退出 → return `{killed: true, sig: "TERM"}`
- [ ] SIGTERM 超时 → SIGKILL → return `{killed: true, sig: "KILL"}`
- [ ] 日志统一格式:`[killJobTree] job=<id> pid=<pid> sig=<TERM|KILL> reason=<user|timeout>`
- [ ] 不破坏现有 `/run` 同步路径(暂时不被调用,但落地后供 ISSUE-002/004/013/014 复用)

## Blocked by

None

## Notes

- 涉及文件:`server/server.js` 顶层(新增 helper,不动现有 handler)
- 估时 30 分钟,1 个 commit
- 是 ISSUE-002 / 004 / 013 / 014 的"前置 refactor"(软依赖),先做它可让后续 4 个 issue 各省 1 处重复实现
- 单元测可放 `test/kill-tree.test.sh`,启 60s sleep 子进程触发 cancel,断言 5s 内死
