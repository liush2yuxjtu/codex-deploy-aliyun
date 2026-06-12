---
id: ISSUE-006
us: US-1.5
title: 凭据轮换脚本(LLM/RDS/AccessKey/SSH)
parallel_group: S1C
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - scripts/rotate_credentials.sh
  - .env.example
  - .gitignore
risk: medium
effort: medium
expected_commits: 2
ready_for_agent: false
status: wontfix
wontfix_reason: conscious-risk-accepted-per-CLAUDE.md
closed_at: 2026-06-12
shipped_commit: d70fcc8
note: |
  The rotation SCRIPT shipped (d70fcc8 adds scripts/rotate_credentials.sh
  with --dry-run default), but the rotation ACT is consciously NOT
  performed. Per CLAUDE.md "Conscious risk acceptance" section
  (2026-06-12 user direction): LLM OAuth token, RDS password, Aliyun
  AccessKey, and SSH private key are accepted as-is. The script
  remains in the repo as a reference / future-use tool; running it is
  blocked on user reopening the decision.
---

# ISSUE-006: 凭据轮换脚本(LLM/RDS/AccessKey/SSH)

## What to build

新增 `scripts/rotate_credentials.sh`(≤200 行,纯 bash + aliyun CLI + curl)。接受 `--only llm|rds|ak|ssh|all` 参数。轮换后自动:
1. 重写本地 `~/.claude/skills/aliyun-start/.env`(chmod 600)
2. scp 到 `/etc/codex-api/secret.env`
3. `systemctl restart codex-api.service`
4. `curl /healthz` 自检
5. 旧值落到 `~/.credentials.bak/<ts>/`

## Acceptance criteria

- [ ] `--only llm` → 调 NewCLI OAuth refresh(或 RAM 重新签发 LLM key),更新 .env + secret.env
- [ ] `--only rds` → 调 RDS ResetAccountPassword,新密码 24 字符 random(psql + libpq-ok),更新 .env + secret.env
- [ ] `--only ak` → 调 RAM CreateAccessKey + 旧 key Disable,本地 .env 切到新 AK
- [ ] `--only ssh` → 生成新 ed25519,scp 公钥到 SWAS,本地 .env 切到新私钥路径
- [ ] `--only all` → 4 个串行做(任一失败回滚)
- [ ] 失败回滚:旧值从 `~/.credentials.bak/<ts>/` 恢复
- [ ] 全部完成后 `curl http://127.0.0.1:3030/healthz` 返 `db.ok: true`
- [ ] `.env.example` 注释更新,提示"真实值走轮换脚本生成"

## Blocked by

None

## Notes

- 涉及文件:`scripts/rotate_credentials.sh`(新增),`.env.example`(更新注释)
- 估时 3 小时,2 个 commit
- 风险:轮换后所有旧客户端请求失效 → 文档化此行为(README 加一句"轮换后需带新 SHARED_SECRET")
- 旧值备份路径必须在 `.gitignore`(`~/.credentials.bak/**` 已默认不追踪)
- 鉴于此脚本会触发实际云 API 调用,落地前必须有 `--dry-run` 模式(只在 stdout 打印将执行的动作)

## Conscious skip

凭据**轮换动作**本身被用户(2026-06-12)显式标注为**不做**(CLAUDE.md
"Conscious risk acceptance" 章节):LLM OAuth token / RDS password /
Aliyun AccessKey / SSH 私钥四处凭据维持现状,不轮换、不催办、不写提醒。
本 issue 因此打 `wontfix`。

`scripts/rotate_credentials.sh` 仍以 reference 形式保留(`--dry-run`
为默认行为),供未来用户反悔时直接复用;`d70fcc8` 是脚本本身的合入
commit,与"轮换动作是否执行"无关。

前置解锁条件(若用户后续决定执行):填好
`~/.claude/skills/aliyun-start/.env` 中的 `LLM_OAUTH_REFRESH_URL` +
`LLM_OAUTH_REFRESH_TOKEN`,然后 `scripts/rotate_credentials.sh
--only llm --apply`。
