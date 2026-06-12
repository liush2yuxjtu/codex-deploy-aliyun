---
id: ISSUE-024
us: v3-#4
title: codex-api 日志 → SLS,告别 journalctl
parallel_group: v3B
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - scripts/setup_sls_logstore.sh
  - server/server.js
  - scripts/sls-tail.sh
risk: medium
effort: large
expected_commits: 4
ready_for_agent: true
status: done
merged_commit: 55421eb
closed_at: 2026-06-12
---

# ISSUE-024: codex-api 日志 → SLS,告别 journalctl

## What to build

`codex-api.service` 的 stdout/stderr 现在只能 `journalctl -u codex-api.service -n 30 --no-pager` 看(每次 SSH 进 SWAS)。切到 **Aliyun SLS**:

1. 新 project `codex-deploy-aliyun`,Logstore `codex-api`
2. `codex-api` 启动时通过 `aliyun-log-nodejs-sdk` 把每行 stdout/stderr 直接 push 到 SLS(structured: `{ts, level, msg, jobId?, runId?, ...}`)
3. 后台 worker:`scripts/sls-tail.sh` 等价于 `journalctl -f`,但走 SLS,SSH 不需要
4. dashboard:SLS 控制台开 dashboard,展示过去 1h 的 P50/P95 durationMs、`/run` QPS、`codex quota exceeded` 计数

## Acceptance criteria

- [ ] `scripts/setup_sls_logstore.sh`:建 project + logstore + index,RAM policy 给 `codexsbx` user `sls:PutLogLines` 权限
- [ ] `server/server.js` 引入 `aliyun-log-nodejs-sdk`(或 `aliyun-log-cli` 子进程),每次 `console.log/error` 双写到 SLS
- [ ] level 推断:`console.error` → `error`;`[killJobTree]` 模式 → `info`;`[codexJobs update outer]` 模式 → `warn`(失败但可重试);其余 → `info`
- [ ] `scripts/sls-tail.sh --since 5m --level error --grep quotaExceeded` 走 SLS PullLogs API 出结果
- [ ] e2e:跑 `/run` 后,SLS 控制台 Logstore 查询 `level:error AND msg:quotaExceeded` 应返回对应行
- [ ] 性能影响:每次 console.log 多花 <5ms(SDK 是 batched 异步推送)
- [ ] 不破坏:本地 `node server/server.js` 跑(无 RAM creds)时,SDK 静默失败,console 仍打 stdout
- [ ] 现有 `journalctl -u codex-api.service` 仍能查(SLS 是补充不是替换,方便回溯历史归档)

## Blocked by

None

## Notes

- 涉及文件:`scripts/setup_sls_logstore.sh`(新增),`scripts/sls-tail.sh`(新增),`server/server.js`(SDK 集成),`.env.example`(加 `SLS_ENDPOINT` `SLS_PROJECT` `SLS_LOGSTORE` `SLS_ACCESS_KEY_ID` `SLS_ACCESS_KEY_SECRET`)
- 估时 1 天,4 个 commit
- 风险:SDK 同步失败导致 server 卡顿 → 全部用 SDK 异步 batch 模式,出错只 log 不抛
- 收益:排查"为什么 5 个 job 同时 hang"从 SSH + journalctl grep 5min,降到 SLS 控制台 1 次查询 5s
- skill 装:`npx skills add aliyun/aliyun-sls-agent-skills`(12+ 个 SLS 操作 skill,log query / Logstore mgmt / dashboard 等)
- 与 023 reachability 互补:023 是"网络通不通",024 是"代码在不在说话"
