---
id: ISSUE-007
us: US-3.1
title: onboard-codex-deploy skill
parallel_group: S1C
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - ~/.claude/skills/onboard-codex-deploy/SKILL.md
risk: low
effort: medium
expected_commits: 1
ready_for_agent: true
status: pending
---

# ISSUE-007: `onboard-codex-deploy` skill

## What to build

在 `~/.claude/skills/onboard-codex-deploy/SKILL.md` 新增一个 skill(不在本仓,在 skills 仓),5 个 step 串行带新 agent 跑一遍 happy path:<10 分钟。任何 step 失败 → 给"该看哪份 memory"的具体路径。

## Acceptance criteria

- [ ] skill frontmatter 完整(`description` 含触发词)
- [ ] Step 1:check git(`git log --oneline -5` + `git status`)
- [ ] Step 2:check SWAS health(`ssh -i ~/.ssh/aliyun_deploy root@$SERVER_IP "systemctl status codex-api"`)
- [ ] Step 3:`curl http://127.0.0.1:3030/healthz`
- [ ] Step 4:`curl /run` chat smoke(`reply: onboard-smoke`)
- [ ] Step 5:`curl /pdf/from-url` PDF smoke(用 `anonymized.html` gist URL)
- [ ] 每个 step 失败提示"读 ~/.claude/projects/.../memory/<具体文件>.md"
- [ ] happy path 总耗时 <10 分钟
- [ ] skill 写成"如何查",不写死"答案是 X"(避免过期)

## Blocked by

None

## Notes

- 涉及文件:`~/.claude/skills/onboard-codex-deploy/SKILL.md`(在 skills 仓库,不在本仓)
- 估时 2 小时,1 个 commit(到 skills 仓)
- 风险:写得过细会过期 → step 内只引路径,不复述内容
