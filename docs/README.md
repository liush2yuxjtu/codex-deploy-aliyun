---
project: codex-deploy-aliyun
last_updated: 2026-06-12
audience: new agents + future maintainers
---

# codex-deploy-aliyun — docs index

从这一页开始读。仓库其余目录(PRD、issues、scripts、frontend、server)都只服务单一目标,本文档串起它们。

## 1. Quick start

把项目拉起来,5 分钟跑通 `/healthz` + `/run` + `/pdf` 三个 smoke。`/onboard-codex-deploy` skill(US-3.1)落地后,从此处直接跳到该 skill 即可;落地前看 [`docs/PRD-v2.md` §v1 状态基线](PRD-v2.md) 里的端点清单 + `scripts/probe_codex.sh`。

## 2. Architecture

部署拓扑 + 端点契约 + 数据模型集中在 [`docs/PRD-v2.md`](PRD-v2.md)。`server/server.js` + `frontend/index.html` 是唯一两处需要读源码的位置;`scripts/` 里的 20+ 脚本是部署 + 探活工具链,不要绕过。

- 部署拓扑图:PRD-v2 §部署拓扑
- 端点表:PRD-v2 §Server endpoints
- 数据表 `codex_runs` / `codex_jobs`(待 US-2.2):PRD-v2 §数据持久化 + §Schema 契约

## 3. Decisions

所有跨 session 的非显然决策沉淀在 [`docs/adr/`](adr/README.md)。每条 ADR 用 Context / Decision / Consequences 三段式,推翻任一条必须开新 ADR。

- [ADR-0001: 不引入 Docker](adr/0001-no-docker.md) — 把 v1 gotcha #1 沉淀为正式决策
- (后续 ADR 占位 — 提 PR 时在此追加)

5 份 memory(`~/.claude/projects/.../memory/`)是 ADR 之前的草稿,**新增内容不再写 memory,只写 docs/**。memory 顶部会加"已迁 docs/" 注。

## 4. Runbook

事故 + 轮换 + 探活路径。落地后的来源:

- 凭据轮换:`scripts/rotate_credentials.sh`(US-1.5,待写)— 接受 `--only llm|rds|ak|ssh|all`
- RDS 公网警告:见 memory `project-rds-security-alert.md`
- 服务挂了:`scripts/remote_exec.sh` + `systemctl status codex-api` + 看 `/var/log/codex-api/`
- codex 进程孤儿:见 [ADR 后续占位] + `scripts/fix_state_drift.sh`

## 关联文件

- [`docs/PRD-v2.md`](PRD-v2.md) — 产品需求基线
- [`docs/issues/`](issues/README.md) — 15 个 vertical-slice issue,Sprint 1/2/3 路线图
- [`docs/adr/`](adr/README.md) — 架构决策记录
- 5 份 memory:`~/.claude/projects/-Users-liushiyuwin-Documents-codex-deploy-aliyun/memory/`(过渡,deprecated)
