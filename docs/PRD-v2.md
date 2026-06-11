# PRD — codex-deploy-aliyun v2

**Status:** Draft
**Owner:** Liu Shiyu
**Last updated:** 2026-06-12
**Repo:** `/Users/liushiyuwin/Documents/codex-deploy-aliyun`
**Live demo:** `http://106.14.154.23:3030/`
**Audience:** Next 2–3 sessions of agent work + future maintainers

> 本文档是 v1 demo 进入 v2 增量开发前的产品需求基线。它把"已经在 main 上 ship 的能力"作为不变量,把会话交接留下的 7 个 open item 转成可验收的用户故事,并对接下来 2–3 个 sprint 的可选方向给出优先级建议。**本文档不重复写在代码 / handoff doc / 5 份 memory 里的实现细节**——遇到冲突以代码为准。

---

## Problem Statement

v1 把 codex-deploy-aliyun 跑成了一个"自然语言 → 远端 Codex CLI 沙箱 → 拿回结果"的端到端 demo,8 个 commit 全部 atomic + push,公网可访问。但用户(刘世宇)和接手 agent 在此基础上推进时,被以下结构性问题卡住:

1. **长任务无进度反馈**。`/run` 同步调用要 5–20s(配 codex CLI 冷启动 + LLM 推理 + tool call),前端 30s 内拿不到任何东西,用户以为页面卡死。PDF 渲染更要 5–48s。
2. **RDS 公网暴露 + 凭据散落**。Free-trial RDS 默认开在了 cn-hangzhou,SWAS 在 cn-shanghai,只能走公网。LLM OAuth token、RDS 密码、Aliyun AccessKey 都被读到过会话里,虽然 .env 已外部化,但 token 已经泄露到过 chat scroll。
3. **意图识别 + 超时参数写死**。前端 sendMessage 用一份"关键词白名单"决定走同步还是异步,白名单覆盖不全(`/render`、`做个 PDF`、中文 PDF 类指令漏网);codex 调用默认 60s,长 PDF 渲染直接 timeout。
4. **状态在内存里**。`/job/:id` 用的 in-memory `Map`,SWAS 重启 = 任务历史全丢,EventSource 客户端在服务重启时只能看到连接断,不知道任务是 done 还是 need-retry。
5. **没有会话/历史视角**。`/history` 已有但只是 run 级,没法看"我那次对话的整段 prompt 链",也没法 codex resume。RDS 表 `codex_runs` 只有单行,没有 session_id 维度。
6. **部署 + 凭据 + 工件是"我脑子里"**。20+ 脚本、5 份 memory、24 行 secret.env、3 张截图全部手写维护,没有 onboarding 文档,没有 skill 让新 agent 走一遍就能 ship。

**不解决的代价**: demo 演示完就散,无法作为"长期可演进"的项目存在,每次 session 1 都要重新做上下文反推。

---

## Solution

围绕"把 codex-deploy-aliyun 从一次性 demo 升级为可演示 + 可扩展的 v2 服务"这一目标,在 2–3 个 sprint 内交付以下能力(均以"用户故事"形式列出,见下)。整体方向是:

- **进度可见性** — 所有耗时操作必须能"开始就知道开始、结束才知道结束",前端不允许再出现"30s 黑屏"。
- **状态可恢复** — 任务元数据落到 RDS,内存只做实时事件 fan-out。
- **凭据 + 暴露面收口** — 先 rotate 再收网络,follow-the-sun 节奏。
- **可被并行扩展** — 6 个工作流切到 vertical slice,让多个 agent 在不同 slice 上同时推进。
- **可被新 agent 接手** — 把当前的 5 份 memory 升级成一份可导航的 docs/,加 onboarding skill。

> 详细切片方案见文末"Vertical slice 拆分"一节,作为 `/to-issues` 的输入。

---

## v1 状态基线(2026-06-12 已在 main)

下面这些能力视为 v1 的不变量,**v2 改动不允许破坏**:

