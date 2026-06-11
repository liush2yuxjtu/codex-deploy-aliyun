---
project: codex-deploy-aliyun
last_updated: 2026-06-12
---

# ADR — Architecture Decision Records

本文档目录沉淀所有"非显然 + 跨 session"的技术决策。格式参考 [adr.github.io](https://adr.github.io/):每条 ADR 三段式 — **Context** / **Decision** / **Consequences**。

## 规则

1. **写 ADR 之前先 grep** `docs/adr/` 看是否已有同主题;若有,只能新增 0002 supersede 0001,不能改原文件(MADR 原则 — 历史不可改写)。
2. **三段缺一不可**。Context 写"为什么这是问题",Decision 写"我们选了什么",Consequences 写"代价 + 后续 ADR 如何推翻"。
3. **链接必须硬**。`/run` 写 `server/server.js#L123`,不写"看 server.js 那一行"。
4. **状态字段**:每个 ADR 顶部 frontmatter 含 `status: proposed | accepted | superseded-by-0002 | deprecated`,CI 校验(后续 US)。
5. **编号单调递增**。补 ADR 永远用下一个空号,不复用。

## 索引

| 编号 | 标题 | 状态 | 日期 |
|---|---|---|---|
| [0001](0001-no-docker.md) | 不引入 Docker,用 native codex sandbox | accepted | 2026-06-12 |

## 模板

```markdown
---
id: ADR-NNNN
title: <一句话标题>
status: proposed
date: YYYY-MM-DD
deciders: Liu Shiyu + <agent name>
supersedes: null
superseded_by: null
---

# ADR-NNNN: <标题>

## Context

<什么场景/什么约束触发了这次讨论。引用 memory 文件 / handoff doc / gotcha 编号。>

## Decision

<我们选了什么,以及为什么选它而不选备选。备选列在 Consequences 里。>

## Consequences

<正向 + 负向影响。明确写出"在什么条件下这条 ADR 应被推翻"以及"推翻时需要开 ADR-NNNN+1,不能 in-place 改本文件"。>
```

## 与 memory 的关系

- memory(`~/.claude/projects/.../memory/`)是临时草稿区,本目录是正式源。
- 新决策直接写 ADR,不再写 memory。
- 老 memory 文件保留作历史追溯,顶部加"已迁 docs/adr/NNNN"注。
