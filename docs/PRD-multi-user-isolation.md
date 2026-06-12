# PRD: Multi-user isolation with RDS as the source of truth

> **Status:** draft · **Owner:** codex-deploy-aliyun · **Created:** 2026-06-12
> **Source intent:** "implement multi-user isolation with database as storage. 目标:把当前 demo 里的共享状态(运行历史、PDF 任务、Codex CLI 沙箱结果)从单租户/本地文件改成按 user_id 隔离 + 落库到 RDS PostgreSQL,保证不同调用方看不到对方的数据,所有读路径都走 DB。"
> **Replaces:** `docs/PRD-v2.md` 中所有"无 user 概念" / "DEMO_SECRET 是唯一鉴权" 的隐含假设。
> **Depends on:** migrations 001 (`codex_jobs`) + 002 (`codex_runs` session id) 已经在 prod;本 PRD 向下兼容,新增 user_id 列后老行为靠 `user_id IS NULL ⇒ 系统用户可见/写` 的回退保留。

---

## §0 Context — why this PRD exists

`codex-deploy-aliyun` 现在的鉴权模型是"全局一把钥匙":

- `SHARED_SECRET = process.env.DEMO_SECRET` — 设了之后所有路由都要么 `x-demo-key` 要么 `?key=…` 命中,要么 401。没设就是公开,跟 v1 demo 一致。
- 没有"user"概念。`codex_runs.client_ip`、`codex_jobs.client_ip` 记录的是 IP,**不是**用户身份。
- `/job/:id/events` 的 D-route 隔离(`reqClientIp(req) === job.clientIp`)是用 IP 当 ownership,这个粒度要么太粗(NAT 后面一群人撞一个 IP),要么太细(同一用户在 WiFi / 4G 切换会被踢)。
- `/history` 直接 `SELECT … ORDER BY created_at DESC LIMIT 50` — 任何人只要拿到 DEMO_SECRET 就能看到所有用户的全部 run。`/history/:runId` 同理。
- `/pdf/oss/:slug` 和 `/pdf/file/:slug` 是按 slug 寻址 — 拿到 slug 的人(日志、referer、剪贴板)就能拉到别人的 PDF。OSS URL 缓存也是进程级共享 Map。
- 进程级 `JOBS` Map 是 60 min 内的真相源(TTL 后依赖 RDS `codex_jobs` 表回填),RDS 只是备份。这跟"DB 是 source of truth"相悖。
- 前端 `cfg.apiKey` 是 LLM OAuth key(给 `codex exec` 用的),不是 codex-api 自己的用户 token。

本 PRD 要做的就是引入 **user identity** 维度,把上面这些"共享/全局/按 IP" 的鉴权与存储都改成 **per-user** + **RDS 为真相源**。同时保留 v1 demo 的"一把全局钥匙" 行为(升级为 system user),不破坏现有 curl 流程。

---

## §1 Goals

- **G1.** 引入 `users` 表(per-row api_token)+ `resolveUser(req)` 中间件,把"user 是谁"这个事实从 IP/全局 secret 提到 schema 与中间件两层。
- **G2.** `codex_runs` 与 `codex_jobs` 都加 `user_id` 列(可空,回填老数据为 NULL = system);`/history`、`/history/:runId`、`/job/:id`、`/job/:id/events`、`/job/:id/cancel` 全部按 `req.user.id` 过滤;`DEMO_SECRET` 命中时视作 system user,可见/可管所有数据。
- **G3.** `/pdf/*` 的本地落盘与 OSS 上传都按 user_id 切片:本地 `/tmp/codex-pdf-out/<userId>/<slug>.pdf`,OSS key 前缀 `pdfs/<userId>/2026/06/<slug>.pdf`;`OSS_URL_CACHE` 从 `Map<slug, …>` 变 `Map<userId, Map<slug, …>>`。`/pdf/oss/:slug` 与 `/pdf/file/:slug` 加 creator 校验,非 owner 一律 403。
- **G4.** RDS 是 source of truth。`JOBS` in-memory Map 退化为 60 min 缓存;`/job/:id` 命中内存就回,内存 miss 直接走 `loadJobFromRds`(已有路径),并按 user_id 鉴权。
- **G5.** 现有所有 v1 demo 调用方式(`curl /run`、`curl /pdf/from-url`、前端 `cfg.apiKey`)继续工作 —— 通过 system user + 旧的 `DEMO_SECRET` / `LLM_OAUTH_KEY` 路径保留。
- **G6.** 并发信号量 `MAX_CONCURRENT_CODEX` 保留为全局上限;新增 `MAX_CONCURRENT_PER_USER`(默认 1,env 可调),超出的请求走 per-user FIFO 子队列,跟全局信号量合流(逻辑跟 ISSUE-013 的 `tryAcquireSlot` 同形)。

