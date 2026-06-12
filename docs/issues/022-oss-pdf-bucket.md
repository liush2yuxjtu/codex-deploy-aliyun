---
id: ISSUE-022
us: v3-#2
title: OSS PDF bucket + presigned URL 落点
parallel_group: v3B
type: AFK
blocked_by: []
soft_blocked_by: []
files:
  - scripts/setup_oss_bucket.sh
  - server/server.js
  - .env.example
risk: medium
effort: medium
expected_commits: 3
ready_for_agent: true
status: done
merged_commit: ab16c95
closed_at: 2026-06-12
---

# ISSUE-022: OSS PDF bucket + presigned URL 落点

## What to build

`/pdf` 端点现在直接吐 1MB+ 的 `application/pdf` 流回客户端(per `handlePdfUrl` in `server/server.js`)。这让 SWAS `codex-api.service` 进程在公网上载 1MB+ 二进制,而且 PDF 没法被多个客户端 / CDN 缓存。

切到 **Aliyun OSS**:
1. 新 bucket `codex-deploy-aliyun-pdf-out`(region `cn-shanghai`,私有读)
2. `handlePdfUrl` / `handlePdfUpload` 调 oss SDK 上传 PDF 文件
3. 响应改成 `{ ok: true, ossKey, downloadUrl, expiresAt }`,`downloadUrl` 是 5min 有效的 presigned URL
4. 前端 `frontend/index.html` 把"下载"按钮从 `Content-Disposition: attachment` 改到 `window.open(downloadUrl)`
5. 旧路径(`/pdf` 直接吐流)留 1 周 grace period,加 `Deprecation` header,然后下线

## Acceptance criteria

- [ ] 新脚本 `scripts/setup_oss_bucket.sh`:建 bucket + 配 RAM policy(`oss:PutObject` for `codexsbx` user,`oss:GetObject` for server only,no public read)
- [ ] `server.js` 加 oss SDK 依赖(node-aliyun-sdk-oss 或 aliyun CLI `ossutil` 子进程 — prefer SDK,fall back to `ossutil`)
- [ ] `handlePdfUrl` / `handlePdfUpload` 流程:写 OSS → 返 presigned URL(5min TTL)→ 不再吐流
- [ ] `frontend/index.html` 收到新响应后展示"下载链接 · 5min 内有效"
- [ ] e2e:`curl /pdf/from-url` → 响应不再是 application/pdf,而是 JSON,含 `downloadUrl`
- [ ] `curl $downloadUrl` → 真下载到 1.16MB PDF
- [ ] 旧路径保留 1 周,加 `Deprecation: true` + `Sunset: <date>` header
- [ ] `codex-pdf-out` 路径不再写 `/tmp/`,迁移 OSS

## Blocked by

None

## Notes

- 涉及文件:`scripts/setup_oss_bucket.sh`(新增),`server/server.js`(handlePdfUrl/handlePdfUpload 改造),`frontend/index.html`(下载按钮改 URL),`.env.example`(加 `OSS_BUCKET` `OSS_ACCESS_KEY_ID` `OSS_ACCESS_KEY_SECRET` `OSS_REGION`)
- 估时 半天,3 个 commit
- 风险:RAM policy 写错可能让 PDF 公网可读 → 用 `--dry-run` 跑 setup 脚本,先列 diff 再 apply
- 收益:SWAS 出向流量从每次 1MB+ 降到 ~1KB JSON,公网带宽费用断崖式下降
- 关联:本仓已有 `/pdf/from-url` / `/pdf/from-file` 两个 alias(后向兼容 001 的 long-alias form),改时只动 handler 内部,不动 route
- skill 装:`npx skills add aliyun/alibabacloud-aiops-skills --skill alicloud-oss`(给后续 OSS 操作提供高层 wrapper)
