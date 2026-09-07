# Hermes Desktop Plugins

两个 [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop) 插件：

| 插件 | 作用 |
|---|---|
| [turn-usage](#turn-usage) | 输入框上方显示本轮 / 会话 Token、缓存、花费、今日、模型 |
| [compress-context](#compress-context) | 一键压缩当前会话上下文（等同 `/compress`） |

## 安装

从 [Releases](https://github.com/LectWolf/hermes-desktop-plugins/releases) 下载 zip，解压到 Hermes 的 `desktop-plugins` 目录（文件夹名必须是 `turn-usage` / `compress-context`）。

- Windows：`%LOCALAPPDATA%\hermes\desktop-plugins\`
- macOS / Linux：`~/.hermes/desktop-plugins/`
- 若设置了 `HERMES_HOME`，则是 `$HERMES_HOME/desktop-plugins/`

装好后打开桌面端，`Ctrl+K`（macOS：`⌘K`）→ **Reload desktop plugins**。每个插件只需 `plugin.js`。

也可以 clone 源码后复制文件夹：

```bash
git clone https://github.com/LectWolf/hermes-desktop-plugins.git
cd hermes-desktop-plugins

# Windows (Git Bash)
cp -r turn-usage "$LOCALAPPDATA/hermes/desktop-plugins/"
cp -r compress-context "$LOCALAPPDATA/hermes/desktop-plugins/"

# macOS / Linux
# cp -r turn-usage ~/.hermes/desktop-plugins/
# cp -r compress-context ~/.hermes/desktop-plugins/
```

## 发版

打 `v*` 标签并推送后，GitHub Actions 会打包 zip 并创建 Release：

```bash
git tag v1.0.1
git push origin v1.0.1
```

---

## turn-usage

会话进行中，用量条贴在输入框正上方；回合结束后，在该轮最后一条回复下面钉一枚描边徽章。

![turn-usage preview](turn-usage/preview.png)

**条上会显示**

- 本轮输入 / 输出（多次请求加总）
- 当前会话累计 Token
- 缓存绝对量与命中率
- 本会话估算花费
- 今日花费（本机插件累计，跨会话）
- 当前模型与思考档

**用法**：装好即生效，不用配置。点击用量条或徽章可复制该行文本。中途补话不算新回合；点停止或模型自己停才结算。

---

## compress-context

在输入框模型选择左侧放一个折叠按钮，命令面板也可搜到。

**用法**

1. 等当前回合结束（进行中会提示先等一下）
2. 点折叠按钮，确认后开始压缩
3. 或 `Ctrl+K` / `⌘K`，搜「压缩上下文」/ `compress`

效果与内置 `/compress` 相同：较早的对话收成摘要，最近若干轮原文保留。长会话可能要一会儿。