---

## §2 Non-goals (out of scope for this PRD)

- **NG1.** 不改 LLM 网关鉴权。`/run` body 里的 `apiKey` / `openaiApiKey` 仍然是 LLM OAuth key(给 `codex exec` 用),跟 codex-api 自身的 user token 解耦。
- **NG2.** 不做 user 注册流程 / 邮件验证 / 密码管理。本 PRD 假设 user 由 admin 通过 `POST /admin/users` 创建,token 通过 side-channel 发放(console/IM/secret store)。
- **NG3.** 不做 billing / quota 计费 / rate-limit 计费。`MAX_CONCURRENT_PER_USER` 是并发上限,不是费用上限。
- **NG4.** 不做跨 user 共享(`share this PDF with user X`)。owner-only 拉取。
- **NG5.** 不动 SWAS / RDS 的部署拓扑、不重建 OSS bucket。RDS 公开端点、SWAS 续期决定保持现状(`CLAUDE.md` 已声明)。
- **NG6.** 不替换 `JOBS` in-memory Map 的 60-min TTL 设计(它是性能优化,不是真相源);不替换 `recordRun` / `insertCodexJob` 的 best-effort 双写模式。
- **NG7.** 不把 system user 的能力下沉到某个具体 person;system user 就是 `DEMO_SECRET` 命中时的身份,生命周期 = secret 生命周期。
- **NG8.** 不做 user 删除的级联清理(user delete 是个独立的 admin 工具,本 PRD 只保证 delete 后旧 run 的 user_id 变 NULL,行为退化为 system 可见)。

---

## §3 User stories

### §3.1 — 身份与 token

- **US-1.1.** As an **admin** (持有 `DEMO_SECRET`), I can call `POST /admin/users` with `{ name, label? }` and receive `{ id, name, apiToken }`, so that I can mint a new user in one round-trip.
- **US-1.2.** As an **admin**, I can call `GET /admin/users` and see every user row(id / name / createdAt / lastUsedAt), so that I can audit who exists.
- **US-1.3.** As a **caller**, I can pass my token as `Authorization: Bearer <token>` (or `X-Codex-User: <token>` for EventSource 兼容性) on any request, and the server resolves me to a user row, so that all subsequent persistence and access checks are mine.
- **US-1.4.** As a **caller**, I can `curl -H 'Authorization: Bearer sk-cdx-…' http://…/healthz` and see my `userId` echoed back, so that I can verify the token works without firing a real run.
- **US-1.5.** As a **caller with no token and no `DEMO_SECRET` set**, I still get a `200 / 401?` consistent with v1 demo behavior — the server returns a stub `system` user instead of a hard 401, so that the v1 "open demo" path keeps working when `DEMO_SECRET` is empty.
- **US-1.6.** As a **caller with an invalid/expired token**, I receive `401 { ok:false, error:"unauthorized", reason:"token_invalid" }`, so that I know to re-mint.
- **US-1.7.** As an **admin**, I can call `POST /admin/users/:id/revoke` and the row's `revoked_at` is set; subsequent calls with that token get 401 `token_revoked`, so that I can retire a leaked token without dropping the user.

### §3.2 — Run / job 数据隔离

