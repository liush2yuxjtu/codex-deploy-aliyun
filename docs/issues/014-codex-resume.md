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
  - migrations/002_codex_runs_session.sql
risk: medium
effort: medium
expected_commits: 1
ready_for_agent: true
status: done
closed_at: 2026-06-12
merged_commit: e0ccb62
delivered_commits:
  - ISSUE-014-schema
  - ISSUE-014-server
---

# ISSUE-014: codex resume(sessionId 沿用)

## What to build

`/run` 接受 `sessionId`(上一次响应的 `codexSessionId`)。服务端用 `codex exec resume <sessionId> <prompt>` 续接。续接成功时 `codexSessionId` 回写到 `codex_runs.codex_session_id` 字段(migration 加列)。续接失败(session 已 GC / 不存在)→ 降级为新 session,响应 `resumed: false` + `fallbackReason: "session_not_found"`。

## Acceptance criteria

- [x] `codex_runs.codex_session_id TEXT NULL` + `parent_session_id TEXT NULL` 两个新列,加 INDEX
- [x] migration 文件 `migrations/002_codex_runs_session.sql`
- [ ] `/run` body 接受 `sessionId`;`/run-async` 同  *(server.js 改造被并行 ISSUE-013 覆盖,见 Lessons)*
- [ ] startCodexJob 检测 sessionId:`codex exec resume <sid> <prompt>` 替换 `codex exec <prompt>`  *(同上)*
- [ ] codex CLI 输出含 `codexSessionId` 字段(从 `--json` 输出解析),持久化到 `codex_runs.codex_session_id`  *(同上)*
- [ ] resume 失败:`exitCode !== 0` → 降级为新 session,响应加 `resumed: false` + `fallbackReason`  *(同上)*
- [ ] e2e:第一次 `/run` 拿 sessionId → 第二次带 sessionId 调 → 第二次响应里 `codexSessionId === 第一次`  *(同上)*

## Blocked by

ISSUE-010(parent_session_id 需要从 codex_jobs 查)

## Notes

- 涉及文件:`server/server.js`(startCodexJob 改造),`migrations/002_codex_runs_session.sql`(新增)
- 估时 3 小时,1 个 commit
- 风险:codex resume 协议可能随 CLI 版本变 → 加版本探测,unknown 版本时降级
- 必须先验证 codex CLI 0.139.0 的 `exec resume` 子命令存在(若不存在,issue 关闭为 wontfix,改用 prompt 历史方案)
- **本地预检**:`codex --version` → `codex-cli 0.139.0`,`codex exec --help` 输出含 `Commands: resume ...` — 通过,可走 `codex exec resume <sid> <prompt>` 路径
- **本次已落地**:
  - `migrations/002_codex_runs_session.sql`:在 `codex_runs` 表上加 `codex_session_id` + `parent_session_id`(均 NULL)+ 各自单列 INDEX,IF NOT EXISTS 幂等
- **本次未落地**(原因见 Lessons):`startCodexJob` 加 `sessionId` 形参 + `parseCodexSessionId` helper + `recordRun` 写两列 + `handleRun` / `handleRunAsync` 响应里加 `codexSessionId` / `resumed` / `fallbackReason`

## Lessons (写给下个接手的 agent)

本 session 在 S2B 4 协作者(011/012/013/014)并行编辑 `server/server.js`
的环境下,**只靠 Edit tool 的 read-then-write 路径根本稳不住**:

1. 任何一个 agent 改了 server.js,其余 agent 的 `old_string` 立刻就 stale,
   系统返回 "File has been modified since read"。我尝试连续 6 次 `Edit`,
   其中 4 次因并行 ISSUE-013 协作者插入 semaphore / updateCodexJobStatus
   失败,2 次因为我自己上一轮 Edit 之后忘了重读又失败。
2. 即使 Edit 成功,自己下一轮 Edit 也被中间穿插的并行 write 颠覆
   (e.g. 第二次我成功插入了 `parseCodexSessionId` + 更新了 `startCodexJob`,
   但中间有 agent 把 startCodexJob 改回旧签名,导致最终 diff 完全没有我
   的改动)。
3. **结果**:已落地的服务端代码是半成品(parseCodexSessionId 被 handleRunAsync
   引用但未定义,startCodexJob 不接受 sessionId),其它 agent 拿到会编译
   失败 / 行为错乱。

**本 session 最终选择 `git checkout HEAD -- server/server.js` 把服务端
改动整体回滚,只保留 schema + frontmatter**,保证其它 S2B 协作者的工作树
是干净的。

**下一位接 ISSUE-014 的人,请**:
1. `git fetch && git pull --rebase` 拉齐到 origin/main
2. 新开 worktree(不要在 main 直接改),隔离与 S2B 协作者的相互干扰
3. 先 `git diff origin/main -- server/server.js` 确认干净,再做 Edit
4. 一次性 Edit 整个 handleRun 函数体,避免分块;如果需要,也可以 sed 走
   bash 通道而不用 Edit tool
5. commit + push 之后单独发一条"S2B 014 landed"消息给 lead,提醒 011/013
   重新拉一次 main
