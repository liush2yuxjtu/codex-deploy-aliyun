---
project: codex-deploy-aliyun
prd: ../PRD-v2.md
sprint_count: 3
total_issues: 15
generated: 2026-06-12
---

# codex-deploy-aliyun v2 — Issue Index

本文档把 `docs/PRD-v2.md` 的 14 个 user story 拆成 **15 个 vertical-slice issue**(US-1.3 拆成前后端两个并行文件,US-3.3 因依赖 US-2.2 移到 S2A)。所有 issue 都是 tracer-bullet 切片:每个都自包含、可独立 e2e 验证。

> Issue tracker:本仓库尚未配置 issue tracker(无 GitHub Issues 启用)。在 tracker 启用前,这些 `.md` 文件即为 source of truth,提交时按 `ISSUE-NNN: <title>` 命名 commit 即可,合入 main 后从 `docs/issues/` 删掉已完成的文件。

## Slice 分组

| Group | Issue IDs | 范围 | 启动条件 |
|---|---|---|---|
| **S1A** Frontend polish | 001, 002, 003 | 关键词白名单、异步取消 UI、timeout 下拉 | 无,全并行 |
| **S1B** Backend kill + timeout | 004, 005 | timeout max=900、killJobTree helper | 无,全并行 |
| **S1C** Security & onboarding | 006, 007, 008, 009 | 凭据轮换、onboarding skill、anonymized.html 处置、docs 索引 | 无,全并行 |
| **S2A** Persistence | 010, 011, 012 | codex_jobs 表 + SSE 重连 + tail 日志流 | 010 先,011/012 在 010 后并行 |
| **S2B** Concurrency + Resume | 013, 014 | 并发信号量、codex resume | 013/014 都在 010 后并行 |
| **S3** Workspace | 015 | worktree 自托管 | 无,任意时段 |

## Issue 索引

| ID | Title | US | Group | Type | Blocked by | 估时 | Commits |
|---|---|---|---|---|---|---|---|
| [001](001-keyword-whitelist-extend.md) | 关键词白名单扩展 + 中文意图识别 | US-1.1 | S1A | AFK | None | small | 1 |
| [002](002-async-cancel-ui.md) | 异步卡片可取消(前端) | US-1.2 | S1A | AFK | None(soft: 005) | small | 1 |
| [003](003-timeout-dropdown.md) | timeoutSec 前端下拉(60/120/300/600) | US-1.3 front | S1A | AFK | None | small | 1 |
| [004](004-timeout-backend-extend.md) | timeoutSec 后端 max=900 + exitCode=124 | US-1.3 back | S1B | AFK | None | small | 1 |
| [005](005-kill-job-tree-helper.md) | killJobTree helper(SIGTERM→SIGKILL) | US-2.3 | S1B | AFK | None | small | 1 |
| [006](006-rotate-credentials.md) | 凭据轮换脚本(LLM/RDS/AccessKey/SSH) | US-1.5 | S1C | AFK | None | medium | 2 |
| [007](007-onboarding-skill.md) | `onboard-codex-deploy` skill | US-3.1 | S1C | AFK | None | medium | 1(skills 仓) |
| [008](008-anonymized-html-disposition.md) | workspace/anonymized.html 处置(A/B/C 选项) | US-3.4 | S1C | **HITL** | None | small | 1 |
| [009](009-docs-index-and-adr.md) | docs/ 索引页 + ADR 框架 | US-3.5 | S1C | AFK | None | medium | 2 |
| [010](010-codex-jobs-persistence.md) | codex_jobs 表 + 内存/RDS 双读 | US-2.2 | S2A | AFK | None | large | 1 + 1 migration |
| [011](011-sse-last-event-id.md) | SSE Last-Event-ID 断线重连 | US-1.4 | S2A | AFK | 010 | small | 1 |
| [012](012-chat-tail-stdout.md) | 异步任务 chat tail 日志流 | US-3.3 | S2A | AFK | 010 | small | 1 |
| [013](013-concurrency-semaphore.md) | 并发信号量 + FIFO 队列(MAX_CONCURRENT_CODEX) | US-2.1 | S2B | AFK | 010 | medium | 1 |
| [014](014-codex-resume.md) | codex resume(sessionId 沿用) | US-2.4 | S2B | AFK | 010 | medium | 1 |
| [015](015-worktree-self-host.md) | worktree 自托管(per-worktree port triple) | US-3.2 | S3 | AFK | None | medium | 1 |

## 依赖图