- **US-2.1.** As **Alice**, when I `POST /run` (or `/run-async`), the `codex_runs` row and the `codex_jobs` row are written with `user_id = alice.id`, so that `recordRun` and `insertCodexJob` carry my identity.
- **US-2.2.** As **Alice**, when I call `GET /history?limit=50`, I see only my runs (and **no** runs owned by other users), so that `/history` stops being a global feed.
- **US-2.3.** As **Alice**, when I call `GET /history/:runId` for a run that I do not own, I get `404 not_found` (not `403` — we don't leak existence), so that the existence of other users' runs is not discoverable.
- **US-2.4.** As **admin** (system user), when I call `GET /history?limit=50`, I see every user's runs interleaved in `created_at DESC` order, so that the existing admin use case keeps working.
- **US-2.5.** As **Alice**, when I call `GET /job/:jobId` for a job I own, the status payload is returned normally; for a job I do not own, I get `404 not_found`, so that job-id guessing is harmless.
- **US-2.6.** As **Alice**, when I open `EventSource('/job/:jobId/events')` for my job, the live stream connects; for someone else's jobId, I get `403 forbidden: not the job creator`, so that the D-route IP check (existing) is upgraded to user-id check.
- **US-2.7.** As **Alice**, when I call `POST /job/:jobId/cancel` for my job, the cancel succeeds; for someone else's jobId, I get `404 not_found`, so that cancel is owner-only.
- **US-2.8.** As **Alice**, when I resume a session via `POST /run { sessionId: <mine> }`, it works; when I try to resume another user's `codexSessionId`, the request is accepted (resume is a codex-level concern), but the `codex_runs` row written is **mine** with `parent_session_id` set, so that the cross-user resume is logged as a fork, not a takeover.
- **US-2.9.** As **Alice**, when my `MAX_CONCURRENT_PER_USER` slots are full, the next `/run-async` request joins **my** FIFO queue (not the global one), and I get `202 queued` with `queuePosition: 1`; another user submitting concurrently is not blocked by my queue, so that one user's slow run cannot starve another user.

### §3.3 — PDF 数据隔离

- **US-3.1.** As **Alice**, when I `POST /pdf/from-url`, the produced PDF is written to `/tmp/codex-pdf-out/<userId>/<slug>.pdf` and uploaded to OSS with key `pdfs/<userId>/<yyyy>/<mm>/<slug>-<ts>.pdf`, so that the path is namespaced by me.
- **US-3.2.** As **Alice**, when I call `GET /pdf/oss/:slug` for a slug I own, the cached `ossKey` is re-presigned; for a slug another user uploaded, I get `404 not_found`, so that PDF lookup is owner-scoped (not slug-global).
- **US-3.3.** As **Alice**, when I call `GET /pdf/file/:slug` for my own slug, the local PDF streams; for another user's slug, I get `404 not_found`, so that the local-fs fallback is also owner-scoped.
- **US-3.4.** As **Alice**, when I `POST /pdf/upload`, the multipart file is written to a per-user tmp dir `/tmp/codex-pdf-up/<userId>/…` and the per-user output dir is the same as US-3.1, so that an upload + a from-url render for the same slug don't collide across users.
- **US-3.5.** As **Alice**, when I drag-drop a `.md` in the chat UI, the upload goes through `/pdf/api/convert` (existing v1 path) with my `Authorization` header, and the returned PDF is mine, so that the frontend UX keeps working end-to-end.
- **US-3.6.** As **Alice**, when I click "open PDF" in the chat, the URL the frontend uses is `/pdf/file/<slug>` **plus** my `Authorization` header (or it 404s), so that the link is owner-bound by header, not by guessing.
- **US-3.7.** As **admin**, when I look at `/tmp/codex-pdf-out/`, I see one subdir per user, and the per-user count is queryable via `psql -c "SELECT user_id, count(*) FROM pdf_jobs GROUP BY user_id"` (new table), so that admin ops can audit disk usage per user.

### §3.4 — Source-of-truth 迁移

- **US-4.1.** As **Alice**, when the server restarts mid-run, my in-flight `/job/:id` and `/job/:id/events` still resolve correctly from RDS (no in-memory dependency), so that restart doesn't lose my visibility into my own jobs.
- **US-4.2.** As **Alice**, when a job I queued > 60 min ago is GC'd from the in-memory Map, `GET /job/:id` still returns the latest RDS snapshot for me (status, prompt, finished_at, stdout_path tail), so that the 60-min TTL is a cache eviction, not a data loss.
- **US-4.3.** As **Alice**, my completed run's stdout/stderr are reachable through `GET /job/:id` (RDS path) even after the workdir `/var/lib/codex-runs/<runId>/` is GC'd, because the RDS row stores the path and the file is preserved N days (existing behavior, no change) — *not a new requirement, just a regression guard*.
- **US-4.4.** As **admin**, when I run `scripts/rds-migrate.sh --status`, the new user-scoped migrations (`003_codex_runs_user_id`, `004_codex_jobs_user_id`, `005_users`, etc.) show up in the pending/applied list, so that deploy-time ordering is mechanical.
- **US-4.5.** As **admin**, the `rds-migrate.sh --ssh` path still works for the cn-hangzhou free-trial RDS, so that the SSH-bridge deploy path is unbroken by this PRD.

### §3.5 — 前端 / 集成

- **US-5.1.** As **Alice**, in the chat UI "设置" panel, I can paste my `userToken` (received from admin) and it persists in `localStorage` next to `cfg.apiKey`; subsequent calls carry `Authorization: Bearer <userToken>`, so that the UI is multi-user ready.
- **US-5.2.** As **Alice**, the chat UI's history list, async job list, and PDF "open" buttons all fetch with the token, so that the user never sees another user's history in the panel.
- **US-5.3.** As **admin (system)**, I can still leave the token field empty and the UI keeps working in v1 demo mode (system user is implied by `DEMO_SECRET` on the server), so that the public-demo URL `http://106.14.154.23:3030/` keeps the "no login" affordance.
- **US-5.4.** As **Alice**, when my token is invalid, the UI shows a single toast "Token rejected — contact admin" and the chat input is disabled (no zombie calls), so that misconfigured tokens fail loudly, not silently.

### §3.6 — 反模式 / 防御

- **US-6.1.** As **a reviewer of this PRD**, I can find an anti-pattern section that says "do NOT key anything by `client_ip` for ownership; `client_ip` is a soft hint, not identity", so that the next agent doesn't regress to IP-based isolation.
- **US-6.2.** As **a reviewer**, I can find a list of tests that prove the isolation: two concurrent `curl`s with two different tokens cannot see each other's `/history`, `/job/:id`, or `/pdf/oss/:slug`, so that the contract is verifiable.
- **US-6.3.** As **admin**, a `mock:audit` issue exists that runs `rg 'clientIp|client_ip' server/` and flags any new use outside the legacy logging column, so that the IP-vs-user drift is caught at the gate.

---

## §4 API contract (additive, backward compatible)

### §4.1 New routes (gated by `DEMO_SECRET` only — admin)

```
POST /admin/users
  body:  { name: string, label?: string }
  resp:  201 { id, name, label, apiToken, createdAt }
         409 if name is taken
         401 if DEMO_SECRET is unset or wrong

GET /admin/users
  resp:  200 { ok, users: [{ id, name, label, createdAt, lastUsedAt, revokedAt }] }

POST /admin/users/:id/revoke
  resp:  200 { ok, revokedAt }

GET /admin/users/:id/stats
  resp:  200 { ok, runs, jobs, pdfs, queued }
```

### §4.2 Identity resolution (every existing route)

`resolveUser(req)` is a new middleware that runs at the top of the request pipeline (after CORS, before route dispatch). It returns one of three results, in this order:

1. **`SHARED_SECRET` (i.e. `DEMO_SECRET`) present and `req.headers['x-demo-key'] === SHARED_SECRET` OR `?key=… === SHARED_SECRET`** → `{ id: 'system', name: 'system', isSystem: true }`. Bypasses per-user filters on every read.
2. **`Authorization: Bearer <token>` OR `X-Codex-User: <token>`** → look up `users.api_token` (with `revoked_at IS NULL`); on hit, update `last_used_at = now()`; on miss, 401.
3. **`SHARED_SECRET` is empty** (v1 demo mode) → fall through as `{ id: 'system', name: 'system', isSystem: true }`. Keeps the open-demo behavior.

Failure mode: when `SHARED_SECRET` is **set** AND no token AND no matching `x-demo-key` AND no `?key=…` → `401 { ok:false, error:'unauthorized', reason:'no_token' }`. This is a **behavior change** from today's "401 if SHARED_SECRET mismatches"; today's `checkAuth` returns `true` when SHARED_SECRET is empty, so this path was already gated. The new path adds: a token is also required. **Curl examples that worked today keep working** because they pass `?key=$DEMO_SECRET` (system user).

### §4.3 Modified routes (read paths add `WHERE user_id = $req.user.id`)

| Route | Change |
|---|---|
| `GET /history` | `… WHERE user_id = $user OR $user.isSystem` |
| `GET /history/:runId` | `… AND (user_id = $user OR $user.isSystem)`; 404 on miss (no 403 — see US-2.3) |
| `GET /job/:id` | same `… AND (user_id = $user OR $user.isSystem)` on the `loadJobFromRds` fallback; in-memory hit filters by job.userId (set at makeJob time) |
| `GET /job/:id/events` | upgrade today's `clientIp` check to `job.userId === req.user.id \|\| req.user.isSystem` |
| `POST /job/:id/cancel` | same ownership check |
| `POST /run` (sync) | write `codex_runs.user_id` and pass through to recordRun |
| `POST /run-async` | write `codex_jobs.user_id` and `codex_runs.user_id` (when recordRun fires at close) |
| `POST /pdf/from-url` | write PDF to per-user dir; key OSS object under `pdfs/<userId>/…`; record `pdf_jobs` row with `user_id` (new table, see §5) |
| `POST /pdf/upload` | same; per-user tmp dir |
| `POST /pdf/api/convert` | same; per-user |
| `GET /pdf/oss/:slug` | look up in `OSS_URL_CACHE[userId]`, miss → 404 |
| `GET /pdf/file/:slug` | resolve path under `/tmp/codex-pdf-out/<userId>/<slug>.pdf`, miss → 404 |

### §4.4 New `pdf_jobs` table (per-user PDF audit, optional but recommended)

```sql
CREATE TABLE pdf_jobs (
  pdf_slug   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,            -- 'from-url' | 'from-upload' | 'from-convert'
  source     TEXT NOT NULL,            -- URL or local path
  oss_key    TEXT,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pdf_jobs_user_id_idx ON pdf_jobs(user_id, created_at DESC);
```

Used for the admin stats endpoint (US-1.4) and the per-user disk-usage audit (US-3.7). Inserted in the runner callback for both sync and async PDF paths.

### §4.5 Migration order (apply with `scripts/rds-migrate.sh --ssh`)

```
003_users.sql                 -- CREATE TABLE users + api_token
004_codex_runs_user_id.sql    -- ADD COLUMN user_id, backfill NULL = 'system'
005_codex_jobs_user_id.sql    -- ADD COLUMN user_id, backfill NULL = 'system'
006_pdf_jobs.sql              -- CREATE TABLE pdf_jobs (US-3.7)
```

All idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`). All wrap in `DO $$ … $$` for the ADD COLUMN (same pattern as `002_codex_runs_session.sql`).

---

## §5 Architecture (the meat)

```
                ┌──────────────────────────┐
client  ──POST─▶│  /run | /run-async | /pdf│
  Authorization: Bearer <token>          │
  x-demo-key: <DEMO_SECRET>  (system)    │
                └────────────┬────────────┘
                             ▼
                ┌──────────────────────────┐
                │  resolveUser(req)         │  ← NEW middleware
                │  1. system via DEMO_SECRET│
                │  2. user via api_token    │
                │  3. system if no secret   │
                └────────────┬────────────┘
                             ▼ req.user = { id, name, isSystem }
                ┌──────────────────────────┐
                │  route handler            │
                │  (handleRun / handlePdf…) │
                │  + user_id tag on every   │
                │    INSERT / UPDATE        │
                └────────────┬────────────┘
                             ▼
                ┌──────────────────────────┐
                │  RDS PostgreSQL           │  ← source of truth
                │  codex_runs.user_id       │
                │  codex_jobs.user_id       │
                │  pdf_jobs.user_id         │
                │  users.api_token          │
                └────────────┬────────────┘
                             ▼ (best-effort read cache)
                ┌──────────────────────────┐
                │  in-memory Map            │  ← 60-min TTL cache
                │  JOBS: jobId → job        │  ← job.userId
                │  OSS_URL_CACHE:           │
                │    userId → slug → oss    │
                └──────────────────────────┘
```

**Key decisions**

- **`users.id` is TEXT, not UUID.** Generated as `cdx_<nanoid>` (e.g. `cdx_aB12cD34`) for two reasons: (a) admin can read it over voice/IM without dashes; (b) `cdx_` prefix lets the audit log regex `^cdx_[A-Za-z0-9]+$` distinguish user-id from `runId` (UUID) at a glance.
- **`api_token` is hashed (sha256), stored hashed, compared hashed.** The plaintext token is returned exactly once at `POST /admin/users` creation. The DB never sees the plaintext again.
- **`SHARED_SECRET` system user is `id='system'`** — never a real user row. `codex_runs.user_id` of `'system'` is the backfill for legacy rows.
- **Per-user concurrency is a child semaphore.** The global `MAX_CONCURRENT_CODEX` is the hard wall; the per-user semaphore is checked second. New code structure: `tryAcquireGlobalSlot()` then `tryAcquireUserSlot(userId)`. If user is full, the request enters a per-user FIFO queue keyed by userId. The existing `waitForSlot` is generalized to carry a userId context.
- **`OSS_URL_CACHE` becomes `Map<userId, Map<slug, …>>`.** The TTL eviction runs per (userId, slug) pair; system user can still see legacy uploads (legacy key path lookup tries `system` first, then per-user — see US-3.2 nuance for the back-compat shape).
- **`PDF_OUTPUT_DIR` becomes per-user subdir.** Backward-compat shim: the first time the server boots with the new code, it walks `PDF_OUTPUT_DIR` and moves any loose `<slug>.pdf` into `PDF_OUTPUT_DIR/system/<slug>.pdf` (system-user backfill). Idempotent: if `system/` already has the file, skip.
- **Frontend `cfg.apiKey` stays for LLM OAuth key; add `cfg.userToken` for codex-api identity.** Two separate things, two separate fields, two separate `Authorization` vs body semantics.
- **`recordRun` failure semantics unchanged.** If RDS is down, the run still returns 200 to the user; persistence is best-effort. New: when the failure is a `user_id` constraint violation (it shouldn't be — `'system'` is always valid), we log + drop the user_id to NULL and retry once.

---

## §6 Constraints & risks

- **C1.** `codex_runs` 表是 `recordRun` **隐式** `INSERT` 创建的(server.js 没有对应的 `CREATE TABLE` migration)。在本 PRD 落地前需要一次 `007_codex_runs_explicit_create.sql` migration 显式 `CREATE TABLE IF NOT EXISTS codex_runs (...)` 把 schema 钉死(否则后续加列会 race)。—— 这是先决条件,不是本 PRD 的可选项。
- **C2.** The v1 demo URL `http://106.14.154.23:3030/` 上的 curl 调用 `?key=$DEMO_SECRET` 必须继续工作。本 PRD 默认 system user 的 `name='system'`,`isSystem=true` 路径下所有 read 行为跟今天一致。
- **C3.** `DEMO_SECRET` 是单把钥匙。多人持有 system 钥匙时会看到彼此的数据(因为 system 不过滤)—— 这是保留的 v1 demo 行为,本 PRD 不解决 system-user 内部的隔离。admin 应该把 system 钥匙分给可信 ops,不是给 end user。
- **C4.** Token 泄露。如果一个 end-user token 泄露,admin 用 `POST /admin/users/:id/revoke` 即可吊销,**老 run 数据的 user_id 保留**(不级联,只把 `revoked_at` 填上),owner 行为变 NULL = system(以保留审计可读性)。
- **C5.** SWAS 续期(2026-06-29)+ RDS 续期(2026-07-11)。本 PRD 落地时按 17 天 SWAS 剩余寿命倒排;任何依赖新增列 INDEX 的回滚路径都按"ALTER TABLE 已经下盘"为基线,不要在续期前重做一次大 schema 变更。
- **C6.** `codex_cli` 进程是按 UID `codexsbx` 跑的(全 SWAS 一个 UID)。**`/var/lib/codex-runs/<runId>/` 物理上**是所有 user 共享的(每个 run 一个目录,codexsbx 是 owner);**逻辑上**(用路径 + DB 关联)按 user 隔离。本 PRD 不为 codex 进程引入 per-user UID(成本太高,跟 `startCodexJob` 的现有 `uid: SANDBOX_UID` 不兼容)。
- **C7.** `codex_cli` 接收的 `codexSessionId`(thread id)是 codex 内部的 thread 标识,跟 user 无关。`codex_runs.codex_session_id` **不** 加 user_id 复合唯一约束(codex 的 thread id 是全局唯一的,user 隔离靠 `codex_runs.user_id`)。US-2.8 的"另一个 user 用我的 sessionId 续接" 是允许的,只是会被记成 **他** 的 run + `parent_session_id=我的 runId`。
- **C8.** 并发信号量从全局 → "全局 + per-user" 双层,会让 wall-clock 行为变。在压测下,如果 global 满 + per-user 队列被某 user 慢请求占满,新请求即使来自其他 user 也会被卡 30s 后 503。这跟 ISSUE-013 的"全队满"是同形行为,不是 regression。

---

## §7 Testing decisions

### §7.1 What makes a good test

- **External behavior only.** Test the HTTP surface (status, JSON body, header echo). Do not test `pgPool.query` strings, in-memory Map shapes, or SSE event payloads beyond what's documented in the API contract.
- **Two-user scenarios.** The interesting tests are *cross-user* — Alice can / cannot see Bob's data. A single-user happy-path test is necessary but not sufficient.
- **Idempotency on the migration ledger.** `scripts/rds-migrate.sh` applied twice in a row is a no-op; `ADD COLUMN IF NOT EXISTS` works on a pre-existing column.

### §7.2 Seams (highest first)

- **Seam 1 (highest).** End-to-end HTTP via `curl` against the live SWAS: two minted tokens, two concurrent runs, cross-user `/history` / `/job/:id` / `/pdf/oss/:slug` attempts. Recorded in `docs/issues/<N>-e2e-multi-user.md` as a Playwright + curl script.
- **Seam 2.** Integration test in `tests/multi-user.test.js` that boots `server.js` with a fresh schema (per-test `CREATE SCHEMA` + drop), mints two users via `/admin/users`, runs the full surface, and asserts cross-user isolation. This is the gate for `mock:audit` to close.
- **Seam 3.** Unit test for `resolveUser(req)` in isolation: token shapes, header echoes, system fallback. Fast, no DB.

### §7.3 Prior art (existing tests we should mirror)

- `tests/e2e_pdf_async.sh` — bash script that hits live SWAS. Same pattern for the multi-user smoke.
- `migrations/002_codex_runs_session.sql` — `DO $$ … IF EXISTS … ALTER … ADD COLUMN IF NOT EXISTS` block. All new migrations follow this.
- `issue 005-kill-job-tree-helper.md` — showed that the D-route IP check (`reqClientIp === job.clientIp`) can be lifted to a user-id check by the same shape. Issue 005's lessons list is a good template for "things the next agent should not regress".
- `scripts/rds-migrate.sh --status` — the migration ledger. Any new migration shows up here; the new flow tests `003_users.sql` → `004_*` → `005_*` → `006_pdf_jobs.sql` in order, idempotent.

### §7.4 New tests we add (concrete list)

| Test | Type | What it proves |
|---|---|---|
| `tests/multi-user.resolve.test.js` | unit | `resolveUser` returns system / user / 401 in all 6 input shapes |
| `tests/multi-user.history.test.js` | integration | Alice's `/history` excludes Bob's runs; admin's `/history` shows both |
| `tests/multi-user.job-events.test.js` | integration | Alice's EventSource to Bob's jobId → 403; Alice's to her own → 200 |
| `tests/multi-user.pdf.test.js` | integration | Alice's `/pdf/oss/<bob-slug>` → 404; her own slug → 200 with presign |
| `tests/multi-user.concurrency.test.js` | integration | Alice + Bob both at MAX_CONCURRENT_PER_USER; Alice's queue does not block Bob |
| `tests/multi-user.migrations.test.js` | integration | `scripts/rds-migrate.sh --ssh` applies 003..006 in order, idempotent on re-run |
| `scripts/e2e_multi_user.sh` | e2e | Two tokens + curl + jq assertions on the live SWAS — the "ship" gate |

---

## §8 Out of scope (recap of §2 + the explicit deferrals)

- Billing / quota / rate-limit.
- User registration / password reset / email verification.
- Cross-user sharing / "share this PDF with X".
- Per-user UID for the `codexsbx` sandbox.
- Token rotation UI (the rotation script `scripts/rotate_credentials.sh` exists; this PRD doesn't touch it).
- Migration of legacy OSS objects already uploaded without a `userId` prefix (they stay readable via system user; admin can backfill via `psql` one-off).
- Replay of historical runs (the `codex_runs` table already has rows with `user_id IS NULL`; backfill to `'system'` is the only write this PRD does on historical data, and it's mechanical).

---

## §9 Open questions

- **OQ-1.** Token storage on the client: should `cfg.userToken` be `localStorage` (current proposal) or session-only `sessionStorage`? Default: `localStorage` matches the existing `cfg.apiKey` shape; if the user wants stricter, US-5.1 can be amended.
- **OQ-2.** Token expiry. The PRD's `users` table has no `expires_at`. Minted tokens live until revoked. Alternative: add `expires_at` defaulting to 90 days; admin mints a new one when needed. Default for this PRD: no expiry (admin sets it via the `revoke` flow); a follow-up issue can add expiry if needed.
- **OQ-3.** PDF object key backfill for legacy uploads. The `OSS_URL_CACHE` lives in-process; on a restart, all entries are gone. Should the new `pdf_jobs` table also be the durable lookup, with `OSS_URL_CACHE` becoming a write-through cache? Default: yes — `pdf_jobs.oss_key` is the source of truth, cache is for hot-path re-presign. If `pdf_jobs.oss_key` is set but cache miss, re-presign from the DB row.
- **OQ-4.** Per-user quota beyond concurrency. Today's code has no `MAX_RUNS_PER_USER_PER_DAY`. The PRD adds concurrency; a per-user daily run cap is a follow-up.
- **OQ-5.** CORS posture. Today `Access-Control-Allow-Origin: *`. With user tokens, we should narrow to known frontend origins. Default for this PRD: keep `*` (it's a demo); narrow in a follow-up issue if the user wants a hardened posture.

---

## §10 Anti-patterns (for whoever picks this up)

- **AP-1.** Do NOT use `client_ip` as the ownership / isolation key. `codex_runs.client_ip` and `codex_jobs.client_ip` are **soft hints for log analysis only**, never for access control. If a new endpoint relies on `reqClientIp(req) === row.clientIp` for authorization, that endpoint is wrong. Use `req.user.id === row.user_id` (or `req.user.isSystem`).
- **AP-2.** Do NOT skip the `codex_runs` explicit `CREATE TABLE` migration (C1). Even if "the app already creates it on first INSERT", the schema is now part of the contract and we need it pinned.
- **AP-3.** Do NOT store the plaintext `api_token` in RDS. Hash with `sha256(token)`; return the plaintext exactly once at mint.
- **AP-4.** Do NOT return `403` for "this resource belongs to another user" reads (`/history/:runId`, `/job/:id`). Return `404 not_found` so existence is not discoverable. `403` is reserved for *authenticated* failures (e.g., SSE stream where we know the caller is logged in but lacks the right).
- **AP-5.** Do NOT let `system` user be a real row in `users`. The `id='system'` is a sentinel; minting a real row with `id='system'` should fail with `409`.
- **AP-6.** Do NOT widen CORS to allow `*` with `Authorization` headers in a follow-up. The demo can stay `*`; the moment we ship a hardened posture, narrow both together.
- **AP-7.** Do NOT do the schema migration + the code change in the same commit. Migration first (one commit, applies cleanly to prod), then code (one or more commits gated on the migration being live). The `rds-migrate.sh --ssh` path proves the migration on prod before any handler reads `user_id`.
- **AP-8.** Do NOT regress the `D-route isolation` (US-2.6). The check that already exists in `handleJobEvents` is good (IP-based); this PRD **upgrades** it to user-based, not removes it. A safety net to keep both is fine; an IP-only fallback for clients with no token is fine; a "fail open" when `user_id` is null is **not** fine for non-system users.
- **AP-9.** Do NOT introduce per-user UID for the `codexsbx` sandbox (C6). All users share the UID; the per-user isolation is at the path / DB / OSS-key layer.
- **AP-10.** Do NOT forget the `mock:audit` issue. The repo is going to grow `mock:` markers all over the place as the mock-tracking wave plan unfolds. The audit issue is the **only** gate that proves no real handler is still calling a stub. Block all "ship" merges on `mock:audit` closing.

---

## §11 Wave plan (mock-augmented, see `/to-issues` for the issue fan-out)

This is a sketch; `/to-issues` will turn it into the actual issue files.

| Wave | Real | Mocks (parallel stubs that let downstream agents start now) |
|---|---|---|
| 1 | `003_users.sql` + `resolveUser` middleware + `/admin/users` mint/revoke | `mock:004` (typed stub of `codex_runs.user_id` column), `mock:005` (typed stub of `codex_jobs.user_id` column), `mock:history-filter` (mock `/history` filter that always returns `[]` for non-system), `mock:job-auth` (mock owner check on `/job/:id` and `/job/:id/events` that always 403s non-system), `mock:pdf-peruser` (mock per-user dir + OSS prefix that uses a fake `pdfs/<userId>/…` key) |
| 2 | `004_codex_runs_user_id.sql` (real column) + write-path tags in `recordRun` / `insertCodexJob`; per-user `PDF_OUTPUT_DIR/<userId>/` + OSS prefix | `mock:history-filter` refined to use the real `codex_runs.user_id`; `mock:job-auth` refined to read `job.userId` from the new column; `mock:pdf-peruser` refined to write to the real per-user dir |
| 3 | Real `/history` + `/job/:id` + `/job/:id/events` + `/pdf/oss/:slug` owner checks; per-user concurrency | — |
| 4 | `mock:audit` (scans for residual `mock:` / `clientIp` ownership drift) | — |

`mock:audit` is the **single** gate that must close before "ship". Wall-clock = 1 (real) + 1 (real) + 1 (real) + 1 (audit) = 4 waves, vs. the strict-topo 5+ waves.

---

## §12 Success criteria

- **SC-1.** `scripts/rds-migrate.sh --status` shows `003_users.sql`, `004_codex_runs_user_id.sql`, `005_codex_jobs_user_id.sql`, `006_pdf_jobs.sql`, and `007_codex_runs_explicit_create.sql` all applied, idempotent.
- **SC-2.** `curl -H 'x-demo-key: $DEMO_SECRET' http://…/admin/users -d '{"name":"alice"}'` returns `201 { id, name, apiToken }`; the plaintext token is captured at mint, never re-fetched.
- **SC-3.** `curl -H 'Authorization: Bearer <aliceToken>' http://…/history` returns only Alice's runs; `curl -H 'Authorization: Bearer <bobToken>'` returns only Bob's; `curl -H 'x-demo-key: $DEMO_SECRET'` returns both.
- **SC-4.** Alice opens `EventSource('/job/<bobJobId>/events')` → `403 forbidden`; Bob opens the same → 200.
- **SC-5.** Alice `/pdf/oss/<bob-slug>` → 404; Alice's own slug → 200 with fresh presign; the OSS object lives under `pdfs/<aliceId>/…`.
- **SC-6.** Restart the server mid-run; Alice's `/job/:id` for her in-flight job still returns the latest state from RDS.
- **SC-7.** `rg 'mock:|FIXME.*replace' server/ migrations/ frontend/` (run as the `mock:audit` issue) returns no residual mocks at ship time.
- **SC-8.** `rg 'clientIp.*=== .*clientIp|reqClientIp.*=== .*clientIp' server/` shows zero new uses outside the legacy `codex_runs.client_ip` logging column.
