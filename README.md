# Ebbing Context

**模拟记忆衰退的 DSH 分层上下文压缩插件。**

模型自己决定压哪里、自己写摘要；插件只把四条宿主本来就认识的会话事件写进日志，把旧内容一层层降成更粗的表示：

```
原文（逐字）  →  L1 块（一段的结论与数据）  →  L2 块  →  L3 块（只剩关键词句）
```

越旧的内容分辨率越低，但**从来没有被删掉**——原文仍在会话日志里，装了「会话搜索」插件就能按事件号取回。

名字里的 `ebbing` 是“渐渐消退”。它模拟的是记忆的自然衰退，不是曲线、也不是定时任务：降不降、降多少，由模型看着上下文压力自己决定。

---

## ⚠️ 状态：尚未在真机上安装运行过

代码是完整的，单元测试与冒烟测试全绿（`blocks` 47 / `compress` 11 / `callfold` 18 / `config` 11 / `prestep` 12 / `usage` 8 / `map` 8），但**还没有人在真实的 DSH 里装过它**。第一次安装请：

1. 先备份 profile 目录；
2. 装完先看插件卡片是否变成「运行中」；停在「未运行」说明 load 失败，DSH 日志里会有一条 `import` 相关的错误；
3. 确认两个工具 `context_map` / `compress` 与命令 `/context-status` 都在；
4. 先在一个新会话里试，别在长会话上试。

目标宿主：**DSH 0.2.1-rc.3 ~ 0.2.2-alpha.2**。用到的每个接缝都对着这两版的源码核对过，但核对不等于跑通。

---

## 它怎么工作

- **两个工具 + 一条命令**：`context_map`（看当前分层结构与占用）、`compress`（执行一次压缩）、`/context-status`（只读，内容和地图一致）。
- **键名 = 要压的那一层**：`l0` 压原文区头部 → 产物是 L1 块；`l1` 压 L1 区头部 → L2 块；`l2` 压 L2 区头部 → L3 块；`l3` 把整个 L3 区压成一块（唯一不写 `to` 的键）。
- **`to` 只能从地图上抄**：`l0` 写轮号（`T19`），`l1` / `l2` 写该区从 1 起的块序号。写错就被拒，拒绝回执里带着刷新后的地图。
- **级联**：压深层时，比它浅、且还能压的层必须在同一批里一起给，否则整批拒绝。这样做是为了只断一次前缀缓存。
- **零台账**：不建数据库、不写状态文件。每轮的层级都是从 `session.surface.nodes` 现算出来的，块的身份写在块正文第一行（`〔L1｜T16–T19｜ev 4121–4390〕标题`）。
- **提醒，但不代劳**：占用到 75%、自上次提醒后又长了一大截、或某一层超出设计配额时，插件会在一轮收尾把模型叫醒并给一张新地图——压不压、压哪里，仍然由模型决定。它**从不自动压缩**，也不催你敲宿主的 `/compact`。

---

## 安装

两种方式，都还没在真机上验证过：

**方式一（推荐）**

```bash
dsh plugin add "C:\path\to\dsh-ebbing-context"
```

**方式二**：在 profile 的 `cordis.patch.yml` 里加一行 insert：

```yaml
- id: dsh-ebbing-context
  name: ./index.js        # 或包名 dsh-ebbing-context
```

> ⚠️ `name` 只写目录、没写入口文件时，Loader 解析不到会**只写一行日志就放弃**，插件不会启动，界面只显示「未运行」。所以要么用 `dsh plugin add`，要么把 `name` 写成 `./index.js`。

---

## 配置

设置入口：**侧栏「插件」→ 找到 Ebbing Context → 行详情页**（系统「设置」里的插件清单是只读的）。

15 项，全部是普通配置项，保存在 profile 的 `cordis.patch.yml` 里：

| 分组 | 项 |
|---|---|
| 配额 | `budget.l1` / `budget.l2` / `budget.l3`（各层占可用输入的百分比） |
| 单块上限 | `segment.l1` / `segment.l2` / `segment.l3` / `title.maxTokens` |
| 提醒 | `notice.enabled` / `notice.growthTokens` / `triggerPct` |
| 行为 | `keepTurns` / `pruneFirst` / `foldCallRecord` / `requireSessionQuery` / `reservedTokens` |

**建议关掉宿主自带的自动压缩**（`compaction-basic` 的 `auto`，默认在 80% 时触发）。它一旦触发，会把这里的多层摘要重新拍平成一段高层摘要，细节永久丢失——插件本身不受影响，但效果会打折。本插件不能替你改那一行（它在 profile 的 `group` 里），需要你自己在 `cordis.patch.yml` 里写 `config: { auto: false }`。

---

## 依赖与边界

- **需要「会话搜索」插件**（`session_search` 等工具）。`requireSessionQuery` 默认为 `true`：一旦取回原文的能力不存在，`compress` 与 `context_map` 都会拒绝执行并说明原因——宁可上下文大着，也不做不可逆的事。想在没有它的情况下也能压，把这个开关关掉。
- 不依赖任何特定模型；不调用模型。
- 不实现 `ctx.compaction`、不改宿主压缩插件、不注册 message projection、不拦截网络。

---

## 已知限制

- **不自动压缩**：所有压缩都由模型在对话中主动发起。
- **并行调用时折叠降级**：如果模型把 `compress` 和别的工具放在同一条消息里并行发，调用记录只能改成“折地图、留每个键的结果”，参数里那份摘要副本要到下一次覆盖它的压缩才会消失。
- **图片不单独记账**：宿主自带的图片离线化只处理最老的图片，被压缩遮掉的图片不会额外记录（块里会写一行图片台账）。
- 空节点、缺轮次大纲、缺会话搜索等异常情形都有守卫与明确报错，但这些守卫只在合成会话上跑过，真机行为待验证。

---

## 许可与出处

MIT。

插件里检查点前导语（`This is an automatically generated checkpoint …`）与被压内容边界标签（`<compacted-summary>` / `</compacted-summary>`）的**文字**抄自 DSH 自带的 `@deepseek-ai/dsh-compaction-basic`（MIT）——宿主界面与日志靠这段文字识别检查点，必须逐字节一致。除此之外没有复制任何代码。

当前实现的完整规范见 [`docs/SPEC.md`](docs/SPEC.md)。
