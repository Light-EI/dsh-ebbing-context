# dsh-infinity-context（骨架，**未安装、未运行过**）

DSH 原生分层上下文压缩：模型自己把旧对话折成三层摘要，插件只往会话日志写宿主本来就认识的事件。

设计依据：`../notes/2026-10-27-DSH原生分层压缩-设计方案.md`（§2.35 / §2.36 为现行语义）。

## 现在有什么

| 文件 | 内容 |
|---|---|
| `index.js` | 插件入口：注册 `context_map` / `compress` 两个工具，订阅"到线提醒"与"超限报错" |
| `lib/config.js` | 全部配置项与默认值、检查点前导文案 |
| `lib/blocks.js` | 表层分诊：判四区、还原每个块的层级与标题、解析锚点 |
| `lib/map.js` | 地图渲染 |
| `lib/compress.js` | 压缩事务：校验 -> 逐个子事务落盘（开始 / 摘要 / 替换 / 结束） |
| `dsh.bundle.patch.yml` | 一行 insert，把插件挂进 Loader |

## 已按最终语义实现的部分

- 键名 = 要压的那一层：`l0` / `l1` / `l2` / `l3`，产物自动升一层。
- `l0` 用轮锚点（`T19`），`l1` / `l2` 用该区从 1 起的序号。
- `l2` 的区间**从旧 L3 开始**，产物正文 = 旧 L3 正文原样 + 新段落（尾部追加，不重写前缀）。
- `l3` **不接受 `to`**：一次把整个 L3 区压成一块；L3 是多块区。
- 每个块正文第一行是标题行 `〔标题〕`，≤24 字；地图用它取代"正文首 40 字"。
- 单块超长 -> 拒绝并回实际值与上限；区超配额 -> 只在提醒里报数字，不拦。
- 提醒有三个独立触发条件：占用到 `triggerPct`（默认 0.75，每轮一条）、自上次提醒后又长了 `notice.growthTokens`（默认 65000）、某一层区超出 `budget.*`；跌回 `triggerPct` 以下即复位，没有滞回。
- 上下文超限 -> 只报一句"建议手动 /compact 或让别的 agent 场外压缩"，不自动压、不重试。
- 写入失败必补"压缩结束"事件，避免会话此后永久拒绝压缩。

## 接口核查结论（2026-10-28，只读比对安装态产物）

| 依赖 | 结论 |
|---|---|
| 检查点来源构造函数 | 子路径存在可解析；已改为直接写字面量，去掉这条运行时依赖 |
| `session.append` 替代表层 | 形状正确；`startSeq/endSeq` 必须是当前表层现存节点，`sourceEventSeqs` 必须稠密去重且含全部被遮蔽节点 |
| `ctx.tokenMeter.measure` | 字段名正确（`nodes[i].tokens`） |
| `contextPressure` 投影 | **没有 `percentUsed`**，只有 `contextWindow / surfaceTokens / pressureTokens / sampledSurfaceTokens`，百分比自己算（已实现） |
| 工具 `output` | `{schema, render}` 正确；参数描述里 `additionalProperties` 与 `required` 的写法已按统一 DSL 改（根省略、逐属性 `required:true`） |
| `agent/pre-step` / `agent/request-error` | 回调签名正确；提醒已改为"先写再等"，否则只能下一轮生效 |
| `snapshotEvents` | 仍可用但已弃用；v1 先用，后续换宿主推荐的自建索引 |
| 检查点消息 | 改用 `createUserMessage`（原来字面量缺 `id`/`createdAt`） |

### 剩下三个真机风险（有兜底但未跑过）

1. 第三方插件能否解析到宿主的包（已把运行时依赖降到 1 个，并备内联方案）。
2. 一次调用连做多段压缩时，第二段起必须重算"被遮蔽清单"（已实现，但这最易错）。
3. 路由为空时 `compaction/summary` 不能写 `undefined`（已条件展开）。

## 安装（**尚未执行**，需另行授权）

1. 把本目录拷到某个工作区，`package.json` 的 `dsh.bundle.patch` 指向本层的 yml。
2. 通过 `plugin_manager` 的 `install_bundle` 安装，target 用本目录的绝对路径。
3. 安装后先看 `application` / `warnings`，再用 `context_map` 验证地图能渲染出四区。

## 不做的事

- 不实现 `ctx.compaction`，不改 `compaction-basic` 那一行，不动 `command-compact`。
- 不做外部代理、不拦截 fetch、不建自己的数据库或状态文件。
- 不注册 message projection（卸载会打断旧会话的派生）。

## 许可与出处

MIT。插件里的检查点前导语（`This is an automatically generated checkpoint …`）与被压内容边界标签（`<compacted-summary>` / `</compacted-summary>`）的**文字**抄自 DSH 自带的 `@deepseek-ai/dsh-compaction-basic`（MIT），因为宿主界面与日志靠这段文字识别检查点，必须逐字节一致。除此之外没有复制任何代码。
