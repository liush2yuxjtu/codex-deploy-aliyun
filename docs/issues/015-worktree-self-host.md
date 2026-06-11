---
id: ISSUE-015
us: US-3.2
title: worktree 自托管(per-worktree port triple)
parallel_group: S3
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - scripts/dev-up.sh
  - scripts/dev-down.sh
risk: low
effort: medium
expected_commits: 1
ready_for_agent: true
status: pending
---

# ISSUE-015: worktree 自托管(per-worktree port triple)

## What to build

新增 `scripts/dev-up.sh` / `scripts/dev-down.sh`,在 worktree 级别启隔离 dev stack:
1. 用 FNV-1a 哈希 worktree 路径,派生 port triple(3030 + offset,offset 落 [0, 1000))
2. 探测端口可用,撞 3000/3001/3002 等已占用端口则报"换 offset"
3. `.env.local` 自动注入新端口 + 临时 PG 路径
4. 启 server + 写 pidfile 到 `.worktree.pid`
5. `dev-down` 走 pidfile kill,不误杀同仓其他 worktree

## Acceptance criteria

- [ ] FNV-1a 哈希函数,offset = hash(worktreePath) % 1000
- [ ] 默认起 `node server/server.js`,端口 = 3030 + offset
- [ ] `.worktree.pid` 写 server pid(非 shell pid)
- [ ] `dev-down`:读 pidfile,`kill -TERM <pid>`,超时 `kill -KILL`
- [ ] `dev-down` 误杀检测:`ps -p <pid>` 显示命令含 `node server/server.js` 才发信号
- [ ] 同一 worktree 二次 `dev-up` → 报"already running,pid=<pid>"
- [ ] 两个 worktree 同时 `dev-up` → 不同端口,互不干扰
- [ ] e2e:开 2 个 worktree → 各自 `dev-up` → 各自 `curl /healthz` 返 200

## Blocked by

None(任意时段可起)

## Notes

- 涉及文件:`scripts/dev-up.sh`(新增),`scripts/dev-down.sh`(新增)
- 估时 2 小时,1 个 commit
- 复用 `worktree-self-host` skill 模式(见参考链接),但本仓不依赖该 skill(脚本独立可跑)
- 风险:port offset 哈希撞 SWAS 上 `sub3api:3000` 等已用端口 → 探测后报"换 offset",不静默起错
