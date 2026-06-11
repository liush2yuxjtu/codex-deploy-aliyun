---
id: ISSUE-002
us: US-1.2 (front)
title: 异步卡片可取消(前端 UI)
parallel_group: S1A
type: AFK
blocked_by: []
soft_blocked_by:
  - ISSUE-005
files:
  - frontend/index.html
risk: low
effort: small
expected_commits: 1
ready_for_agent: true
status: pending
---

# ISSUE-002: 异步卡片可取消(前端 UI)

## What to build

异步卡片在 running / firstByte 状态下,展示"取消"按钮;点击 → `POST /job/:id/cancel` → 卡片显示"已取消 · 服务端耗时 N s"。

后端 cancel 路由由本 issue 假设存在(由 ISSUE-005 + US-1.2 back 半做兜底),本 issue 只做前端 UI + fetch 调用。

## Acceptance criteria

- [ ] 卡片在 `status === 'running' || status === 'firstByte'` 时显示"取消"按钮
- [ ] 状态变 `done` / `error` / `cancelled` 时按钮消失
- [ ] 点击取消 → `POST /job/:id/cancel` → 收到 200 后,卡片标题改为"已取消 · 服务端耗时 4.2s"
- [ ] 收到 409(任务已完成)→ 卡片静默切到 `done` 状态,无报错
- [ ] EventSource 收到 `cancelled` 事件时同样更新卡片
- [ ] 软依赖 ISSUE-005:即便没做 killJobTree,前端 UI + POST 调用本身完整,后续 helper 落地后无侵入切换

## Blocked by

None(soft: ISSUE-005 落地后,后端 kill 路径对齐)

## Notes

- 风险:重复点击 → 第二次拿 409,UI 已静默处理
- 涉及文件:`frontend/index.html` 的 sendAsync + 卡片渲染部分
- 估时 45 分钟,1 个 commit
