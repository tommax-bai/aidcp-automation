# aidcp-automation

aidcp 云端拆分后的三个独立服务之一。

- **职责**：边缘 WebSocket(8787) / 风控单写 / 事件驱动编排 / 通知巡视
- **属主数据库**：`aidcp_automation`（2026-07-25 已物理拆库完成，旧共享库 `aidcp` 已 DROP）
- **组合根段**：`segA + segC`（`AIDCP_SERVICE=automation`）

## 来源

从 `aidcp-cloud` @ `41f2c73` 按 `boundaries/module-ownership.json` 的属主裁定切出。
切分是**机械的**：424 个源文件全部有属主裁定，零未裁定。

本仓包含：本层文件 + `kernel`（纯共享契约）+ `composition`（组合根，待三等分）+ 本属主的迁移。

## ⚠️ 当前状态：**尚不能独立编译**

这是第一刀，只做了**文件归位**。还差两件事：

1. **96 条跨边界 import 未消解**（六个方向都有：api→automation 37 / api→content 18 /
   automation→api 17 / content→automation 12 / automation→content 7 / content→api 5）。
   台账在 `boundaries/import-exemptions.json`。这些是编译期耦合，不消解则本仓 `tsc` 找不到文件。
2. **组合根未三等分**：`src/server.ts`（约 6000 行）+ `src/index.ts` 目前三个仓各有一份完整副本，
   需要按段拆成各自的 `main()`。

`kernel/` 目前在三个仓各有一份副本（57 文件）。要么抽第四个仓做共享包，要么加逐字节一致性守卫防漂移
—— **此决策待定**。

## 红线（继承自 aidcp-cloud）

- 一个域**绝不直连**另一个域的数据库；跨域读走属主域接口。
- 不静默假成功。
- 部署只从默认分支干净快照走；OL 只在明确要求时从发布分支。
