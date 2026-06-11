---
id: ISSUE-009
us: US-3.5
title: docs/ 索引页 + ADR 框架
parallel_group: S1C
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - docs/README.md
  - docs/adr/0001-no-docker.md
risk: low
effort: medium
expected_commits: 2
ready_for_agent: true
status: pending
---

# ISSUE-009: docs/ 索引页 + ADR 框架

## What to build

1. `docs/README.md`:4 个入口(Quick start / Architecture / Decisions / Runbook),每段链接到对应子文件
2. `docs/adr/0001-no-docker.md`:把 `reference-deployment-gotchas` #1 沉淀为正式 ADR(Context / Decision / Consequences)

## Acceptance criteria

- [ ] `docs/README.md` 列出 4 段,每段 1-3 句引导
- [ ] `docs/adr/0001-no-docker.md` 三段齐全(Context: 2026-06-11 部署时 Docker 撞墙;Decision: 不引入 Docker;Consequences: native sandbox 是唯一方向,任何"加 Docker"提议需新 ADR 推翻)
- [ ] `docs/adr/0001-no-docker.md` 末尾链接到 `reference-deployment-gotchas` memory 文件
- [ ] memory 文件 `project-codex-deploy-aliyun.md` 顶部加一行"已迁 docs/: 见 docs/README.md"
- [ ] `docs/adr/` 含 `.gitkeep` 或 README,确保目录入仓

## Blocked by

None

## Notes

- 涉及文件:`docs/README.md`(新增),`docs/adr/0001-no-docker.md`(新增),`docs/adr/README.md`(新增),`project-codex-deploy-aliyun.md` memory(加一行)
- 估时 1.5 小时,2 个 commit
- 后续 ADR 模板见 `docs/adr/README.md`(参考 https://adr.github.io/ 格式)