### Server endpoints
| 路由 | 行为 | 关键约束 |
|---|---|---|
| `GET /` | 静态前端(same-origin 优先) | URL 不要 hardcode |
| `GET /healthz` | 服务健康度 + pdf 状态 + pg pool 状态 | 必须能 cron 探活 |
| `GET /v1info` | 服务自描述 | |
| `GET /history` | 最近 N 条 run,按时间倒序 | 来自 RDS `codex_runs` |
| `GET /history/:runId` | 单条 run 详情 | 包含 stdout/stderr 截断 |
| `POST /run` | **同步**跑 Codex CLI;返回 `{ok, exitCode, runId, durationMs, stdout, stderr}` | 默认 90s,可调到 240s |
| `POST /run-async` | **异步**;返回 `202 {jobId, statusUrl, eventsUrl}` | <50ms 返回 |
| `GET /job/:id` | 当前 job 状态 + stdout/stderr 预览 | 用于 EventSource 断线兜底 |
| `GET /job/:id/events` | SSE 流;事件类型 `snapshot/start/running/firstByte/done/error` | 25s keepalive |
| `POST /pdf`(alias `/pdf/from-url`) | body `{url, slug?}` → `application/pdf` | 3 min timeout,Python via `python3`/`python3.11` |
| `POST /pdf/upload`(alias `/pdf/from-file`) | multipart field=`file`;ext 限 `.md .markdown .html .htm` | canonical field `file` 或 `upload` |

### 数据持久化
- `codex_runs` 表(RDS PostgreSQL):`run_id, prompt, model, exit_code, duration_ms, stdout, stderr, ok, error, client_ip, created_at`。pg pool max=4, idleTimeout 30s。
- `JOBS` 内存 Map + 60min GC。**v2 会把任务元数据下沉到 RDS**,内存只做实时事件 fan-out。

