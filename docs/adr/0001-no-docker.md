---
id: ADR-0001
title: 不引入 Docker,用 native codex sandbox
status: accepted
date: 2026-06-12
deciders: Liu Shiyu + Claude Code
supersedes: null
superseded_by: null
---

# ADR-0001: 不引入 Docker,用 native codex sandbox

## Context

2026-06-11 v1 部署期间,原计划用 `node:22-slim` Docker 镜像作为 codex CLI 沙箱。在中国大陆 SWAS 上执行 `apt-get update` 时,`apt-get update` inside `node:22-slim` from mainland China hung past 10 min,Docker 镜像构建链路 10 分钟内无法完成 `apt-get update`,且镜像源(Aliyun / TUNA / 网易)在该时刻的连通性都不可控。镜像无法落地 → 无法 commit → 无法 spawn codex → 部署链断在第一步。

备选路径:放弃容器化,直接用 SWAS 主机 OS(Debian 12)装 `node 20.18.1` + `codex 0.139.0` + `codexsbx` 系统用户,配合 codex CLI 自带的 `-s workspace-write` 内层沙箱,外加 per-request tmpdir 隔离文件系统,达到等价安全边界。

原始记录见 memory `reference-deployment-gotchas.md` #1,以及 v1 handoff doc(`/tmp/codex-deploy-handoff-2026-06-11.md`)对应章节。

## Decision

**不引入 Docker。** codex-deploy-aliyun v1 起的所有部署、运行、CI 流程一律走 native Debian sandbox(`codexsbx` user + per-request workdir + `codex -s workspace-write`)。理由是事实证据 — Docker 在 2026-06-11 的中国大陆 SWAS 网络条件下不可用,且无任何业务需求真正要求容器化隔离(我们只要"按请求隔离文件系统 + 限制 codex 写路径",codex 自带 sandbox 已覆盖)。

后续任何"加 Docker"的提议,默认拒绝,必须开 ADR-0002+ 显式推翻本决策,且必须提供新证据(网络情况变化 / 新业务需求 / 镜像层优化等)。

## Consequences

**正向**

- 部署链从 5+ 步(写 Dockerfile → build → push → pull → run)压成 2 步(`apt install node` + `npm i -g @openai/codex`)。
- 镜像层零开销 — SWAS 1GB 内存,省去 Docker daemon 的 ~150MB 常驻。
- 调试透明 — `ps auxf` 看到的就是 codex 进程,不用 `docker exec` 进容器。
- 冷启动 <500ms(从 v1 实测,见 gotcha #12),Docker 容器冷启动普遍 1-3s。
- 进程组杀干净 — `process.kill(-child.pid, 'SIGKILL')` 直接生效,不需要 `--pid=host` 之类的 hack。

**负向**

- 沙箱边界依赖于 codex CLI 自身的 `-s workspace-write` 行为,如果未来 codex CLI 升级破坏该语义,需要审计替代方案(目前锁版本 `0.139.0`,`scripts/fix_state_drift.sh` 维护)。
- 跨环境一致性弱于镜像(Dev Mac vs SWAS Debian 不完全一致) — 但 v1 验证过 Node 20.18.1 stdlib + `pg` 在两边行为一致,接受此 trade-off。
- 团队后续如果有人会 Docker、不会 native systemd,onboarding 成本略高 — 由 `onboard-codex-deploy` skill(US-3.1)缓解。

**推翻条件(写明以避免下次"再讨论一遍")**

以下任一条件出现时,**才**允许开 ADR 后续条目推翻本决策:

1. 阿里云 SWAS 出厂镜像或 ecs.swap 网络对 Debian apt 镜像源恢复了稳定连通性(目前是时好时坏,且 `apt-get update` 单独挂),且能给出 ≥1 个月稳定窗口的证据。
2. 业务出现新需求 — 例如需要在同一 SWAS 上跑多个互不信任的 codex 任务,且 native `codexsbx` user 隔离不够(目前一个 codexsbx user 即可,因为请求通过 HTTP API 串行化,无并发跨租户场景)。
3. Docker daemon 在 SWAS 上经过实测能稳定运行,镜像层 `apt-get update` 能在 60s 内完成(目前 >10min)。
4. Codex CLI 自身移除 `-s workspace-write` 语义且无替代 → 此时 native sandbox 失去意义,需要新隔离层(本 ADR 自动失效,需要新 ADR 替代)。

**任何不满足上述条件**的"加 Docker"提议,默认拒绝,不再讨论。

## 引用

- memory `reference-deployment-gotchas.md` #1 — 原始事实记录
- v1 handoff doc `/tmp/codex-deploy-handoff-2026-06-11.md`
- `docs/PRD-v2.md` §关键代码模式 #1
- `server/server.js` `startCodexJob` helper — sandbox 落地点
