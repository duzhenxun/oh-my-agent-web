# 计划 02:额度接力(Handoff)与全局用量看板

- **状态**:计划中,未实现
- **体量**:中。用量看板与预算推送可独立交付;接力依赖用量数据做「额度是否耗尽」的判断之外的部分较少,但要处理引擎切换。
- **依赖**:用量聚合(阶段 A)是接力与预算的共同基础。
- **相关现状**:`server/session/session-stats.ts`、`server/util/usage.ts`、`server/session/pi-sessions-provider.ts`、`server/engine/pi-retry.ts`、`server/engine/pi-transcript.ts`、`server/push/push.ts`(`notifyTurnFinished`)、`server/protocol.ts`(`NewChatRequest`)

## 1. 目标与非目标

**目标**

- A. 全局用量看板:按日期、引擎、模型、项目汇总 token 与成本。
- B. 预算推送:日/月花费超过阈值时,通过 Web Push 告警,同一周期内只告警一次。
- C. 额度接力:当前会话因额度/限流无法继续时,把它压缩成交接摘要,在另一个引擎或模型下开新会话继续。

**非目标**

- 不引入数据库。汇总缓存是可丢弃的派生数据,丢了可以从引擎文件重算。
- 不做跨机器、跨用户的用量统计(单用户、loopback 定位不变)。
- 不假装覆盖所有引擎:没有成本数据的引擎在看板上明确标注「未覆盖」,不估算冒充。

## 2. 现状约束

| 约束 | 证据 | 含义 |
|---|---|---|
| 统计不缓存、按会话全量解析 | `session-stats.ts` 逐行解析单个 JSONL,上限 20MB | 看板若每次全扫,成本随会话数线性增长 |
| 会话列表缓存不含 token | `pi-sessions-provider.ts` 缓存键为 path+mtime,只有标题/模型/时间 | 需要新的汇总缓存,不能直接复用 |
| 回合结束已有推送挂钩 | `server/index.ts` 的 `onTurnFinished` → `notifyTurnFinished` | 预算检查挂在这里即可,不改引擎适配层 |
| 错误分类已存在但偏宽 | `pi-retry.ts` 的 FATAL 正则含 `quota|insufficient|billing|usage limit`,未识别一律 fatal | 额度判断只能作为「建议」,用户确认后才接力 |
| 新会话请求不带引擎/模型 | `protocol.ts` 的 `NewChatRequest` 无 engine/model 字段 | 接力需要扩展协议 |
| 引擎切换要求回合空闲 | `engine-switch.ts` | 跨引擎接力必须先切引擎,且要求当前没有在飞的回合 |

## 3. 阶段 A:用量聚合

### 3.1 设计

- 模块:`server/usage/usage-index.ts`。
- 对每个会话文件记录 `{ path, mtimeMs, size, totals: { byDay: { [date]: { engine, model, project, input, output, cacheRead, cacheWrite, cost } } } }`。
- 扫描时只重新解析 mtime 或 size 变化的文件;未变化的直接用缓存。
- 缓存文件:`<dataDir>/usage-cache.json`,tmp+rename 原子写。损坏或删除 = 从零重算,不影响功能。
- 时间归属:按每条消息的时间戳分到本地日期,而不是按会话创建日期(长会话跨天时要拆开)。
- 复用 `util/usage.ts` 的 `parseUsage()` 解析 usage 字段。

### 3.2 引擎覆盖

| 引擎 | 本阶段 | 说明 |
|---|---|---|
| pi | ✅ | 已有 usage 与 cost 字段 |
| claude | 需核实 | 会话 JSONL 里有 `message.usage`,但可能需要补字段名 |
| codex | 需核实 | `event_msg` 的 `token_count` 有 per-turn 增量 |
| opencode / dsh | ❌ 预计未覆盖 | opencode 会话在 SQLite 里 |

### 3.3 接口与界面

- `GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&group=engine|model|project|day`
- 界面:新增 `web/src/components/UsageDashboard.tsx`。入口放在状态栏的用量区(`StatusBar.tsx`)。范围切换:今日 / 7 天 / 30 天。展示总量、分组柱状列表、未覆盖引擎的提示。

## 4. 阶段 B:预算推送

### 4.1 设计

- 设置项:`budget: { enabled, dailyLimit?, monthlyLimit?, currency }`,加在 `server/protocol-settings.ts` 的 `SettingsView` 与对应的读写文件中,在 `SettingsPanel.tsx` 中编辑。
- 触发:`onTurnFinished` 之后,用阶段 A 的增量索引算出当天/当月花费(只重算刚结束的会话文件,开销很小)。
- 去重:在 `usage-cache.json` 的 `alerts` 字段记录 `{ periodKey: "2026-11-19", threshold: "daily" }` 已告警;同一周期、同一阈值只推一次。
- 推送:新增 `notifyBudget()`,复用 `push.ts` 中的 `store.send`。文案示例:「今日花费已达 ¥xx(阈值 ¥yy)」。

