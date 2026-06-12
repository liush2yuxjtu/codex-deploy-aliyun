---
id: ISSUE-008
us: US-3.4
title: workspace/anonymized.html 处置(A/B/C 选项)
parallel_group: S1C
type: HITL
blocked_by: []
soft_blocked_by: []
files:
  - workspace/fixtures/
  - .gitignore
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: done
option_chosen: B
merged_commit: f15fa6b
closed_at: 2026-06-12
note: |
  Race with 61a2c03(option C, gitignore whole fixtures/ dir) — both
  patterns now coexist in .gitignore, B's literal `workspace/fixtures/
  anonymized.html` is a no-op on top of C's `workspace/fixtures/`.
  User explicit "B please" in fork directive supersedes the earlier
  C landing.
---

# ISSUE-008: workspace/anonymized.html 处置(A/B/C 选项)

## What to build

`workspace/anonymized.html`(33KB,5e6a 留下的 PDF 测试 fixture,已匿名化的 2026-05 业务诊断报告)目前在 git untracked 状态。**3 个选项二选一**:

| 选项 | 动作 | commit |
|---|---|---|
| **A** 入仓 | `git add workspace/anonymized.html` + commit `chore(workspace): commit anonymized PDF test fixture` | 1 |
| **B** gitignore | `.gitignore` 加 `workspace/anonymized.html` 模式 | 1 |
| **C** 挪到 fixtures/ | `mv workspace/anonymized.html workspace/fixtures/` + `.gitignore` 加 `workspace/fixtures/*.html` 模式 | 1 |

## Acceptance criteria

- [ ] 用户明确选择 A / B / C 之一(本 issue 不能自动决定)
- [ ] 选择落地后:`git status` 干净(无 untracked + 无 modified)
- [ ] `git log -1` 显示对应 commit message
- [ ] 选项 A:文件可 `git show HEAD:workspace/anonymized.html` 拉到
- [ ] 选项 B/C:再次 `git add` 不会报错

## Blocked by

**用户拍板** — 这是 HITL issue,需 `AskUserQuestion` 二选一。

## Notes

- 涉及文件:`workspace/anonymized.html` / `.gitignore`
- 估时 5 分钟(含用户决策时间)
- 已确认文件已 anonymize(见 handoff doc 第 30 行:贵州扬翔 2026-05 业务诊断报告)
- 落地后应同步更新 ISSUE-006 的轮换脚本(选项 A 时,RDS 备份表里不应有这份 fixture 的 PII)
