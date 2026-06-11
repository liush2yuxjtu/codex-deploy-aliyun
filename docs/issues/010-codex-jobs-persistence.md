---
id: ISSUE-010
us: US-2.2
title: codex_jobs 表 + 内存/RDS 双读
parallel_group: S2A
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - server/server.js
  - migrations/00X_codex_jobs.sql
risk: medium
effort: large
expected_commits: 2
ready_for_agent: true
status: pending
---

# ISSUE-010: codex_jobs 表 + 内存/RDS 双读

## What to build

新增 `codex_jobs` 表(job 元数据持久化),`JOBS.set` 同步 INSERT、`emitJob` 的 `done/error/cancelled/timeout` 同步 UPDATE。`/job/:id` 路由改为:内存命中 → 内存数据;内存 miss → 查 RDS 重建只读 job 对象。stdout/stderr 落 `/var/lib/codex-runs/<jobId>/`,**RDS 不存大文本**(只存路径)。

## Acceptance criteria

- [ ] 新表 schema(详见 PRD):
  - `job_id UUID PK`, `status TEXT NOT NULL CHECK in (queued,running,firstByte,done,error,cancelled,timeout)`
  - `prompt TEXT`, `model TEXT`, `started_at BIGINT`, `finished_at BIGINT NULL`
  - `duration_ms BIGINT NULL`, `exit_code INT NULL`, `client_ip TEXT NULL`
  - `last_event_ts BIGINT NOT NULL`, `stdout_path TEXT NOT NULL`, `stderr_path TEXT`
- [ ] migration 文件 `migrations/00X_codex_jobs.sql`,含 INDEX(`status`, `started_at`)
- [ ] `startCodexJob` 内:INSERT 一行,status='running',`stdout_path`/`stderr_path` 预填
- [ ] `emitJob('done')` / `('error')` / `('cancelled')` / `('timeout')` → UPDATE status + finished_at + duration_ms
- [ ] `/job/:id` 路由:内存 hit → 内存对象;内存 miss → RDS 查 → 重建 `{state, lastEvent, emitter: null}`
- [ ] RDS 写失败仅 log,不阻塞主流程
- [ ] e2e:`/run-async` 跑完后,SWAS 重启,`curl /job/:id` 仍返 200 + status=done
- [ ] 内存 60min GC 不变;RDS 无 TTL

## Blocked by

None(本身是其他 4 个 S2 issue 的前置)

## Notes

- 涉及文件:`server/server.js`(INSERT/UPDATE 嵌入 startCodexJob + emitJob),`migrations/00X_codex_jobs.sql`(新增)
- 估时 4 小时,2 个 commit(1 migration + 1 server)
- 风险:INSERT 在 spawn 之前还是之后 → 选"之前",让"queued" 状态可查;spawn 成功 → UPDATE 'running'
- 是 ISSUE-011 / 012 / 013 / 014 的**硬前置**,落地后这 4 个可并行开工
- 必须包含 1 次"模拟 SWAS 重启"的 e2e:systemctl restart codex-api → 验证 `/job/:id` 仍返 200
