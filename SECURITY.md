# 安全策略

## 报告问题

请**不要**开公开 Issue。用 GitHub 的私密报告入口：

<https://github.com/Light-EI/dsh-ebbing-context/security/advisories/new>

或者直接给维护者发邮件（见仓库主页 `Light-EI` 的联系方式）。

## 这个插件会碰什么

它**不读取文件、不发网络请求、不收集遥测**。全部行为是：

- 通过 DSH 插件 API 注册两个工具（`compress`、`context_map`）与一个命令（`/context-status`）；
- 在 `agent/pre-step`、`agent/turn-stopping`、`agent/request-error`、`agent/disposed`、`loader/volatile-update` 五个事件上做只读判断，必要时写会话事件；
- 压缩时向当前会话追加 `compaction/start`、`compaction/summary`、`user/message`、`compaction/end` 四条记录，并可能成对替换「工具调用 + 返回」这两个表层节点；
- 写一份滚动日志（默认 `~/.dsh/logs/ebbing-context.log`，只留两份）。

## 值得报告的情形

- 日志里出现会话全文、密钥、私有路径等不该落盘的内容；
- 任何导致会话再也发不出请求（宿主返回 400 / busy）的路径；
- 压缩后原文无法通过「会话搜索」取回；
- 插件向外部发出任何网络请求。

## 支持范围

只支持当前 `main` 分支的最新版本。