```mermaid
graph TD
  001[001 keywords]:::s1a
  002[002 async cancel UI]:::s1a
  003[003 timeout dropdown]:::s1a
  004[004 timeout backend]:::s1b
  005[005 killJobTree]:::s1b
  006[006 rotate creds]:::s1c
  007[007 onboarding]:::s1c
  008[008 anonymized.html]:::s1c
  009[009 docs index]:::s1c
  010[010 codex_jobs table]:::s2a
  011[011 SSE reconnect]:::s2a
  012[012 chat tail]:::s2a
  013[013 concurrency]:::s2b
  014[014 codex resume]:::s2b
  015[015 worktree]:::s3

  011 --> 010
  012 --> 010
  013 --> 010
  014 --> 010

  classDef s1a fill:#dbeafe,stroke:#3b82f6
  classDef s1b fill:#fef3c7,stroke:#f59e0b
  classDef s1c fill:#dcfce7,stroke:#22c55e
  classDef s2a fill:#fce7f3,stroke:#ec4899
  classDef s2b fill:#ede9fe,stroke:#8b5cf6
  classDef s3 fill:#f3f4f6,stroke:#6b7280
```

## 推荐并行组合

### Sprint 1(10 issues 并行)
10 个 agent 可以同时开工(每个 agent 抓 1-2 issue):
- **S1A 通道**:001, 002, 003 — 纯前端,互不阻塞
- **S1B 通道**:004, 005 — 纯后端,互不阻塞
- **S1C 通道**:006, 007, 008(HITL,需用户拍板), 009

### Sprint 2(2 waves)
- **Wave 1**:010(单线,落地是其他 4 个的前提)
- **Wave 2**(010 完成后):011, 012, 013, 014 四个并行

### 任意时段
- 015 可在 Sprint 1 / 2 任意空闲时段穿插,不阻塞任何其他 issue

## 软依赖(soft,可不阻塞)

- 002 异步取消 UI 软依赖 005 killJobTree:即便 005 未做,002 也可用 `process.kill(child.pid)` 临时方案落地,后续由 005 重构替换
- 014 codex resume 软依赖 013 并发:并发信号量落地前,resume 调用会争用 `startCodexJob`,但不影响 correctness

## 进度跟踪

每个 issue 落地时:
1. 改该 issue 文件的 frontmatter,把 `ready_for_agent: true` 改为 `in_progress: true`(被 agent 抓到)
2. 合入后改 `status: done` + `closed_at: <date>` + `merged_commit: <sha>`
3. README.md 顶部加一行"最近完成":`- ISSUE-NNN <title> (<sha>) — <date>`

完成 5 个 issue 后,触发 `/pre-mr` 跑一遍 4 段自检,再 push。

## 与 v1 决策的兼容性

所有 issue 落地时**必须尊重**:
- 不引入 Docker(`reference-deployment-gotchas` #1)
- 不 hardcode 前端 URL(#9)
- 不在代码 / commit message / chat 里出现 secret 明文(`reference-credentials-location`)
- 不依赖 systemd Environment= 注入 secret
- codex 进程杀法:`process.kill(-child.pid, 'SIGKILL')`(issue 005 显式封装)
- atomic commit + 立即 push(本仓 `CLAUDE.md`)

## 已完成(完成时填)

<!-- 完成一条 issue 后,在本节加一行 -->
<!-- - ISSUE-NNN <title> (<sha>) — <date> — agent: <name> -->
- ISSUE-003 timeoutSec 前端下拉(5399f7c) — 2026-06-12 — agent: codex
- ISSUE-012 异步任务 chat tail 日志流(e04f0fa) — 2026-06-12 — agent: codex
- ISSUE-013 并发信号量 + FIFO 队列(e3b3eb2) — 2026-06-12 — agent: codex
- ISSUE-022 OSS PDF bucket + presigned URL(ab16c95) — 2026-06-12 — agent: codex
- ISSUE-007 onboard-codex-deploy skill(skills 仓)(d51eef8) — 2026-06-12 — agent: codex

## v3 增量(2026-06-12 fork 拍板,从 aliyun-start 5 个候选挑出)

| ID | Title | Group | Status | Commit |
|---|---|---|---|---|
| [021](021-rds-migrate.md) | rds-migrate.sh idempotent migration applier | v3A | ✅ done | `6d932d1` |
| [022](022-oss-pdf-bucket.md) | OSS PDF bucket + presigned URL 落点 | v3B | ✅ done | `ab16c95` |
| [023](023-network-reachability.md) | SWAS-cs → RDS-cb 网络可达性诊断 | v3B | ✅ done | `6350eea` |
| [024](024-sls-logging.md) | codex-api 日志 → SLS,告别 journalctl | v3B | ✅ done | `55421eb` |
| [025](025-ecs-code-deploy.md) | ecs-code-deploy.sh idempotent atomic deploy | v3A | ✅ done | `ae4401b` |

v3 候选出处:`/aliyun-start` deep research,见 `/tmp/...` 报告或 handoff v2 doc 末尾。
