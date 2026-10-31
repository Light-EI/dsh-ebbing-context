# Ebbing Context

[![test](https://github.com/Light-EI/dsh-ebbing-context/actions/workflows/test.yml/badge.svg)](https://github.com/Light-EI/dsh-ebbing-context/actions/workflows/test.yml)

**模拟记忆衰退的 DSH 分层上下文压缩插件。**

模型自己决定压哪里、自己写摘要；插件只把四条宿主本来就认识的会话事件写进日志，把旧内容一层层降成更粗的表示：

```
原文（逐字）  →  L1 块（一段的结论与数据）  →  L2 块  →  L3 块（只剩关键词句）
```

越旧的内容分辨率越低，但**从来没有被删掉**——原文仍在会话日志里，装了「会话搜索」插件就能按事件号取回。

名字里的 `ebbing` 是“渐渐消退”。它模拟的是记忆的自然衰退，不是曲线、也不是定时任务：降不降、降多少，由模型看着上下文压力自己决定。

---

## 状态（0.1.12）

代码完整，测试全绿（`blocks` 49 / `compress` 18 / `callfold` 19 / `config` 14 / `map` 10 / `prestep` 40 / `scope` 5 / `usage` 8），并且已经在真机上装起来过——但**还没有一次完整跑通的压缩记录**。

真机上碰到过、已经修掉的两个崩溃：

- 0.1.0：`compress` 的参数 schema 用了布尔 `required`，provider 直接拒整个请求（`Invalid schema for function 'compress'`）。
- 0.1.2 及以前：监听 `agent/turn-stopping` 时误用了 waterfall 的 `next`，每轮收尾抛 `next is not a function`（内容不丢，但收尾叫醒失效）。
- 0.1.11：安装模板里 `notifySubagents` 缩进错层，照模板装会启动失败——0.1.12 已修并会把老配置就地迁移。

装的时候建议：先备份 profile；装完看插件卡片是否「运行中」；确认 `context_map` / `compress` / `/context-status` 都在；先拿新会话试，别拿长会话试。

目标宿主：**DSH 0.2.1-rc.3 ~ 0.2.2-alpha.2**。

---

## 它怎么工作

- **两个工具 + 一条命令**：`context_map`（看当前分层结构与占用）、`compress`（执行一次压缩）、`/context-status`（只读，内容和地图一致）。
- **键名 = 要压的那一层**：`l0` 压原文区头部 → 产物是 L1 块；`l1` 压 L1 区头部 → L2 块；`l2` 压 L2 区头部 → L3 块；`l3` 把整个 L3 区压成一块（唯一不写 `to` 的键）。
- **`to` 只能从地图上抄**：`l0` 写轮号（`T19`），`l1` / `l2` 写该区从 1 起的块序号。写错就被拒，拒绝回执里带着刷新后的地图。
- **级联**：压深层时，比它浅、且还能压的层必须在同一批里一起给，否则整批拒绝。这样做是为了只断一次前缀缓存。
- **零台账**：不建数据库、不写状态文件。每轮的层级都是从 `session.surface.nodes` 现算出来的，块的身份写在块正文第一行（`〔L1｜T16–T19｜ev 4121–4390〕标题`）。
- **轮次标记**：每轮收尾写一条 `〔轮次标记〕下一轮 T57` 的小消息，压掉若干轮之后你仍能看出"这块盖住了哪几轮"。它是插件写的，不是用户说的话；系统提示里已注明。
- **提醒，但不代劳**：占用到 75%、自上次提醒后又长了一大截、或某一层超出设计配额时，插件会在一轮收尾把模型叫醒并给一张新地图——压不压、压哪里，仍然由模型决定。它**从不自动压缩**，也不催你敲宿主的 `/compact`。

---

## 安装

**npm 包尚未发布**（名字已占位为 `dsh-ebbing-context`），方式零要等上架；方式一、方式二在真机上装起来过。

**方式零（npm，上架后）**

```bash
npm i -g dsh-ebbing-context
dsh plugin add dsh-ebbing-context
```

**方式一（推荐，源码目录）**

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

17 项，全部是普通配置项，保存在 profile 的 `cordis.patch.yml` 里：

| 分组 | 项 |
|---|---|
| 配额 | `budget.l1` / `budget.l2` / `budget.l3`（各层占可用输入的百分比） |
| 单块上限 | `segment.l1` / `segment.l2` / `segment.l3` / `title.maxTokens` |
| 提醒 | `notice.enabled` / `notice.growthTokens` / `notice.growthResetPct`（不压之后门槛重设到原额的百分比，默认 40）/ `notice.notifySubagents`（子代理是否也参与，默认开）/ `triggerPct` |
| 行为 | `keepTurns`（原文区至少留几轮）/ `pruneFirst` / `foldCallRecord` / `requireSessionQuery` / `reservedTokens` |

**建议关掉宿主自带的自动压缩**（`compaction-basic` 的 `auto`，默认在 80% 时触发）。它一旦触发，会把这里的多层摘要重新拍平成一段高层摘要，细节永久丢失——插件本身不受影响，但效果会打折。本插件不能替你改那一行（它在 profile 的 `group` 里），需要你自己在 `cordis.patch.yml` 里写 `config: { auto: false }`。

---

## 依赖与边界

- **需要「会话搜索」插件**（`session_search` 等工具）。`requireSessionQuery` 默认为 `true`：一旦取回原文的能力不存在，`compress` 与 `context_map` 都会拒绝执行并说明原因——宁可上下文大着，也不做不可逆的事。想在没有它的情况下也能压，把这个开关关掉。
- 不依赖任何特定模型；不调用模型。
- 不实现 `ctx.compaction`、不改宿主压缩插件、不注册 message projection、不拦截网络。

---

## 已知限制

- **不自动压缩**：所有压缩都由模型在对话中主动发起；提醒只负责叫醒并给地图。
- **并行调用时折叠降级**：`compress` 和别的工具放在同一条消息里并行发时，调用记录只能改成"折地图、留每个键的结果"，参数里那份摘要副本要到下一次覆盖它的压缩才会消失。回执里会提醒模型别这么发。
- **图片台账只记前 6 个事件号**：张数永远是真数，但编号只列前几个（写全会吃掉几百 token），剩下的要按范围去会话搜索里找。
- **轮次大纲损坏时整轮报红**：缺轮/乱序这类真损坏会让本对话停用（宿主已取走的消息不会还给你），只能开新会话或先关掉插件。
- 子代理默认参与（可关）：它们同样会遇到已压缩的表层，没有轮次标记就会误读块覆盖了哪几轮。
---

## 许可与出处

MIT。

插件里检查点前导语（`This is an automatically generated checkpoint …`）与被压内容边界标签（`<compacted-summary>` / `</compacted-summary>`）的**文字**抄自 DSH 自带的 `@deepseek-ai/dsh-compaction-basic`（MIT）——宿主界面与日志靠这段文字识别检查点，必须逐字节一致。除此之外没有复制任何代码。

当前实现的完整规范见 [docs/SPEC.md](https://github.com/Light-EI/dsh-ebbing-context/blob/main/docs/SPEC.md)；设计推演与取舍见 [机制与实现路径](https://github.com/Light-EI/dsh-ebbing-context/blob/main/docs/机制与实现路径.md)。

---

## 参与

欢迎开 Issue 与 Discussion：使用中遇到的问题、对分层策略的想法、真机验证结果都很有用。

Pull Request 同样欢迎，但请先开 Issue 说明要改什么——这个插件的多数行为（提示词措辞、拒绝条件、折叠时机）都是针对宿主具体行为定的，改错一处可能让整个会话压不动，所以大改动需要先对齐设计。

本地跑测试（无依赖，Node ≥ 20）：

```bash
npm test
```

同一个测试集在 CI 里跑 Node 20 与 22 两档（见 `.github/workflows/test.yml`）。

安全问题**不要开公开 Issue**，走 [私密报告](https://github.com/Light-EI/dsh-ebbing-context/security/advisories/new)，细节见 [SECURITY.md](https://github.com/Light-EI/dsh-ebbing-context/blob/main/SECURITY.md)。
