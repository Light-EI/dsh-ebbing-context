# Ebbing Context

[![test](https://github.com/Light-EI/dsh-ebbing-context/actions/workflows/test.yml/badge.svg)](https://github.com/Light-EI/dsh-ebbing-context/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**模拟记忆衰退的 DSH 分层上下文压缩插件。**

模型自己决定压哪里、自己写摘要；插件只写宿主本来就认识的会话事件，把旧内容一层层降成更粗的表示：

```
原文（逐字） → L1 块（一段的结论与数据） → L2 块 → L3 块（只剩关键词句）
```

越旧的越粗，但**从来没有被删掉**——原文仍在会话日志里，装了「会话搜索」插件就能按事件号取回。

`ebbing` 是"渐渐消退"：降不降、降多少，由模型看着上下文压力自己决定，不是定时任务。

> **状态**：功能完整、测试全绿，已在真机装起来过，但**还没有一次完整跑通的压缩记录**。目标宿主 DSH 0.2.1-rc.3 ~ 0.2.2-alpha.2。试的时候请先备份 profile、用新会话试。
> 逐版变更见 [CHANGELOG](CHANGELOG.md)。

---

## 它怎么工作

- **两个工具 + 一条命令**：`context_map`（分层结构与占用）、`compress`（执行一次压缩）、`/context-status`（只读，同地图）。
- **键名 = 要压的那一层**：`l0` 压原文 → L1 块；`l1` 压 L1 → L2；`l2` 压 L2 → L3；`l3` 把整个 L3 区压成一块（唯一不写 `to` 的键）。
- **`to` 只能从地图上抄**：`l0` 写轮号（`T19`），`l1`/`l2` 写该区从 1 起的块序号。写错就被拒，拒绝回执里带刷新后的地图。
- **级联**：压深层时，比它浅且还能压的层必须同批给完，否则整批拒绝（只断一次前缀缓存）。
- **零台账**：不建库、不写状态文件；层级每轮从会话表层现算，块的身份写在正文第一行 `〔L1｜T16–T19｜ev 4121–4390〕标题`。
- **提醒但不代劳**：占用到线、又长了、某层超配额时，在本轮收尾把模型叫醒并附一张新地图。从不自动压缩，也不催 `/compact`。

完整设计（分层模型、级联、保护边界、配置、宿主约定、限制）见 [docs/SPEC.md](https://github.com/Light-EI/dsh-ebbing-context/blob/main/docs/SPEC.md)。

---

## 安装

> npm 包尚未发布（名字已占位 `dsh-ebbing-context`）；下面两种方式在真机上装起来过。

**方式一：从源码目录装（推荐）**

```bash
git clone https://github.com/Light-EI/dsh-ebbing-context.git
dsh plugin add ./dsh-ebbing-context
```

**方式二：手动挂到 profile**

1. 把仓库内容放进 profile 的 `node_modules/dsh-ebbing-context/`
2. 在 profile 的 `cordis.patch.yml` 里加一行 `dsh-ebbing-context:`（路径写法见 [docs/SPEC.md](https://github.com/Light-EI/dsh-ebbing-context/blob/main/docs/SPEC.md) 的"目录与开发"）
3. 重启 DSH

装完确认三件事：插件卡片显示**运行中**、`context_map` / `compress` 两个工具都在、`/context-status` 能出地图。

**建议关掉宿主自带的自动压缩**（`compaction-basic` 的 `auto`，默认 80% 触发）。它一旦触发会把多层摘要重新拍平，细节永久丢失。插件照样能压，只是效果打折。关的位置取决于你的安装方式与预设。

---

## 配置

共 17 项（`triggerPct`、`keepTurns`、`pruneFirst`、`foldCallRecord`、`requireSessionQuery`、`reservedTokens`、`budget.*`、`segment.*`、`title.maxTokens`、`notice.*`），在插件面板里改，改完点「保存」才生效。

默认值、含义与拒绝规则见 [docs/SPEC.md 第 6 节](https://github.com/Light-EI/dsh-ebbing-context/blob/main/docs/SPEC.md#6-配置17-项)。

---

## 依赖与边界

- 需要宿主提供 `agent/pre-step`、`agent/turn-stopping`、`agent/followup` 与会话表层 API。
- 默认要求装「会话搜索」（`session_search` 等），取不回原文就不让压。
- 只做"成对替换"或"只改 `tool/result` 正文"，从不单点删节点。
- 不联网、不读文件、不收集遥测。

## 已知限制

- 并行调用时不折叠（也不改写返回），摘要正文会以参数形式留在上下文里（插件会提醒以后单独发）。
- 折叠只在下一次请求发出之前做；错过这一步的那条就不再折，调用记录原样留着。
- 图片无法取回，只按张数记账。
- 轮次大纲损坏（日志缺 `turn/start` 或乱序）时，该轮报红色错误并停用。
- 区占用由插件自估（中文 1 字 ≈ 1 token），与宿主计价器略有差异，会略早提醒。

## 许可

MIT。

## 参与

Issue / PR 都欢迎。动手前请先看 [docs/SPEC.md](https://github.com/Light-EI/dsh-ebbing-context/blob/main/docs/SPEC.md) 的"依赖的宿主约定"一节；那是正确性的前提。