### 关键代码模式(写进 ADR,不要重写)
1. **No Docker**(参见 memory `reference-deployment-gotchas` #1)
2. **codex flags**:`--ignore-user-config` + 9 个 `-c` 覆写 + `-s workspace-write` + `--ephemeral` + `--skip-git-repo-check` + `--color never`(见 `startCodexJob`)
3. **stdio** `['ignore','pipe','pipe']` + `detached: true` + `process.kill(-child.pid, 'SIGKILL')` 解决 codex 二进制脱离 Node launcher 的孤儿问题
4. **共享 `startCodexJob` helper** 是同步/异步两条路径的唯一 spawn 入口
5. **secret.env** 路径优先(不走 systemd Environment=),`/etc/codex-api/secret.env` chmod 600

### 前端不变量
- 单文件 `frontend/index.html`(~1050 行,no build)
- 同源部署,前端用空字符串做 base URL
- tablist:聊天 / PDF
- 拖拽上传到 `/pdf/upload`;URL 输入到 `/pdf/from-url`
- codex 聊天的关键词白名单(目前是 `/pdf|导出|export|render|渲染|生成.*pdf`)路由到 sendAsync + EventSource
- `crypto.randomUUID` 已 polyfill,非安全 context 也能跑

### 部署拓扑
```
[Mac dev]──scp/ssh──┐
                    ▼
              [SWAS cn-shanghai, 106.14.154.23, port 3030]
                    │
        ┌───────────┼─────────────────┐
        ▼           ▼                 ▼
   [codex CLI]  [md-to-pdf-webfirst]  [RDS PG cn-hangzhou, 公网]
   (codexsbx)   (python3.11+Chrome)   (pg pool max=4)
```

---

## User Stories

按"v2 增量需求"组织;每条都有验收标准、依赖、风险。

### Sprint 1 — 把"卡死感"和"暴露面"这两件事先收掉

#### US-1.1 关键词白名单扩展 + 中文意图识别
> As a 业务用户,I want 输入"做个 PDF"、"渲染成 PDF"、"帮我 render 一下"等变体都能自动走异步,so that 我不需要记魔法触发词。

- **触发关键词正则(新增)**:`/pdf|导出|export|render|渲染|生成.*pdf|做.*pdf|转.*pdf|弄.*pdf|\.pdf/i`
- **验收**:
  - 命中后调用 `sendAsync` 而非 `sendSync`
  - 命中失败 → 卡片显式标注"未识别为 PDF 任务,已走同步",不静默走错路
  - 提供隐藏配置项 `window.__codexAsyncKeywords`,运行时可热更新
- **依赖**:无
- **风险**:误判让普通聊天也走异步(浪费 jobId);缓解=白名单收紧为"PDF 主题词 + 至少一个动词"
- **可并行**:✅ 完全独立,纯前端,1 个 commit

#### US-1.2 异步进度条可取消 + 失败提示明确
> As a 业务用户,I want 异步卡片的"取消"按钮真的能终止后端 Codex 进程,so that 我点错后不用等 90s。

- **现状**:EventSource 关掉 ≠ 服务端 kill(child 仍在跑直到 timeout)
- **验收**:
  - 点取消 → `POST /job/:id/cancel` → 服务端 `process.kill(-child.pid, 'SIGTERM')` → 5s 内没退再 SIGKILL
  - 卡片显示"已取消 · 服务端耗时 4.2s"而非继续 loading
  - 服务端 job 状态变 `cancelled`,`/job/:id` 一次性兜底轮询也能看到
- **依赖**:无
- **风险**:重复取消 SIGKILL 已死进程 → 捕 ESRCH 即可
- **可并行**:✅ 独立,前后端各 1 个 commit

#### US-1.3 可调 timeoutSec + 前端暴露
> As a 业务用户,I want PDF 渲染时显示一个 60s/120s/300s/600s 的下拉,so that 长任务我主动选个长超时,避免被默认 60s 截断。

- **验收**:
  - 同步 `/run` 与异步 `/run-async` 的 `timeoutSec` 透传(server 已支持 max=240,扩展到 max=900)
  - 前端下拉:60s/120s/300s/600s,默认 120s
  - PDF 模式默认 300s
  - 超时实际触发时,响应里显式标 `exitCode=124` + `error="timeout"`
- **依赖**:US-1.2(取消逻辑可能复用同一种 kill helper)
- **风险**:长 timeout 占用 server slot(目前没有并发限流)→ 后续 US-2.1 加并发上限
- **可并行**:✅ 后端改 1 处,前端改 1 处,2 个 commit

#### US-1.4 长任务 EventSource 断线后能续上
> As a 业务用户,I want 我切走 tab 30 分钟回来卡片还能显示最终结果,so that 我不用守着窗口。

- **验收**:
  - EventSource 断线 → 自动重连,带 `Last-Event-ID` → 服务端从 `lastEvent.ts` 之后的 snapshot 重发
  - 超过 60min GC 窗口 → 自动降级为 `GET /job/:id` 一次性轮询,卡片显示"任务已结束,以下是最终结果"
  - `/job/:id` 必须能返回 60min 之前完成的任务(下沉到 RDS,见 US-2.2)
- **依赖**:US-2.2(任务元数据持久化)
- **风险**:EventSource 协议里 `Last-Event-ID` 兼容性 → 查 Node `http` 文档,失败则降级到 query string
- **可并行**:❌ 阻塞 US-2.2

#### US-1.5 凭据轮换工作流(runner)
> As a 项目 owner,I want 一个脚本能在 5 分钟内帮我轮换 LLM OAuth token + RDS 密码 + AccessKey + SSH key,so that 我不用记 4 个控制台。

- **验收**:
  - `scripts/rotate_credentials.sh`(新增,≤200 行,bash + `aliyun` CLI)
  - 接受 `--only llm|rds|ak|ssh|all` 参数
  - 轮换后自动重写本地 `.env`、scp 到 `/etc/codex-api/secret.env`、`systemctl restart codex-api.service`、`/healthz` 自检
  - 失败可回滚(旧值落到 `~/.credentials.bak/<ts>/`)
- **依赖**:无
- **风险**:轮换后所有旧请求失效,客户端需要带新 key → 文档化此行为
- **可并行**:✅ 独立,1 个 commit

### Sprint 2 — 状态可恢复 + 任务治理

#### US-2.1 并发限流 + 公平队列
> As a 业务用户,I want 同时开 5 个 PDF 渲染不会让 6 个慢成蜗牛,so that 多人共用 demo 也不打架。

- **验收**:
  - 全局信号量 max=3(可配置 `MAX_CONCURRENT_CODEX=3`)
  - 第 4 个请求进 FIFO 队列,卡片显示"等待中 · 队列位 1/3"
  - 队列满 → 503 + `Retry-After: 10`
  - 任务完成后释放 slot,队列下一个立即开始
- **依赖**:US-2.2(job 在 RDS 里可查)
- **风险**:信号量饥饿 → 加 max wait time 30s,超时返 503
- **可并行**:✅ 独立,后端 1 个 commit

#### US-2.2 任务元数据下沉到 RDS + 重建语义
> As a 业务用户,I want SWAS 重启后我的历史任务还能查到,so that 我可以从任意设备接着看。

- **验收**:
  - 新表 `codex_jobs(job_id PK, status, prompt, model, started_at, finished_at, duration_ms, exit_code, client_ip, last_event_ts, stdout_path, stderr_path)`
  - `JOBS.set` 时同步 INSERT(status=running);emit `done`/`error`/`cancelled` 时 UPDATE
  - stdout/stderr 落到 `/var/lib/codex-runs/<jobId>/`,路径写进 RDS,而非行内(避免 200KB 限制)
  - 内存 Map 保留 60min TTL(给 EventSource 用),之后只查 RDS
  - `/job/:id` 路由:`内存命中 → 内存数据;内存 miss → 查 RDS + 重建只读 job 对象`
- **依赖**:无
- **风险**:RDS 写入失败不能阻塞主流程 → 失败仅 log,不影响 job 状态机
- **可并行**:✅ 独立,后端 1 个 commit + 1 个 migration

#### US-2.3 job 取消 / 杀进程 helper
> As a 系统,I want 所有"杀 codex 进程"的路径都走一个 `killJobTree(pid)` helper,so that 不会再出现孤儿。

- **验收**:
  - helper 在 `server.js` 顶层,签名 `killJobTree(child, { gracefulMs=5000 })`
  - SIGTERM → 等 `gracefulMs` → 还在就 SIGKILL
  - 接受 `child === null`(job 还没 spawn)
  - 日志统一格式 `[killJobTree] job=<id> pid=<pid> sig=<TERM|KILL> reason=<user|timeout>`
- **依赖**:无
- **风险**:helper 必须早于 US-1.2/1.3 落地,否则两边各写一份
- **可并行**:✅ 独立,refactor commit(只动 server.js 内部)

#### US-2.4 codex resume 支持(接续上一次 session)
> As a 业务用户,I want 我能在上一轮 codex 跑完之后接着问"再深入分析一下",so that 我不用把 5 段 prompt 重打一遍。

- **验收**:
  - `/run` 接受 `sessionId`(来自上一次响应的 `codexSessionId`)
  - 服务端用 `codex exec resume <sessionId> <prompt>` 续接
  - 续接成功时 `codexSessionId` 回写到 `codex_runs.parent_session_id` 字段(migration 加列)
  - 续接失败(超时 / session 已 GC)→ 降级为新 session,响应里 `resumed: false` + `fallbackReason: "session_not_found"`
- **依赖**:US-2.2(需要从 RDS 查 parent session)
- **风险**:codex resume 协议可能随 CLI 版本变 → 加版本探测,unknown 版本时降级
- **可并行**:✅ 独立

### Sprint 3 — 可被新 agent 接手

#### US-3.1 onboarding skill
> As a 新接手的 agent,I want 一个 `/onboard-codex-deploy` skill 能 5 分钟带我过一遍,so that 我不用读 5 份 memory + handoff doc + 代码 1000+ 行。

- **验收**:
  - `~/.claude/skills/onboard-codex-deploy/SKILL.md` 存在
  - 5 个 step:check git → check SWAS health → run /healthz → run /run smoke → run /pdf smoke
  - 任何 step 失败给"该看哪份 memory"的具体路径
  - <10 分钟完成 happy path
- **依赖**:无
- **风险**:skill 写得过细会很快过期 → 写"如何查",不写"答案是 X"
- **可并行**:✅ 独立,1 个 commit(写到 skills 仓库,不在本仓)

#### US-3.2 worktree 自托管
> As a 多线并行的 agent,I want `git worktree add` 后能直接起一份隔离 dev stack,so that 我不用争 3030 端口。

- **验收**:
  - 复用 `worktree-self-host` skill 模式
  - FNV-1a 派生 port triple(3030+offset),offset 落在 [0, 1000)
  - `.env.local` 自动注入新端口,启动脚本写到 `scripts/dev-up.sh`(worktree 级别)
  - 关停走 pidfile,不能误杀同仓其他 worktree
- **依赖**:无
- **风险**:port 撞 3000/3001/3002 等被占 → 探测后报"换 offset"
- **可并行**:✅ 独立

#### US-3.3 chat tail 日志流(看 codex 实时输出)
> As a 业务用户,I want 异步任务跑的时候我能看到 codex 实际在输出什么,so that 我知道是卡住还是在算。

- **验收**:
  - 复用现有 EventSource 通道,新增事件类型 `codexStdout:line` / `codexStderr:line`
  - 卡片折叠区可展开"看 raw output",默认折叠
  - 行数超过 200 截断,提示"还有 N 行,点此查看完整"
- **依赖**:US-2.2(stdout 路径已落 RDS)
- **风险**:事件频率高,前端 100ms 节流
- **可并行**:❌ 阻塞 US-2.2

#### US-3.4 workspace/anonymized.html 处置决策
> As a 项目 owner,I want 那份测试 fixture 要么进 git 要么进 .gitignore,so that 仓库状态干净。

- **验收**:
  - 选项 A:`workspace/anonymized.html` 加入 git(标注 `test-fixture, anonymized 2026-05 业务诊断报告`),1 个 commit
  - 选项 B:`.gitignore` 加 `workspace/anonymized.html` 模式,1 个 commit
  - 选项 C:挪到 `workspace/fixtures/` 子目录,统一 gitignore 规则
  - 用户二选一;不允许"再观察一下"
- **依赖**:无
- **风险**:fixture 含 PII → 确认已 anonymize(已确认,见 handoff doc 第 30 行)
- **可并行**:✅ 独立,5 分钟决策

#### US-3.5 docs/ 索引页 + ADR 框架
> As a 长期维护者,I want `docs/README.md` 告诉我从哪开始读,so that 不用 5 份 memory 跳来跳去。

- **验收**:
  - `docs/README.md` 列出 4 个入口:Quick start / Architecture / Decisions / Runbook
  - 5 份 memory 的链接都映射到 docs/ 对应文件
  - 第一份 ADR:`docs/adr/0001-no-docker.md`(把 gotcha #1 沉淀成决策)
- **依赖**:无
- **风险**:docs/ 跟 memory 重复 → memory 标注"已迁到 docs/X,deprecated"
- **可并行**:✅ 独立

---

## Implementation Decisions

### 总体架构决策

1. **保持单仓 + 单文件前端**。不引入 Vite / React / 构建链。理由:SWAS 资源紧张 + demo 性质,加构建链会让"看一眼就懂"的优势消失。
2. **新功能优先"加 endpoint"而非"重构现有 endpoint"**。`/job/:id/cancel`、`/run?timeoutSec=` 等都走新路由,避免破坏现有客户端。
3. **状态机用"中心化 enum"**:`job.status ∈ {queued, running, firstByte, done, error, cancelled, timeout}`。所有 emit / DB write 走同一个 transition 函数,避免状态漂移(参考 v1 gotcha #4)。
4. **凭据永远只引用路径,不在代码 / PRD / chat 里出现明文**。所有引用走 `~/.claude/skills/aliyun-start/.env` 或 `/etc/codex-api/secret.env` 路径字符串。

### 数据模型

- `codex_jobs` 新表(US-2.2):见上文 schema
- `codex_runs.parent_session_id` 新列(US-2.4):`TEXT NULL, INDEX`
- `codex_runs.codex_session_id` 新列:从 codex CLI 输出里解析,持久化供 resume
- 不引入 Redis / 外部队列:用 PG 的 advisory lock 做信号量(US-2.1)

### API 契约(新增)

```
POST /run-async
  body: { prompt, apiKey, model?, timeoutSec? }
  resp: 202 { jobId, statusUrl, eventsUrl }
  resp: 503 { error: "queue_full" }  // 当 US-2.1 落地后
  resp: 400 { error: "bad_timeout", max: 900 }

GET /job/:id
  resp: 200 { jobId, status, startedAt, finishedAt, durationMs, exitCode, prompt, model, stdout, stderr }
  resp: 404 { error: "unknown_job" }  // 60min 之后(US-2.2 后改为走 RDS)
  resp: 410 { error: "job_gc" }  // 60min 之前,内存已 GC(US-2.2 后改为 200 with rebuilt from RDS)

POST /job/:id/cancel
  resp: 200 { jobId, status: "cancelled", killedPid: 12345 }
  resp: 409 { error: "not_running", status: "done" }
  resp: 404 { error: "unknown_job" }
```

### Schema 契约(显式列出)

| 字段 | 类型 | 约束 | 用途 |
|---|---|---|---|
| `codex_jobs.job_id` | `UUID` | PK | 与 v1 `codex_runs.run_id` 命名差异是有意的(用 job 区分"任务"和"运行") |
| `codex_jobs.status` | `TEXT` | NOT NULL, enum check | queued/running/firstByte/done/error/cancelled/timeout |
| `codex_jobs.stdout_path` | `TEXT` | NOT NULL | 文件系统路径,RDS 不存大文本 |
| `codex_jobs.last_event_ts` | `BIGINT` | NOT NULL | Last-Event-ID 续接用 |
| `codex_runs.codex_session_id` | `TEXT` | NULL, INDEX | US-2.4 resume 用 |
| `codex_runs.parent_session_id` | `TEXT` | NULL, INDEX | US-2.4 链式 resume |

### 错误分类(沿用 v1 B1)

5-bucket:`SSL / DNS / 4xx-5xx / timeout / no-output / other`,新增第 6 类 `cancelled`(US-1.2)。

---

## Testing Decisions

### 原则
- **只测外部行为**。HTTP 客户端角度的契约 + DB 行存在性 + 进程副作用(stdout 文件落地、子进程被杀)。不测内部函数。
- **每个 user story 必须有一条 e2e smoke**。Sprint 结束前由 1 个 agent 全量跑一遍。

### 模块 vs 测试

| 模块 | 测试方式 | 触发频率 |
|---|---|---|
| `server.js` HTTP 路由 | `node test/<route>.sh` curl 脚本 | 每个 US 落地后立即跑 |
| `codex_jobs` 表 schema | `test/db/migrations.test.sh` | migration 应用时 |
| EventSource 流 | Playwright(headless)接入 `/job/:id/events`,断言事件序列 | US-1.4 / US-3.3 |
| codex 杀进程 | `test/kill-tree.test.sh` 启一个 60s sleep 子进程,触发 cancel,断言 5s 内死 | US-1.2 / US-2.3 |
| 凭据轮换 | 写一个 mock `aliyun` CLI,断言脚本调对 API + 落对文件 | US-1.5 |

### 既有测试资产
- `scripts/probe_codex.sh` — 探活 `/run`,2s 出结果
- `scripts/probe_codex_timing.sh` — 探活并打 timing 字段
- `scripts/check_build.sh` — 静态体检
- 3 个 e2e smoke 路径(URL / drag-drop .md / drag-drop .html)在 handoff doc 第 28-30 行有记录

### 关键 acceptance 测

- US-1.4 断线重连:Playwright 脚本 `test/sse-reconnect.spec.js`,显式 `eventSource.close()` 后重连,断言 `Last-Event-ID` 生效
- US-2.4 codex resume:`codex exec resume <sid> "follow-up"` 跑通,`codexSessionId` 沿用

---

## Out of Scope

v2 不会做:

- **多租户 / 用户登录**。demo 仍以 `SHARED_SECRET` 单密钥访问;真实用户体系留到 v3。
- **计费 / 配额可视化**。`/v1info` 不暴露用户级 usage;LLM 侧走 NewCLI 自带 dashboard。
- **GPU / 更大模型**。codex 0.139.0 锁的是 `gpt-5.5-fast`(`gpt-5.4-fast` 降级);不做模型层扩展。
- **HTTPS / 自定义域名**。SWAS 走 80/443 默认;不申请 SSL 证书。
- **CI / GitHub Actions**。`CLAUDE.md` 强制 atomic commit + 立即 push 即"CI",不再叠 PR 流程。
- **RDS region 迁移**。这是 US-1.5 凭据轮换之外的独立话题,留到 v3:US-3.x "RDS region move to cn-shanghai"。

---

## Further Notes

### 已知风险(必须在 sprint 边界评估)

1. **RDS 公网暴露未收口**(v1 session 1 起的 open item #1)。`codex_runs` 表还在用公网连接。一旦被 yundun 二次警告,`/history` 全部 503。**US-1.5 凭据轮换 + US-2.x "RDS region 迁移"** 是这一风险的两个缓解路径。
2. **SWAS 6-29 到期 + RDS 7-11 到期**。30 天内必须续费或迁走。决策点不在本 PRD 范围。
3. **codex 0.139.0 行为变更**。CLI 升级可能改 `--yolo` / `-c` 语义;`scripts/fix_state_drift.sh` 已记录当前 workaround。
4. **前端单文件超过 1000 行**。`frontend/index.html` 已 1050 行,US-1.1/1.2/1.3/3.3 每个会再加 30~80 行,接近 1500 行。**v3 之前的最后手段**是拆出 `frontend/pdf.js` / `frontend/chat.js`,用 `<script src>` 拼接。不破坏 no-build 约束。

### 与 v1 决策的一致性(不重写原则)

- **不要引入 Docker**(gotcha #1)
- **不要 hardcode 前端 URL**(gotcha #9)
- **不要把 secret 写进代码 / PRD / chat**(memory `reference-credentials-location`)
- **不要把 stdout/stderr 直接塞 RDS**(本次 US-2.2 显式改成文件路径)
- **不要依赖 systemd Environment=** 注入 secret(走 `/etc/codex-api/secret.env` 直接 readFileSync)

### Vertical slice 拆分(给 `/to-issues` 用)

> 5 个 slice,所有 slice 都不跨 sprint 边界;同一 sprint 内可并行。

| Slice | 包含 US | 期望 commit 数 | 可并行? |
|---|---|---|---|
| **S1A: Frontend polish** | US-1.1, US-1.2, US-1.3, US-3.3 | 4 | ✅ 与 S1B/S1C 并行 |
| **S1B: Backend kill + timeout** | US-1.3(后端), US-2.3 | 2 | ✅ 与 S1A/S1C 并行 |
| **S1C: Security & onboarding** | US-1.5, US-3.1, US-3.5, US-3.4 | 4 | ✅ 与 S1A/S1B 并行 |
| **S2A: Persistence** | US-2.2, US-1.4 | 2 + 1 migration | ✅ 与 S2B 并行(US-2.4 阻塞 S2B) |
| **S2B: Concurrency + Resume** | US-2.1, US-2.4 | 2 | ❌ 阻塞 S2A 完成后 |
| **S3: Workspace & docs** | US-3.2 | 1 | ✅ 任意时刻可起 |

**建议并行组合(Sprint 1)**:S1A + S1B + S1C 三个 agent 同时开;Sprint 2 收 S2A,S2A 落地后开 S2B;S3 在任意空闲时段穿插。

### 不进 PRD 的小修(单独 issue / commit)

- 同步 `python3` vs `python3.11` 差异(handoff doc #3)
- `/dev/shm` contention(handoff doc #6)
- Mac LibreSSL 升级(handoff doc #7)

### 关联文件
- `docs/PRD-v2.md`(本文件)
- `docs/issues/`(将由 `/to-issues` 生成)
- 5 份 memory 文件(本 PRD 不复述,仅链接)
- `/tmp/codex-deploy-handoff-2026-06-12.md`(v1 baseline + open item 原文)

---

*Written 2026-06-12 by MiniMax-M3 (Claude Code) — codex-deploy-aliyun v2 PRD,基于 v1 状态基线 + 会话交接 7 个 open item + 2-3 sprint 路线图。*
