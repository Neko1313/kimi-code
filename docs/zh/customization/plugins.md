# Plugins

Plugins 把可复用的 Kimi Code CLI 能力打包成可安装单元：可以添加 [Agent Skills](./skills.md)、自定义 [Agent](./agents.md)，可以指定会话启动时自动加载的 Skill、提供系统提示词指令，也可以声明 MCP servers 提供真实工具能力。适合把工作流共享给团队、连接外部服务，或从 [官方插件](#官方插件)安装扩展。

## 安装与管理

在 TUI 中运行 `/plugins` 打开 plugin 管理器，面板内有四个 tab：

- **Installed**：管理已安装的 plugin
- **Official**：Kimi 官方 marketplace plugin
- **Curated**：默认 marketplace 中来自 Kimi 合作伙伴的第三方 plugin
- **Custom**：从 URL 安装

面板内按键：

| 按键 | 操作 |
| --- | --- |
| `Tab` / `Shift-Tab` | 在 Installed / Official / Curated / Custom 四个 tab 间切换 |
| `Space` | 启用或禁用选中的已安装 plugin（Installed tab） |
| `D` | 移除选中的已安装 plugin（Installed tab） |
| `M` | 管理选中 plugin 的 MCP servers（Installed tab） |
| `R` | 重新加载 `installed.json` 和所有 manifest（Installed tab） |
| `Enter` | Installed：有更新时安装更新，否则查看 plugin 详情；Official/Curated：安装或更新；Custom：安装 |
| `I` | 查看 plugin 详情（Installed tab） |
| `Esc` | 返回或取消 |

也可以使用斜杠命令：

| 命令 | 说明 |
| --- | --- |
| `/plugins` | 打开交互式 plugin 管理器 |
| `/plugins list` | 列出已安装 plugins |
| `/plugins install <path-or-url>` | 从本地目录、zip URL 或 GitHub 仓库 URL 安装 |
| `/plugins marketplace [source]` | 浏览官方 marketplace，或传入自定义 marketplace JSON 的路径或 URL |
| `/plugins info <id>` | 查看 plugin 详情和 diagnostics |
| `/plugins enable <id>` | 启用 plugin |
| `/plugins disable <id>` | 禁用 plugin |
| `/plugins remove <id>` | 移除 plugin（需二次确认） |
| `/plugins reload` | 重载 `installed.json` 和各 plugin manifest |
| `/plugins mcp enable <id> <server>` | 启用 plugin 声明的 MCP server |
| `/plugins mcp disable <id> <server>` | 禁用 plugin 声明的 MCP server |

### 从 GitHub 安装

通过 `/plugins install <url>` 可以直接从 GitHub 仓库安装，支持四种 URL 形式：

- `https://github.com/<owner>/<repo>`：安装最新 release；无 release 时回落到默认分支
- `https://github.com/<owner>/<repo>/tree/<ref>`：安装指定分支、tag 或短 commit SHA
- `https://github.com/<owner>/<repo>/releases/tag/<tag>`：钉死具体 tag
- `https://github.com/<owner>/<repo>/commit/<sha>`：钉死具体 commit

网络请求只走 `github.com` 重定向和 `codeload.github.com` 下载，不调用 `api.github.com`。

### 注意事项

- 安装、启用/禁用、移除 plugin 后，当前会话不会更新，运行 `/reload` 或 `/new` 后生效。
- 本地安装会被拷贝到 `$KIMI_CODE_HOME/plugins/managed/<id>/`，CLI 始终从这份托管副本运行。安装后编辑原始源目录不会生效，需重新安装。
- 移除 plugin 只会删除安装记录，托管副本和原始源文件仍保留在磁盘上。
- Plugin 目前按用户安装，对所有项目生效，暂不支持项目级安装范围。

### 自定义 marketplace JSON

浏览自定义目录时，把 JSON 路径或 URL 传给 `/plugins marketplace <source>`，或通过 [`KIMI_CODE_PLUGIN_MARKETPLACE_URL`](../configuration/env-vars.md) 覆盖默认 marketplace。`plugins` 数组中每个条目需要 `id` 和 `source` 两个字段，`source` 支持本地路径、zip URL 和 GitHub URL：

```json
{
  "version": "2",
  "plugins": [
    {
      "id": "my-plugin",
      "displayName": "My Plugin",
      "source": "./my-plugin"
    }
  ]
}
```

Marketplace 条目还可以通过 `clients`（`desktop`、`cli` 或两者）和 `platforms`（`macos`、`windows`、`linux` 或 `cloud`）限制可用范围。`clients` 选择产品宿主，`platforms` 选择 server 操作系统，两个条件必须同时满足。未声明 `clients` 时，条目对两种宿主均可用。Web 和 Remote Control 跟随所连接 server 的宿主，不使用浏览器所在设备的操作系统判断。

安装记录仍共享在 `$KIMI_CODE_HOME` 下。某个宿主不可见的条目也不会出现在该宿主的已安装列表和运行能力中。最近一次成功获取的可用性配置缓存在 `$KIMI_CODE_HOME/plugins/availability.json`；目录配置变化后，成功刷新即可隐藏或恢复已有安装，无需重新安装，也不会删除插件文件。

## 官方插件

官方插件是 Kimi 官方维护的 plugin 和内置产品能力，目前有以下三种：

- **[Kimi Datasource](#kimi-datasource)**：用自然语言查询金融行情、财经资讯、宏观经济、企业工商、学术文献、法律法规和国际组织官方数据
- **[Kimi Browser Extension](#kimi-browser-extension)**：让 AI 直接操控你自己的浏览器，完成各类网页操作
- **[Kimi Computer Use](#kimi-computer-use)**：让 AI 操作你的桌面应用（macOS 和 Windows）

### 安装与升级

官方插件的安装与升级流程一致：

1. 运行 `/plugins`，按 `Tab` 键选中 **Official** tab
2. 找到要安装的插件，按 `Enter` 安装
3. 安装完成后运行 `/reload` 或 `/new` 激活

::: info 说明
Kimi Browser Extension 分两步安装：完成上述步骤后，还需要[安装浏览器扩展](#install-the-browser-extension)才能使用。
:::

官方插件不会自动更新，使用旧版时会提示更新。升级到新版本只需重复上述安装步骤。

### Kimi Datasource <Badge type="tip" text="v3.4.0" />

Kimi Datasource 是 Kimi Code 官方数据插件。用自然语言直接查询金融行情、财经资讯、宏观经济、企业工商、学术文献、中国法律法规和国际组织官方数据，无需手动调用接口或申请数据账号。

数据来源包括世界银行、IMF、OECD、FRED、WHO、FAO、国家统计局、Wind、S&P Capital IQ、SEC EDGAR、财新、新华财经、恒生聚源等权威机构与知名数据库，信源可溯源。

> 使用前需先通过 `/login` 完成 Kimi Code 账号 OAuth 登录。数据查询会消耗 Kimi Code 套餐额度。

#### 使用方式

1. 直接用自然语言描述需求，Kimi Code 会自动调用数据能力
2. 通过 `/skill:kimi-datasource:kimi-datasource` 明确触发数据查询 Skill

#### 能做什么

::: details **实时量化研究** — 想盯着茅台做个量化分析？
一句话拉取近三年的每日收盘价、MACD 和 KDJ 信号，直接出结论，不用找第三方数据平台。
:::

::: details **跨国宏观对比** — 研究中印越产业转移？
基于世界银行 50 年历史数据，一次查询拿到三国 GDP 增速、贸易额、人口结构的完整时间序列对比。
:::

::: details **合同前风险排查** — 签合同前五分钟才想起来查对方背景？
输入公司名，立刻拿到工商注册信息、股权穿透、司法纠纷和失信记录，当场决策。
:::

::: details **文献综述加速** — 写论文要梳理 RLHF 领域的研究脉络？
直接列出高引论文、主要作者和核心结论，综述提纲半小时内成型。
:::

::: details **法律条文速查** — 碰上居住权合同纠纷想确认法条？
一句话定位《民法典》相关条文原文、效力级别和时效性，再顺手拉几个相近判例佐证，不用翻法规库。
:::

::: details **机构级美股研究** — 要写一份美股深度报告？
一句话拉出年报原文、标准化财务指标、前 50 大股东和分析师一致预期，不用在多个数据终端之间来回切。
:::

::: details **财经资讯与行业数据** — 想追市场热点或政策动向？
直接查询财新的市场资讯、债券基金期货数据与上市公司产业链关系，以及新华财经国家金融信息平台的资讯、政策、公告与市场快讯，信源权威可溯源。
:::

::: details **标准查询** — 查合规要对照国标？
按标准号或主题查询国标、行标、地标和团标的编号、状态与全文入口。
:::

#### 数据覆盖

| 类别 | 覆盖范围 |
| --- | --- |
| 股票与金融市场 | Wind、S&P Capital IQ、SEC EDGAR 等；A 股、港股、美股行情、技术指标、财报估值、分析师预期，8,000+ 美股上市公司官方披露文件 |
| 财经资讯与行业数据 | 财新、新华财经等；市场资讯与快讯、上市公司公告、监管政策、债券基金期货数据、企业失信记录、产业链关系 |
| 宏观经济 | 世界银行、IMF、OECD、FRED、国家统计局及 WHO、FAO 等；全球 189 个国家 50 年以上时间序列，中国全国/省/市指标（GDP、贸易、人口、汇率、CPI、国际收支） |
| 中国标准 | 国家标准（GB）、行业标准、地方标准、团体标准的编号、名称、发布状态与详情；部分国标和公开团标提供官方全文入口 |
| 企业数据 | 中国大陆企业工商信息、股权穿透、司法风险、关联图谱 |
| 学术文献 | 物理、数学、计算机、金融、经济等领域百万量级论文，支持预印本查询 |
| 法律法规 | 元典智库等；中国法律法规与司法案例，含各效力层次法规检索与详情、权威判例检索 |
| 智能筛选 | 恒生聚源等；自然语言选股、选基金、选基金经理，及宏观行业数据、研报、公告与新闻 |

#### 计费与限制

- 数据查询按次计费，消耗 Kimi Code 账号额度
- 插件为只读查询，不提供任何写入或交易功能
- 技术指标（MACD、KDJ 等）及实时行情仅在交易时段内可用
- AI 输出内容仅供参考，不构成任何投资或商业决策建议

<a id="kimi-webbridge"></a>

### Kimi Browser Extension <Badge type="tip" text="v2.0.11" />

Kimi Browser Extension 让 AI 直接操控你的浏览器，带着你的登录状态和 Cookie 打开网页、阅读内容、点击按钮、填写表单、截图保存，把重复的网页操作交给它完成。产品介绍见 [Kimi Browser Extension 官网](https://www.kimi.com/products/kimi-browser-extension)。

<a id="install-the-browser-extension"></a>

#### 安装浏览器扩展

通过 `/plugins` 安装后，还需要在浏览器中安装 Kimi Browser Extension 扩展才能使用。有两种安装方式：

**方式一：应用商店安装（推荐）**

打开 [Chrome 应用商店](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc) 或 [Edge 应用商店](https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg)，点击添加即可。

**方式二：手动安装**

无法访问应用商店时使用这种方式，按以下步骤操作：

1. [下载扩展安装包](https://kimi-web-img.moonshot.cn/webbridge/latest/extension/kimi-webbridge-extension.zip) 并解压
2. 在浏览器地址栏输入 `chrome://extensions/` 打开扩展管理页，开启右上角的**开发者模式**

   ![开启开发者模式](../../media/webbridge-dev-mode.jpeg)

3. 点击左上角的**加载未打包的扩展程序**，选择解压后的 `kimi-webbridge-extension` 文件夹

   ![加载未打包的扩展程序](../../media/webbridge-load-unpacked.jpeg)

4. 安装完成后，浏览器工具栏会出现 Kimi Browser Extension 图标，即表示安装成功

   ![工具栏出现 Kimi Browser Extension 图标](../../media/webbridge-install-success.jpeg)

#### 能做什么

- **网页操作自动化**：你说话，AI 帮你点网页、填表单、读内容、截图，把重复性的网页操作交给它
- **社媒热点选题**：自动浏览 X（Twitter）、微博、小红书的热门话题，筛选你感兴趣的方向，逐个打开高赞内容截图、提取核心观点，整理成素材库并给出选题建议
- **求职信息搜集**：在招聘网站按条件筛选岗位（关键词、城市、岗位类型），把岗位名称、链接、公司、薪资、投递方式整理成表格
- **竞品分析**：自动在多个 AI 产品间批量发问并采集回答，生成横向对比报告
- **机票比价**：在多个旅行平台查询同一行程，按价格排序记录航司、起降时间和原始链接，给出推荐方案

### Kimi Computer Use <Badge type="tip" text="v0.5.4" />

Kimi Computer Use 让 AI 直接操作你的桌面应用，可以完成点击、拖拽、滚动、输入等操作。macOS 版全程在后台静默运行，不抢占你的鼠标；少量弹窗操作仍会唤起前台 App。Windows 版的差异见 [Windows 版注意事项](#windows-版注意事项)。

#### 授权（macOS）

安装后首次使用时，Kimi Computer Use 会弹出授权窗口，按照提示操作即可：

1. 点击**辅助功能**和**屏幕录制**右侧的**去授权**，在系统设置中开启这两项权限。前者用于执行点击、输入与滚动，后者用于读取屏幕内容、识别需要操作的位置。
2. 在**接入本地 Agent**中打开 **Kimi Code** 开关，重启 Kimi Code 后生效。

<div style="max-width: 380px; margin: 0 auto;">

![Kimi Computer Use 授权窗口](../../media/kimi-computer-use-auth.jpeg)

</div>

#### Windows 版注意事项

- **会短暂占用键鼠**：Windows 版无法像 macOS 版那样稳定地全程后台输入，执行操作时可能短暂激活目标窗口并使用你的鼠标键盘
- **系统要求**：Windows 10 version 1903（Build 18362）或更新版本 / Windows 11，x64；需要真实交互式桌面会话，Windows Server 需要 Desktop Experience
- **无需额外授权**：Windows 不需要 macOS 那样的**辅助功能**和**屏幕录制**权限
- **权限对等**：目标应用以管理员权限运行时，KimiCU 也需要以同等权限运行

#### 能做什么

- **在桌面软件整理和录入信息**：让 AI 把散落在各处的信息整理进备忘录、表格或笔记软件，不用手动逐条输入
- **测试网站和应用流程**：将重复的测试步骤交给 AI，截图确认渲染和跳转是否正常
- **处理重复操作**：反复打开、复制、粘贴、检查类型的工作，让 AI 在后台静默完成，不抢占鼠标
- **操作无接口的软件**：操作没有 CLI 或 API 的桌面端应用，例如把剪映里这段视频的片头剪掉三秒再导出

::: warning 注意
涉及资金、账号和对外发布的操作不建议使用此能力。
:::

## Plugin manifest

Plugin 是一个带 manifest 的目录或 zip 文件。Manifest 可以放在以下任一位置：

```text
<plugin_root>/kimi.plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

两个文件同时存在时，以 `kimi.plugin.json` 为准。

示例：

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "description": "Finance data and analysis workflows for Kimi Code CLI",
  "skills": "./skills/",
  "systemPromptPath": "./SYSTEM.md",
  "sessionStart": {
    "skill": "using-finance"
  },
  "interface": {
    "displayName": "Kimi Finance",
    "shortDescription": "Market data and financial analysis workflows"
  }
}
```

支持的字段：

| 字段 | 说明 |
| --- | --- |
| `name` | 必填，作为 plugin id，必须匹配 `[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(@[A-Za-z0-9_-]+)?` |
| `version`、`description`、`keywords`、`author`、`homepage`、`license` | 展示元数据 |
| `interface` | 在 `/plugins` 中展示的字段：`displayName`、`shortDescription`、`longDescription`、`developerName`、`websiteURL`；另见下方的能力展示覆盖 |
| `skills` | 一个或多个 `./` 路径，必须位于 plugin 根目录内。省略时根目录的 `SKILL.md` 被当作单个 Skill root |
| `agents` | 一个或多个 `./` 路径，必须位于 plugin 根目录内，指向含有 [Agent 文件](./agents.md#自定义-agent) 的目录。省略时若根目录存在 `agents/` 目录则自动采用 |
| `sessionStart.skill` | 在新会话或恢复会话开始时，把指定 plugin Skill 加载到 main agent |
| `skillInstructions` | 每次加载此 plugin 的 Skill 时一并附带的额外说明 |
| `systemPrompt` | plugin 启用期间提供给 Agent 系统提示词的内联指令 |
| `systemPromptPath` | 指向 UTF-8 文本文件的 `./` 路径；同时设置 `systemPrompt` 时，文件内容拼接在内联指令之后 |
| `mcpServers` | MCP server 声明，默认启用，可从 `/plugins` 中禁用 |
| `hooks` | 在 plugin 启用期间于生命周期事件上运行的 hook 规则，见 [插件中的 Hooks](#插件中的-hooks) |
| `commands` | 一个或多个 `./` 路径，指向目录或 `.md` 文件，把其中的 Markdown 文件注册为斜杠命令，见 [插件斜杠命令](#插件斜杠命令) |

`interface.mcpOverrides` 以 `mcpServers` 中的服务键为键，可为对应 MCP 服务提供展示用的 `displayName`、`description` 和 `iconUrl`。这些字段不改变 MCP 服务名称或运行配置。

`interface.skillOverrides` 以技能目录名为键，可为对应技能提供展示用的 `displayName` 和 `description`。它们只影响插件信息展示，不改变技能的调用名称或 `SKILL.md` 内容。

`interface.defaultLocale` 声明 `interface` 默认文案的语言。`interface.locales` 可指向插件根目录内的翻译目录（例如 `./locales/`），其中的 `<语言>.json` 文件（例如 `en-US.json`）可提供上述展示字段及两类 overrides。读取插件详情或预览时可指定 `locale`，匹配的翻译用于能力展示，未提供的字段回退到默认 `interface`。

`tools`、`apps`、`inject`、`configFile` 等不支持的运行时字段会显示为 diagnostics 并被忽略。

### 系统提示词指令

Plugin 通过 `systemPrompt` 和 `systemPromptPath` 两个字段向 Agent 的系统提示词注入指令。本节按三块说明：写法与读取时机、大小限制、两个引擎的差异。

### 写法与读取时机

短指令可以直接写在 `systemPrompt`，较长内容则用 `systemPromptPath` 指向 plugin 根目录内的文件。两个字段同时存在时，内联文本在前，文件内容在后。文件内容在安装或重载 plugin 时读取，修改文件后需要 `/plugins reload` 才会生效。例如：

```json
{
  "name": "code-review",
  "systemPromptPath": "./SYSTEM.md"
}
```

内置 Agent 提示词会自动包含已启用 plugin 的指令。自定义 `SYSTEM.md` 或 Agent 文件完全拥有自己的模板，应在希望出现 plugin 指令的位置加入 `${plugin_sections}`。如果自定义模板包含 `${base_prompt}`，且该有效默认提示词已经包含 plugin 块，则不要再重复加入 `${plugin_sections}`。变量完整列表见 [自定义 Agent 与 SYSTEM.md](./agents.md#用-systemmd-覆盖-main-agent-的系统提示词)。

### 大小限制

`systemPrompt` 字段与 `systemPromptPath` 文件各限制为 32 KB（UTF-8 字节），超限内容会被忽略并显示在 plugin 的 diagnostics 中。一次提示词构建最多注入所有已启用 plugin 合计 64 KB 的指令，超出预算的贡献会被跳过并给出警告；单个 plugin 的内联文本与文件合计超过该预算时同样整体跳过。

### 两个引擎的差异

系统提示词贡献在 Kimi Code 的所有界面上都生效：交互式 TUI、`kimi -p` 和 `kimi web` 都运行在 v2 引擎上。

新会话和新建 Agent 会读取当前已启用 plugin 的指令，正在进行的请求继续使用已有的系统提示词。`/plugins reload` 会刷新 plugin Skill 列表，并请求重建活跃 Agent 的提示词；需要让变更在下一轮前明确收敛时使用该命令。切换 plugin 的 MCP server 不会改变系统提示词指令。

<details>
<summary>两个引擎下的指令刷新行为</summary>

在 v2 引擎中，安装、启用、禁用或移除 plugin 会立即更新 catalog，后续的提示词重建可能会读取新的指令。legacy 引擎中每个活跃 session 保留自己的 plugin 快照，直到 `/plugins reload` 或创建新 session。从磁盘恢复的 session 先使用持久化的提示词，后续重建再遵循对应引擎的行为。

</details>

## 插件斜杠命令

斜杠命令把一段常用提示词存成 `/命令`，输入即可触发。

下面是一个最小完整例子，插件目录结构：

```text
kimi-finance/
  kimi.plugin.json
  commands/
    report.md
```

manifest（`kimi.plugin.json`）用 `commands` 字段指出命令文件的位置：

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "commands": "./commands/"
}
```

命令文件 `commands/report.md` 中，顶部两行 `---` 之间是 frontmatter，其下正文是触发时发给 Agent 的提示词：

```markdown
---
description: 拉取指定股票的财报并总结
---

拉取 $ARGUMENTS 的最新财报数据，总结营收、利润和关键风险。
```

安装并启用后，在对话里输入：

```text
/kimi-finance:report TSLA
```

Kimi 会把正文里的 `$ARGUMENTS` 替换成 `TSLA`，再执行这段提示词。三处细节分述如下。

### 声明命令（`commands` 字段）

`commands` 填一个 `./` 路径或路径数组，指向 plugin 根目录内的目录或 `.md` 文件：

- 指向**目录**：递归收集其中所有 `.md` 文件，每个文件各成为一个命令。
- 指向**单个 `.md` 文件**：只注册这一个。
- 指向非 `.md` 或不存在的路径：显示为 diagnostics 并被忽略。

### 编写命令文件

命令文件分两部分：可选的 **frontmatter**（顶部两行 `---` 之间，可写 `name`、`description`）和**正文**（`---` 之后的提示词）。两个字段省略时的回退规则：

- `name`（命令名）：省略时按文件相对 `commands` 的路径命名，去掉 `.md`、以 `/` 分隔，如 `commands/frontend/component.md` 注册为 `frontend/component`；frontmatter 里显式写的优先
- `description`（命令列表里的说明）：省略时取正文首行非空文字，超 240 字符截断；正文也为空则显示 `No description provided.`

### 调用命令与传参

命令自动以插件 id 作前缀注册成 `<插件名>:<命令名>`，所以上面的命令实际叫 `/kimi-finance:report`，不同插件的同名命令因此不会冲突。

命令后输入的文字会替换正文里的 `$ARGUMENTS`。若正文没写 `$ARGUMENTS` 却传了参数，参数不会丢弃，而是以 `ARGUMENTS: <你输入的内容>` 追加到正文末尾。

## Skills 与会话启动

Plugin Skills 使用与普通 [Agent Skills](./skills.md) 相同的 `SKILL.md` 格式，典型目录结构如下：

```text
my-plugin/
  kimi.plugin.json
  skills/
    using-my-plugin/
      SKILL.md
    another-workflow/
      SKILL.md
```

`sessionStart.skill` 在会话启动时把一个 plugin Skill 加载到 main agent，适合放置初始化说明、工作流规则，或把其他工具中的术语映射到 Kimi Code CLI。它只注入文本，不执行代码。字段值是插件内 Skill frontmatter 中声明的名字，不带 `<plugin-id>:` 前缀。

Plugin Skill 以全限定名 `<plugin-id>:<skill-name>` 列出和调用（例如 `/skill:my-plugin:using-my-plugin`），与[插件斜杠命令](#插件斜杠命令)的命名方式一致：不同插件的同名 Skill 互不冲突，裸名不会解析到 plugin Skill。当插件命令与插件 Skill 同名时，`/plugin-id:name` 执行命令；调用 Skill 需使用显式形态 `/skill:plugin-id:name`。

无论 Skill 通过哪种方式加载（`sessionStart.skill`、`/skill:<name>` 或模型自动调用），`skillInstructions` 都会随该 plugin 的 Skill 一起出现。

## 插件 Agent

Plugin 可以携带自定义 Agent：在 manifest 的 `agents` 字段里声明一个或多个 `./` 目录，或直接在 plugin 根下放置 `agents/` 目录。其中的 Agent 文件与 [自定义 Agent](./agents.md#自定义-agent) 格式相同，会在 plugin 启用期间作为 subagent 被 main agent 自动发现和委派。

```text
my-plugin/
  kimi.plugin.json
  agents/
    reviewer.md
```

Plugin Agent 的优先级低于其他文件来源：同名时用户级、额外目录、项目级和 `--agent-file` 的 Agent 都会覆盖 plugin 提供的版本；替换内置 Agent 同样需要在 frontmatter 里显式写 `override: true`。安装、启用、禁用或移除 plugin 后，Agent 列表在新会话或 `/reload` 时刷新；v2 引擎的当前会话还会在 `/plugins reload` 后刷新。

## Plugin 中的 MCP servers

当 plugin 需要真实工具能力时，可以在 manifest 中声明 `mcpServers`，复用 [MCP](./mcp.md) 的 schema。

Stdio server（本地命令）：

```json
{
  "mcpServers": {
    "finance": {
      "command": "uvx",
      "args": ["kimi-finance-mcp"]
    }
  }
}
```

HTTP server（远程服务）：

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

对于 stdio servers，`command` 可以是 `PATH` 上的命令，也可以是 plugin 根目录内以 `./` 开头的路径。`cwd` 同理，必须以 `./` 开头并位于 plugin 根目录内，否则该 server 会被忽略。

Plugin MCP servers 会在 `/reload` 后或新会话中启动。启用或禁用某个 server：

```sh
/plugins mcp disable kimi-finance finance
/reload

/plugins mcp enable kimi-finance finance
/reload
```

## 插件中的 Hooks

plugin 可以在其 manifest 中声明 hook 规则，在 plugin 启用期间于生命周期事件上运行。每一项的字段与 [`config.toml` 中的 `[[hooks]]` 规则](./hooks.md#配置) 相同（`event`、`matcher`、`command`、`timeout`）：

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "Bash",
      "command": "node ./hooks/check-bash.mjs",
      "timeout": 5
    }
  ]
}
```

plugin hooks 复用与全局 hooks 相同的机制。事件列表、stdin JSON 载荷、退出码与返回值对主流程的影响，详见 [Hooks](./hooks.md)。两者区别：

- plugin 的 hooks 仅在 plugin **启用**期间生效；禁用 plugin 后其 hooks 停止运行。
- 每条 hook 的工作目录为 plugin 根目录，`command` 可以使用 plugin 内的 `./` 路径。
- hook 进程会额外收到两个环境变量：`KIMI_CODE_HOME` 和 `KIMI_PLUGIN_ROOT`（plugin 根目录）。

仅安装 plugin 本身不会运行其 hooks；它们只在 plugin 启用期间、匹配的事件触发时运行。

## 实验性运行时模块

运行时插件可以处理引擎事件、注册命令和带 JSON Schema 的方法、运行原生子 Agent，并绘制交互面板。启动 Kimi Code CLI 前设置 `KIMI_CODE_EXPERIMENTAL_PLUGIN_RUNTIME=1`，然后在 `/plugins` 中启用插件。此功能需要 v2 引擎；未启用实验开关时，运行时模块不会加载。

```json
{
  "name": "example-runtime",
  "runtime": {
    "modules": ["./runtime/index.ts"],
    "capabilities": ["events", "state", "store", "ui", "command", "domains"]
  }
}
```

模块导出 `register(on)`。使用 `on(event, handler)` 注册中间件，`on.command(name, description, handler)` 注册斜杠命令，`on.domain(name, methods)` 注册包含输入及可选输出 JSON Schema 的方法。命令完整名称为 `/plugin-id:name`；没有歧义时也支持短名称。方法名称为 `plugin-id.domain.method`，可通过 `Plugin` 工具或 SDK 的 `session.plugins.call()` 调用。启用实验开关后，默认 main agent 会提供 `Plugin`；显式列出工具的自定义配置需要包含该工具。

```ts
import type { RuntimeRegistrar } from '@moonshot-ai/kimi-code-sdk/plugin';

export function register(on: RuntimeRegistrar) {
  on.command('panel', 'Open the example pane', async ($) => {
    await $.ui.open({ id: 'example-runtime:panel', title: 'Example' });
  });
  on('ui.render', ($, event, next) => {
    if (event.data.requestId !== 'example-runtime:panel') return next();
    return { type: 'text', text: 'Hello from a plugin' };
  });
}
```

宿主 API 按声明的能力检查事件、日志、持久化存储、客户端视图状态、定时器、进程、原生 Agent、会话任务、命令、自定义域、隔离脚本和 UI 的访问。持久化更新为原子操作；`$.state` 在插件的 Agent 会话内共享，`$.view` 额外按客户端隔离 UI 选择状态。原生 Agent 必须明确指定已配置的 `[secondary_model.models]` 池中的模型别名，并保留引擎权限检查。禁用或重新加载插件会取消其定时器和后台任务。

将 `runtime.api` 设为 `"claude-mods"` 可启用实验性 Claude Mods 配置。模块使用扁平事件参数、对象匹配器、`engine.create` 自定义 API，以及 `$.ui.resolve(e)` 提供的 `Box`、`Text`、`Button`、`Select` 和单行 `Input`。TSX 在加载时编译。`$.state.get({ plugin, key, id? })` 读取值和版本；仅所有者可写入，`set` 支持 `ifVersion`，并拒绝渲染期间的写入。Kimi 扩展位于 `$.kimi`。省略 `runtime.api` 时保留上述原生 API。

Mods 可从 `claude-code` 导入 `atom`、`read` 和 `update` 来管理响应式状态。`atom` 定义冻结的地址和默认值；`read` 返回已存储的值，或在没有值时返回默认值，不执行写入。`update` 应用同步函数；若其他更新先写入，则通过版本检查重试写入。冲突会刷新读取快照以供重试。这些辅助函数保留所有者检查，以及禁止在渲染期间写入的限制。可选的 atom 结构标签让新代码将旧存储格式视为不存在。此功能不会启用尚未支持的渲染位置或元素。

持久 Mods UI 现在通过 `AbovePrompt` 显示在编辑器上方，支持两种终端模式。`ui.status` 和会自动消失的 `ui.toast` 消息也显示在此处。按 `Ctrl+Shift+B` 将焦点移到插件控件，再使用 `Tab`、`Enter` 和 `Esc`。键盘焦点会显示 mod 通常在悬停时才显示的控件；仍然隐藏或已禁用的控件不会进入键盘导航。启用 UI 插件并配置模型后，会在第一条消息之前创建空会话，以便初始化控件，但不会启动模型轮次。没有启用 UI 插件时，仍延迟创建会话。适配器提供 `session.id/model/version/surfaces/usage`；用量包含原生上下文数据，以及通过已登录 Kimi 账户获取、缓存 30 秒的额度窗口。月度窗口使用 `monthly` 和 `monthly_code`；mod 可能忽略不认识的类型。不会编造缺失的账户额度、费用或详细上下文分类。Clawd 提供终端角色，Atelier 提供上下文和额度栏；需分别安装两个插件目录。

若要启用 SVG 动画，还需设置 `KIMI_CODE_EXPERIMENTAL_PLUGIN_GRAPHICS=1` 并安装 Chrome 或 Chromium。图形模式可在编辑器上方和插件面板中播放原始 Clawd 场景；终端支持时使用图像，否则使用彩色字符单元，并保留可读标签和键盘控件。动画帧在 UI 内更新，不启动模型轮次。

设置 `KIMI_CODE_PLUGIN_GRAPHICS=cells` 可强制使用彩色字符单元，设置为 `off` 可保留文本模式。必要时可将 `KIMI_CODE_PLUGIN_GRAPHICS_BROWSER` 设为浏览器可执行文件的绝对路径。渲染器使用临时配置目录，阻止 SVG 的外部资源请求，并保持浏览器沙箱启用；启动失败时会显示提示并回退到文本。自定义主题可通过 `canvasBackground` 设置画布背景。

Mods 配置支持 `tool.register/list/call/check`、`agent.spawn/list/stop`、`prompt.compose` 和 `prompt.context`，分别由 `tools`、`agent` 和 `prompt` 能力控制。工具调用使用原生校验和权限流程；中间件不能覆盖拒绝规则，也不能自动批准需要审批的调用。`tool.describe`、`tool.check`、`tool.call`、`prompt.section`、`prompt.compose` 和 `prompt.context` hooks 会影响实际请求和执行。`agent.spawn` hooks 包装原生创建服务，涵盖内置 Agent 调用和分叉。这是受支持的兼容子集：Claude 模型、音频 API、Agent 定义和恢复 API、Client/光栅元素及通用渲染位置替换仍不可用。

也可识别原始 Mods 打包格式：安装包含 `.claude-plugin/plugin.json` 和 `hooks/hooks.json` 的本地插件目录，后者通过 `modules` 数组声明模块。Kimi 会自动选择 Mods 适配器，并传入清单中 `userConfig` 的默认值。原始 mod 作为可信代码运行，可访问所有受支持的宿主命名空间。此功能导入 hook 模块，不转换 Claude `hooks/hooks.json` 中的传统 shell hooks。

原始 Anthropic `agents-md` mod 已通过不修改源码的测试。其 `fs.ancestors`、`session.root/cwd` 和 `env.get` 调用使用当前环境及原生 Read 权限检查；原生清单需声明 `fs`、`session` 和 `env` 能力。嵌套指令在 Read 结果之后进入 Agent 上下文，按 Agent 去重，并由分叉继承。清空、压缩上下文或重新加载运行时后，会重新加载初始指令上下文。Kimi 现有的 `AGENTS.md` 加载器仍然启用。可在 `config.toml` 中覆盖 mod 选项：

```toml
[plugin_runtime.options."agents-md"]
instructionFiles = "claude-md-and-agents-md"
```

其他可用值为 `claude-md-or-agents-md`（默认）、`claude-md` 和 `managed-only`。这些模式转换 Kimi 提供的指令集合，不会导入 Claude 的加载器或托管策略系统。修改选项后请重新加载插件。

Mods hooks 可在注册期间附加一个 `.catch(handler)`。处理函数读取 `next.error` 和 `next.called`；其中的 `next(e)` 会复用已有的后续处理结果，或仅启动一次后续处理。失败的 hook 若未返回恢复结果，会继续传递原始事件，或保留已经产生的结果。普通 hook 有 10 秒自身运行时间，恢复处理函数有 1 秒；等待宿主 API 或 `next` 不消耗此预算。通过 `next.budget` 读取实时剩余时间，并向长时间操作传入 `next.signal`。过期的处理函数不能发起新的宿主调用或继续传递事件。这些定时器采用协作式机制，无法抢占可信 Node.js 代码中的同步无限循环。

`next.origin` 在事件载荷之外标识调用方：引擎事件使用 `{ plugin: 'engine', tier: 'core' }`，插件 API 调用使用插件名称和 `user` 层级。mod 自己发起的 API 调用会跳过其 hooks；通过其他插件形成的循环也会受到保护。catch 可处理 `next.error.kind === 're-entry'`。已声明的后台任务和 `$.clock` 回调使用各自的执行帧。托管层级路由和 `sec-default` 兼容仍不可用。

安装并启用 `packages/core-plugins/kimi-workflow` 和 `packages/core-plugins/kimi-workflow-ui` 后，运行 `/workflows`。模型会获得 `Workflow` 工具，通过当前会话的内部 Agent harness 运行工作节点。可选 UX 插件提供阶段/Agent 浏览器并替换 `/tasks`。禁用 UX 插件会恢复内置任务浏览器。旧的进程计划命令和待处理文件分发入口已移除。

工作流是关联到发起工具调用的原生后台任务。最终结果通过常规任务通知送达；停止任务会取消其工作节点。指定结果 Schema 的工作节点通过 `StructuredOutput` 提交结果；无效结果在同一个 Agent 中修正，最多允许五次校验失败。增量日志可跨重启保留已完成结果，也能读取早期工作流快照。

可选的 `tokenBudget` 在工作节点之间共享输出 token 目标。脚本可读取 `budget.total`、`budget.spent()` 和 `budget.remaining()`。宿主限制单次请求、统计已报告的用量，并在目标耗尽时停止运行。用量异步到达，因此已发出的并发请求仍可能超过目标；供应商未报告输出 token 用量时，设置了目标的运行会明确失败。`prefixStaggerMs` 在启动具有相同共享前缀的工作节点前，等待首个工作节点开始响应，默认最多等待 5000 ms；设为 0 可禁用等待。缓存是否可用仍取决于供应商。

工作流流水线的各阶段接收 `(previousResult, originalItem, index)`。失败分支返回 `null` 并记录错误，其他项目继续执行；使用 `parallel(tasks, { failFast: true })` 或 `pipeline(items, stage1, stage2, { failFast: true })` 可在首次分支错误时停止运行。阶段元数据支持 `{ title, detail?, model }`，也保留先前的 `{ name, description?, model }` 格式，每个阶段都必须明确指定模型。请通过 `args` 传入时间戳和随机种子：工作流脚本无法读取隐式当前时间或调用 `Math.random()`，以便恢复运行时重放相同的调用。

插件可通过 `runtime.tools` 暴露模型工具：它是 `{ name, description, method, inputSchema, isDeferred? }` 对象的数组，需要 `tools` 能力。`method` 是插件内的方法，例如 `workflow.run`；不能替换已有工具名称。动态 `tool.register` 贡献限定在会话内，并以 `mcp__plugin-id__name` 发布。工具调用保留 `Plugin(plugin-id.domain.method)` 权限规则，Agent 配置必须允许 `Plugin` 才会激活这些工具。

使用 `/panes` 打开已注册的面板。`/workflows` 和插件任务视图通过与 `/model` 相同的对话框宿主打开在输入框位置，对话记录保持完整宽度。后台运行不会自动替换输入框。Tab/Shift-Tab 切换控件，方向键导航，Enter 激活，PgUp/PgDn 滚动长输出，Escape 取消对话框并恢复输入。关闭对话框不会取消后台任务。

在全屏模式中，对已启动的工作流 Agent 按 Enter 可打开其原生对话记录，包括思考和工具结果。`Ctrl-O` 展开详情，Escape 返回工作流对话框。任务视图可停止所选原生任务。插件可从 UI 回调通过 `$.ui.view({ agentId })` 请求此对话记录；查看请求和选择状态均按客户端隔离。内联模式会提示使用全屏模式查看对话记录。

运行时模块是以用户权限执行的受信任代码：能力检查约束宿主 API，不能限制任意 Node.js 导入。请仅安装可信模块。可选的脚本 API 使用独立的 QuickJS 解释器，通过 JSON 参数和显式宿主回调交互；脚本无法访问 Node.js 或插件闭包。内存和执行限制作用于脚本，不作用于受信任模块。原生 hook 错误会记录日志并放行；Mods hooks 可通过 `.catch` 恢复。命令和自定义域错误会返回给调用方。

## 安全模型

除上述实验性运行时外，Plugin 的加载边界如下：

- 不会执行命令型 plugin tools 或旧式工具运行时
- 所有路径在解析符号链接后仍必须位于 plugin 根目录内
- 已启用 plugin 的 MCP servers 在 `/reload` 后或新会话中启动，可随时从 `/plugins` 禁用
- 损坏的 manifest 或不安全路径显示在 `/plugins info <id>` 的 diagnostics 中，不影响其他会话

## 下一步

- [Agent Skills](./skills.md) — 了解 SKILL.md 格式，编写 plugin 携带的 Skill
- [自定义 Agent](./agents.md) — 了解 Agent 文件格式与目录作用域优先级
- [MCP](./mcp.md) — 了解 plugin 中 MCP server 声明复用的 schema
- [Hooks](./hooks.md) — 了解 plugin hooks 复用的全局 hook 机制
