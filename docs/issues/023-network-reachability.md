---
id: ISSUE-023
us: v3-#3
title: SWAS-cs → RDS-cb 网络可达性诊断
parallel_group: v3B
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - scripts/diagnose_reachability.sh
  - docs/runbook/network-reachability.md
risk: low
effort: small
expected_commits: 2
ready_for_agent: true
status: done
closed_at: 2026-06-12
merged_commit: 6350eea
---

# ISSUE-023: SWAS-cs → RDS-cb 网络可达性诊断

## What to build

session 1 起的 open item:**SWAS 在 cn-shanghai,RDS 在 cn-hangzhou(免费试用默认),内网不可达,只能用公网**。每次"公网告警"复盘都要手动跑 `ping / telnet / traceroute / mtr / nc` 一串命令来证伪"是不是 cn-shanghai 内网到 cn-hangzhou 真断了"。

把它脚本化 + 文档化,后续 v3 cn-shanghai 重建时直接复用:

1. `scripts/diagnose_reachability.sh`:从 SWAS 跑一串诊断,出可达性矩阵(SWAS-cs → RDS-cb 公网 / SWAS-cs → RDS-cs 内网 / SWAS-cb → RDS-cb 内网)
2. `docs/runbook/network-reachability.md`:把每次诊断结果归档的格式 + 解读规则
3. 集成 `alibabacloud-network-reachability-analysis` skill(120 个 bundle 里那个),把"网络能不能通"变成一行 aliyun CLI 调用

## Acceptance criteria

- [ ] `scripts/diagnose_reachability.sh` 跑 6 项:ping(公网)、nc 公网 5432、traceroute(前 5 跳)、mtr 10s、curl ifconfig.me 拿出口 IP、route -n 看默认网关
- [ ] 输出固定格式:每项一行 `[OK|FAIL|SKIP] <name>: <detail>`
- [ ] `--save` flag:把这次结果追加到 `docs/runbook/reachability/<ts>.md`
- [ ] `docs/runbook/network-reachability.md` 含"如何读结果"段 + "何时升级"段(FAIL 持续 5min 才升级,避免抖动误报)
- [ ] e2e(在 SWAS 上):`bash scripts/diagnose_reachability.sh` → 至少 5/6 项 OK(现状:ping/nc/curl/route 都 OK,traceroute 可能因 SWAS 默认不开放 ICMP 而 SKIP)
- [ ] skill 装:`npx skills add aliyun/alibabacloud-aiops-skills --skill alibabacloud-network-reachability-analysis`,并写一行调用示例

## Blocked by

None

## Notes

- 涉及文件:`scripts/diagnose_reachability.sh`(新增),`docs/runbook/network-reachability.md`(新增)
- 估时 2h,2 个 commit
- 风险:`mtr` / `traceroute` 在 SWAS 上可能没装 → 加 `command -v` 检查,缺失则 SKIP 而不是 FAIL
- 收益:任何"代码连不上 RDS" 的复盘,先跑这个脚本,30s 出结果;避免每次重新摸索命令
- 与 v3 cn-shanghai 重建(本仓暂未规划)直接配套
- **不**自动告警:open item 已经 consciously accepted(CLAUDE.md `1ac1b28`),此脚本只做"诊断 + 留档",不做"告警升级"
