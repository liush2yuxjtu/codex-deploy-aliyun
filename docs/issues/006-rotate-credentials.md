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
risk: medium
effort: medium
expected_commits: 2
ready_for_agent: true
status: pending
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