### 4.2 风险

- 成本口径不一:只有 pi(以及其他有 cost 的引擎)能给出金额。预算只统计有成本数据的部分,并在设置页写明。
- 跨午夜的时区:统一使用本地时区,与看板口径一致。

## 5. 阶段 C:额度接力

### 5.1 触发

两个入口,都由用户主动确认,不自动接力:

1. **错误卡片上的按钮**:当 `engine.provider_error` 被分类为额度/限流时,错误卡片出现「交接到其他引擎」按钮。需要在错误事件中带上 `errorKind: "quota" | "rate_limit" | "other"`,复用 `pi-retry.ts` 的分类结果。
2. **会话菜单**:`SessionMenu.tsx` 常驻「交接…」入口,用于任何原因下的主动接力(例如想换更强的模型)。

### 5.2 生成交接摘要

模块:`server/handoff/handoff-summary.ts`。

1. 通过引擎的 `readUiMessages(conversationId)` 取得统一消息结构(来源仍是引擎文件)。
2. 预处理(确定性,不调模型):
   - 保留第一条用户消息(原始目标)与最近 N 轮完整对话;
   - 工具调用压缩为一行,例如「编辑 `web/src/x.tsx`」「运行 `npm test`(失败)」;
   - 按字符预算截断(例如 24k 字符),超出部分记为「中间 N 轮已省略」。
3. 调用一次模型生成结构化摘要:**目标 / 当前状态 / 已改动的文件 / 未完成事项 / 需要注意**。模型用 `completeOnce`(与 cron 相同的直连方式),且**不能用刚刚额度耗尽的那个模型**。
4. **降级**:如果摘要模型也失败,退回纯确定性摘要(用户请求列表 + `git status` 改动文件 + 最后一条 assistant 文本)。这一步必须实现,否则额度耗尽时接力本身也会失败。
5. 用户在对话框中查看、编辑摘要后再发送。

### 5.3 开新会话

- 扩展 `NewChatRequest`:增加可选字段 `engine?`、`model?`、`seedText?`。
- 若目标引擎与当前不同:先走 `engine-switch` 流程(要求当前无在飞回合);切换完成后再 `new_chat`。
- 新会话的第一条用户消息 = 摘要文本,前缀写明「以下是来自另一会话的交接摘要,请基于此继续」。界面上标记为「接力自 <原会话标题>」。
- 原会话保持不变,不删除、不归档。

### 5.4 风险

- 摘要丢失关键细节(尤其是工具输出里的报错信息)。缓解:摘要要求模型原样引用报错的前几行。
- 长会话超过摘要模型的上下文上限。缓解:字符预算 + 分段摘要(后续可做)。
- `pi-retry` 的 FATAL 正则偏宽,普通 500 可能被误判为额度。缓解:错误卡片只「建议」接力,按钮始终可用的会话菜单入口是兜底。
- 引擎切换导致界面闪烁或会话列表刷新。需要在 P5 前端验证。

## 6. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| **A1** | `usage-index.ts` + 缓存 + 单测(用夹具 JSONL) | 修改一个文件只重算该文件;删除缓存后结果一致 |
| **A2** | `/api/usage` + `UsageDashboard.tsx` | 三个范围切换正确;未覆盖引擎有提示 |
| **B** | 预算设置、阈值检查、去重、`notifyBudget` | 超阈值推一次;同周期不重复;关闭开关后不推送 |
| **C1** | 确定性摘要 + 会话菜单入口(同引擎、只换模型) | 生成的摘要可读;在同引擎新会话中继续成功 |
| **C2** | LLM 摘要 + 降级路径 + 错误卡片按钮 | 摘要模型失败时自动降级;错误分类按钮出现在正确场景 |
| **C3** | 跨引擎接力(扩展 `NewChatRequest`,接入引擎切换) | 从 pi 接力到另一引擎,原会话不变 |

建议顺序:A1 → A2 → B → C1 → C2 → C3。A 与 B 可以独立发布,先给用户可见的价值。

## 7. 测试策略

- 用量聚合:固定夹具 JSONL,断言按日期/引擎/模型的汇总值。
- 预算去重:模拟同一周期多次回合结束,断言只推一次。
- 摘要:确定性部分做快照测试(输入固定消息 → 输出固定文本);LLM 部分用替身模型。
- 降级路径:强制摘要模型抛错,断言返回确定性摘要。

## 8. 待决问题

1. 货币单位与小数位,以及是否显示 token 之外的 cost 估算。
2. 摘要使用的模型是固定设置项,还是跟随「当前可用的最便宜的直连模型」?
3. 跨引擎接力时,是否需要把原会话的附件(图片)也带过去?建议 v1 不带,并在界面提示。
