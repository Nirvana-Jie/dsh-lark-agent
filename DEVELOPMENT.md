# dsh-lark-agent 使用与开发文档

安装与接入见 [README](README_zh.md)（[English](README.md)），代理与贡献者规则见 [AGENTS.md](AGENTS.md)。

使用：[命令](#命令) · [能力与上限](#能力与上限) · [连接管理](#连接管理) · [隐私与边界](#隐私与边界) · [升级](#升级) · [私聊底部菜单](#私聊底部菜单)<br>
部署与开发：[两种运行方式](#两种运行方式) · [开发与测试](#开发与测试) · [扫码接入](#扫码接入) · [作品展示与云端发布](#作品展示与云端发布) · [团队与后台部署](#团队与后台部署) · [运行边界](#运行边界) · [备份、升级与迁移](#备份升级与迁移) · [排障](#排障)

## 命令

在飞书发 `/help` 查看日常指引，`/help advanced` 查看全部高级命令。

| 命令 | 作用 |
| --- | --- |
| `/status` · `/status detail` | 确认在线 · 当前获准范围的会话与记忆诊断 |
| `/new`（或 `/reset`） | 归档当前会话，下一条消息开新话题；长期记忆保留 |
| `/sessions` · `/sessions detail` | 选当前聊天的旧对话（卡片最多 5 项，更多或没有按钮时用 `/sessions detail`）· 会话列表（最多 20 个）与 12 位 ID |
| `/resume <ID>` · `/rename <标题>` | 恢复当前聊天 / 话题的旧会话 · 命名当前会话 |
| `/stop` | 停止当前处理并取消排队消息 |
| `/model` · `/thinking` | 查看并选择模型 / 思考档位；当前模型不支持思考深度时会提示，卡片无按钮时列出文本命令 |
| `/results` · `/result <ID>` · `/publish <ID>` | 当前话题的作品 · 用文字查看内容 · 在本人私聊生成飞书文档或画板 |
| `/remember <内容>` · `/remember --chat <内容>` | 私聊保存为私密个人记忆，群内只把命令正文存为当前聊天记忆 · 只在当前聊天 / 话题使用 |
| `/memory [global\|chat]` · `/memory search <关键词>` · `/memory show <ID>` | 列出（最多 20 条）· 检索 · 查看本人在当前渠道可读的条目 |
| `/memory share <ID>` · `/memory unshare <ID>` | 仅本人私聊：逐条授权 / 撤销群聊使用；会轮换群授权，见[隐私与边界](#隐私与边界) |
| `/forget <ID>` | 删除一条可管理的长期记忆；群内只能删当前聊天的条目 |
| `/whoami` | 机器人识别到的你的用户 ID、聊天 ID 与范围 |

## 能力与上限

- **本人私聊就是 Harness：** 扫码接入的本人私聊是一个普通 Harness 会话的入口，沿用电脑上 Harness 的系统提示词、运行时上下文、全部工具和权限模式，只追加一段飞书渠道说明；能联网、读写文件还是执行命令，都由电脑上的权限模式决定。单轮处理默认最长 15 分钟。
- **回复：** 回复、思考过程和工具进度实时显示在同一张卡片里，思考过程在开始回答后自动收起；卡片放不下的长回复分条续发。没有实时回复权限（见下方「默认权限」）或卡片创建失败时，10 分钟内改用普通回复，处理中在原消息上加 `Typing` 表情（扫码新建连接默认开启，复用机器人需已有表情权限）。会话与偏好重启后可恢复。模型和思考深度按本人与当前话题保存，重启后保留，只影响后续回复，不改宿主全局默认。引用回复某条消息仍接着当前对话；飞书话题（thread）单独保存会话。
- **确认与提问：** Harness 需要确认的操作（如沙箱外的命令）会在私聊发确认卡片：「允许一次」只放行这一次，「拒绝」或 5 分钟内没有确认都不执行；卡片交互未开启时一律拒绝。Harness 提问时发选项卡片（一个不超过 6 项的单选题用按钮，其余用表单），10 分钟没有回答就按未回答继续；dsh CLI / Web `0.1.1-rc.2` 不支持按会话应答提问，改由模型在回复里直接问。卡片按钮只认原用户在原私聊点击，一次有效。
- **文件：** Harness 用交付工具（如 `present`）交出的文件，如果在本人私聊的工作区内且不超过 30 MB，会直接发到私聊（不超过 10 MB 的图片按图片发送）；工作区外、空文件或发送结果未确认的，只告知它在电脑上的位置。
- **图表：** 柱状、折线、饼图；最多 4 个系列、24 行，饼图仅单系列。用你提供或已核实的数据，示例数据会标明。
- **表单：** 普通输入与单选，最多 5 项；仅原用户在原聊天、原话题提交一次，提交内容作为回答续聊；按钮 24 小时有效，卡片交互未就绪时改为文字提问。
- **图示与报告：** 只授予本人阅读的飞书文档与画板。图示可用时附预览图，最多 16 个节点、24 条连线；报告最多 20 节。网页代码只给文字或代码说明，不执行脚本，不提供公网交互页面。
- **群里：** 需在[配置文件模式](#两种运行方式)按人授权。群聊始终是受限助手：独立人设、工具白名单（`allowedTools`）、需要确认的操作一律拒绝，不实时显示、不显示思考过程。云端作品只在本人私聊生成，群里的图表和表单只用该群获准的上下文，图示和报告保留为聊天内文字，不创建群共享文件。
- **作品：** 每轮最多 2 个，每人最多 300 个；随会话保存，重启后仍在，换话题后先 `/resume`；`/results` 只列各作品最新版，最多 8 项。修改保留旧版，云端另建新文档、不改写已生成的。作品保存失败（如达到上限）时正文照常发出，作品改用文字展示并注明原因。
- **本地作品卡：** App `0.2.1-rc.2` 打开对应的飞书会话时显示，可预览图表、图示和报告；dsh CLI / Web `0.1.1-rc.2` 只在飞书展示。图表可展开「查看数据」，图示可展开「查看节点与连接」；表单仍在飞书提交。
- **默认权限：** 实时回复（`cardkit:card:write`）、文档与画板权限在新建机器人扫码时一并申请。旧机器人缺权限时点设置页「补充默认权限」扫码更新原应用，无需重建、重新配对或填 Secret，聊天不中断；需企业审批时，获批后点授权提示中的「重试授权」，不必再扫码。补齐后实时回复在 10 分钟内自动启用；补齐前作品存在本地，之后点原卡片「生成飞书文档」/「生成飞书画板」或发 `/publish <ID>`。

<details>
<summary>卡片预览</summary>

<img src="assets/readme/rich-chart.png" width="360" alt="飞书原生柱状图卡片（示例数据）"> <img src="assets/readme/rich-form.png" width="360" alt="飞书表单卡片">

</details>

## 连接管理

<details>
<summary>安装与连接截图</summary>

[12 秒入口回放（MP4）](assets/readme/desktop-install-steps.mp4) · [插件管理页](assets/readme/desktop-install-01.jpg) · [安装引导](assets/readme/desktop-install-03.jpg)

<img src="assets/readme/onboarding-connected.jpg" width="720" alt="Harness Web 飞书设置页显示已连接">

</details>

- **安装：** App 安装时核对包名和版本，需要时按提示重启。已有专用机器人时，在设置页选「我已有机器人」→「连接这个机器人」。
- **扫码：** 扫不了码用「无法扫码？打开授权链接」，过期点「刷新二维码」；需企业审批时点「打开飞书后台」审批，回来点「重新检查」。
- **配对：** 用应用创建者的飞书账号（新建时即扫码账号）把配对词以纯文本原样单独发送，过期或发错时点「换一个配对词」重发；插件识别不到创建者时，界面会请你点「这是我，完成连接」确认。飞书收到连接确认后，插件才保存启用状态并显示「已连接」。
- **宿主在线：** 宿主须保持运行并联网，只关浏览器设置页不影响；不提供远程桌面或远程唤醒。
- **暂停与恢复：** 「暂停连接」/「恢复连接」可切换；同一宿主重启后自动尝试恢复已启用的连接（限同代际、同 `DSH_HOME` 或插件 `dataDir`，并重查权限、测试模型），失败时设置页显示原因，后台按 5 秒起、最长 10 分钟的间隔自动重试，直到连上或暂停 / 断开；机器人身份变化需要处理，不自动重试。
- **断开：** 「断开连接」只解除绑定，保留本地资料、CLI profile、记忆和会话。
- **单一实例：** 同一系统用户下一个机器人只能有一个接收实例，插件无法阻止另一台电脑或另一系统用户再启动一个；换宿主或改用团队部署前先暂停原连接，新宿主需重新连接。宿主崩溃、强退或断电后，确认原进程已退出且该机器人没有其他接收进程时，下次启动或自动重试会接管遗留的锁；状态目录须在本机磁盘。
- **Secret：** 只存于专用 CLI profile（见[扫码接入](#扫码接入)）。

## 隐私与边界

身份只取自飞书结构化的发送者 / 操作者；自称管理员、改显示名或在正文写 ID 都不会改变身份或范围。个人记忆按身份和聊天范围过滤后才交给模型。

| 谁在哪里提问 | 可用的资料 | 对话历史 |
| --- | --- | --- |
| 本人私聊 | 本人个人记忆 + 当前聊天记忆 | 仅当前聊天 / 话题 |
| 本人获准的群聊 | 本人明确共享的个人条目 + 当前群 / 话题记忆 | 仅本人在当前群 / 话题的历史 |
| 其他用户 | 无权读取、恢复或删除你的资料 | 与你的会话隔离 |

- **本人私聊的权限：** 私聊里的助手就是电脑上的 Harness，权限上限是电脑上 Harness 的权限模式；设成完全访问时，在飞书发一句话就能执行命令，请按需设置。确认和提问卡片只发给已绑定的本人，按钮校验操作者、聊天并且一次有效。工作区是专用目录，但不是文件系统沙箱。思考过程和工具进度只显示在本人私聊。
- **群共享：** 由本人在私聊用 `/memory share` 逐条授权，之后可用于本人所有获准的群会话，群回复全员可见；群模型不自动写入长期记忆。共享、撤销或删除已共享条目会轮换授权：旧群历史不再恢复，旧授权下未发出的回复丢弃，已发出的无法撤回。
- **数据在哪里：** 通道状态、记忆和本地作品存在运行 Harness 的电脑（默认 `~/.dsh-larkbot/`，完整目录见[备份清单](#备份升级与迁移)），原生会话日志由宿主保存。目录 0700、文件 0600，**并非加密**；`/forget` 与 `/new` 不会安全擦除历史、日志或备份。消息经过飞书和模型服务商，云端文档与画板存于飞书。
- **投递：** 消息先持久化去重再处理，宿主崩溃或结果未知时可能没有回复；为免重复执行，发送、工具执行和云端创建不自动重放，不保证每条消息恰好处理一次。需要时先确认上次操作是否生效再重发。
- **不提供：** 以你个人飞书身份操作、任意飞书业务操作、附件理解、群聊中的 Harness 工具与确认、定时工作流、完整 HTML 执行、工作区外或群内的文件交付、群内云文档分享、多副本部署。

## 升级

扫码接入（源码 / 团队部署见[备份、升级与迁移](#备份升级与迁移)）：

1. 设置页「暂停连接」。
2. 按[备份清单](#备份升级与迁移)备份 `~/.dsh-larkbot/`（设了插件 `dataDir` 时为该目录）与宿主的原生会话目录。
3. 安装新版：Web 运行 `dsh plugin --profile web update dsh-lark-agent@latest` 并重启 `dsh web`；App 按「添加插件」弹窗提示，先在插件页卸载旧版 `dsh-lark-agent`（更早从源码安装的显示为 `dsh-larkbot`），再添加 `dsh-lark-agent`（App 内升级尚未实机验证）。
4. 「恢复连接」，确认收到实际回复。

项目改名为 dsh-lark-agent 后，插件 ID、数据目录 `~/.dsh-larkbot/` 与日志前缀 `[im-larkbot]` 保持不变，升级无需迁移数据。

## 私聊底部菜单

机器人私聊的输入框上方常驻「新话题」「历史对话」「设置」悬浮菜单，无需另建飞书智能体；需飞书客户端 ≥ 7.22；群聊不显示，继续用 @ 和命令。由应用创建者在[飞书开发者后台](https://open.feishu.cn/app)配置，发布可能需企业审批：

1. **应用能力 → 机器人 → 机器人自定义菜单**：开启菜单，选择悬浮菜单样式。
2. 按下表建立菜单（「设置」只含子菜单），四个入口的响应动作都选 **推送事件**，事件标识逐字填写。
3. **事件与回调 → 事件配置**：使用长连接，保留消息事件，订阅 `application.bot.menu_v6`（无需额外权限，扫码创建的应用已订阅）。
4. 保存以上配置，创建版本并发布；客户端菜单可能约 5 分钟后才更新。审批期间已上线的版本照常收发消息，菜单在新版本发布后才启用。
5. **扫码接入：** 回到设置页「暂停连接」后「恢复连接」，检查通过即启用菜单（运行中的「检查连接」不查菜单）。未配置菜单不影响聊天。

| 入口 | 事件标识 | 等同命令 |
| --- | --- | --- |
| 新话题 | `dsh.new` | `/new` |
| 历史对话 | `dsh.sessions` | `/sessions` |
| 设置 → 模型 | `dsh.model` | `/model` |
| 设置 → 思考深度 | `dsh.thinking` | `/thinking` |

参考：[飞书菜单说明](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-customized-menu) · [菜单事件](https://open.feishu.cn/document/client-docs/bot-v3/events/menu)

- **配置文件模式：** 只读预检 `lark-cli --profile dsh-team-bot event consume application.bot.menu_v6 --as bot --dry-run` 须返回 bot 身份，且 `credentials_available`、`console_event_published`、`scopes_granted` 均通过；再设 `botMenu: true` 并重启，等到 `[im-larkbot] menu ready`。用户先给机器人发一句普通消息，让插件记下已验证的私聊，再点菜单验收。
- **权限与身份：** 菜单事件只用飞书提供的操作者身份查找已验证的私聊并回复，事件里的聊天 ID 或显示名不能改变身份或范围；菜单回复里的按钮另需卡片回调。
- **自动化：** 插件不为菜单申请 `application:application:patch`；已有该权限时，[src/bot-menu.ts](src/bot-menu.ts) 的 `buildBotMenuPlan(appId)` 可生成待审核的能力与订阅请求，由管理员执行并发布。

## 两种运行方式

| | 扫码接入（设置页） | 配置文件模式 |
| --- | --- | --- |
| 启用条件 | 插件配置 `configFile` 与环境变量 `DSH_LARK_CONFIG` 均为空 | 任一有值：加载团队 JSON，无扫码设置页 |
| 适用场景 | 本人私聊 | 多人团队、群聊、额外工具、独立常驻进程 |
| 准入 | 固定 `direct: true`、`groupChats: []`、`allowedTools: []` | 团队 JSON 的显式名单 |
| 模型 | 宿主当前默认模型（须先选好）；用户 `/model` 的选择优先 | 团队 JSON 的 `provider` / `model`，默认用宿主保存的默认模型 |

两种入口共用准入、持久化和关闭规则。运行时契约覆盖 PC App `0.2.1-rc.2` 与 dsh CLI / Web `0.1.1-rc.2` 的原生接口，其他版本、平台与企业租户未逐一实机验证。扫码接入无需手写配置或收集用户 ID。

## 开发与测试

需 Node.js ≥ 22.12（插件 `engines`；宿主要求以宿主为准，如 dsh `0.1.1-rc.2` 的依赖需 ≥ 22.19）与 pnpm `11.22.0`，依赖版本由 `packageManager` 与 `pnpm-lock.yaml` 固定。

```bash
pnpm install --frozen-lockfile
pnpm check   # 类型检查 + 全部测试与覆盖率（报告在 coverage/）
pnpm build   # 宿主模块 + Web / App 客户端 dist/client.cjs
pnpm --config.ignore-scripts=true pack --dry-run --json   # 核对打包白名单，不触发 prepack 构建
```

CI 在 ubuntu、Node.js 22 / 24 上依次运行这四条。`devDependencies` 固定旧宿主 `0.1.1-rc.2`，默认测试只用它验证真实宿主；`0.2.1-rc.2` 靠下方兼容矩阵与 App 路由契约。精确 peer 依赖见 [package.json](package.json)；缺少条件时兼容用例跳过（CI 中全部跳过），**跳过不等于已验证**。

测试使用 Vitest 4，分组参考 [dsh-context](https://github.com/bowenliang123/dsh-context/blob/main/vitest.config.ts)；[vitest.config.ts](vitest.config.ts) 定义 `host`（Node）、`client`（jsdom + React Testing Library）、`compat`（真实宿主）三个项目，对应 `pnpm test:host`、`pnpm test:client`、`pnpm test:compat`。

| 任务 | 命令 |
| --- | --- |
| 全部测试 / 监听 | `pnpm test` / `pnpm test:watch`（只看前端：`pnpm vitest --project client`） |
| 单个文件 | `pnpm vitest run tests/client-card.test.tsx` |
| 类型检查 / 覆盖率 | `pnpm typecheck` / `pnpm test:coverage` |
| 分别构建 | `pnpm build:host` / `pnpm build:client` |

兼容矩阵：先 `pnpm build`；每个 fixture 根目录放对应宿主的真实依赖树（`node_modules/@deepseek-ai/<pkg>/lib/index.js`），并把 `dist/` 中的 `dsh-runtime.js` 及其相对依赖（`presentation.js`、`native-presentation.js`、`replies.js`、`message.js`、`config.js`）复制到根目录，根目录须按 ES 模块加载（如 `package.json` 设 `"type": "module"`）；两代 fixture 约定见 [dsh-runtime-modern](tests/dsh-runtime-modern.test.ts) 与 [dsh-runtime-model-native](tests/dsh-runtime-model-native.test.ts) 测试：

```bash
DSH_LEGACY_HOST_ROOT=/absolute/path/to/legacy-fixture \
DSH_MODERN_HOST_ROOT=/absolute/path/to/modern-fixture \
  pnpm test:compat
```

App 路由契约（[client-modern-host](tests/client-modern-host.test.tsx) 测试）只在装有官方 App 的 macOS 运行：默认读取 `/Applications/DeepSeek Harness.app`，`DSH_DESKTOP_RESOURCES` 可指向其 `Contents/Resources`；`DSH_TEST_HOST_MODULE` 可指向独立构建的 `onboarding/host.js`（默认 `dist/onboarding/host.js`）。

**从源码安装：** `pnpm pack` 经 `prepack` 构建 `dist/` 后打包，最后一行输出 tgz 文件名；安装时用 tgz 的绝对路径代替包名（App「添加插件」或 `dsh plugin --profile web add <tgz 绝对路径> --allow-build=protobufjs`），运行中重建见[备份、升级与迁移](#备份升级与迁移)。

**发布 npm：** `main` 受保护，只能经 PR 合并，且两个 CI 任务须通过。维护者在 PR 中更新版本（`pnpm version patch --no-git-tag-version`，或 minor / major），合并后按 AGENTS.md 完成发布前检查，给 `main` 上的合并提交打标签并推送（`git tag v<版本> origin/main && git push origin v<版本>`）。[release.yml](.github/workflows/release.yml) 校验标签与 `package.json` 版本一致且在 `main` 上，运行 `pnpm check`、构建并核对包内文件，再经 npm Trusted Publishing（OIDC，仓库不存 npm token）用 `npm stage publish` 暂存并附来源证明：含 `-` 的预发布版本发到 `next`，其余发到 `latest`；最后创建 GitHub Release。暂存版本在维护者用 2FA 批准前不公开：在 npmjs.com 该包的 Staged Packages 页批准，或 `npm stage list dsh-lark-agent` 查到 ID 后 `npm stage approve <stage-id>`；已暂存的版本不要重跑流水线。npm 上已有的版本只补建 Release，不重复发布。工作流依赖 npm 包设置中的 Trusted Publisher（仓库 `Nirvana-Jie/dsh-lark-agent`、工作流 `release.yml`，只需 npm stage publish 权限）。

**图标与媒体：** 替换图标时保持比例与透明背景，客户端内联的图标不超过 256 像素；文档媒体（README 与本文）放 `assets/readme/`，只留在仓库、不进 npm 包。README.md 也是 npm 页面，图片和文档链接须用 GitHub 绝对地址。npm 包只含运行所需的 `dist`（不含 source map）与 `cordis.patch.yml`。

## 扫码接入

- Secret 经 stdin 交给专用 CLI profile（`dsh-<随机>`），不出现在设置页、浏览器、日志或 `connection.json`。
- 配对只认配对词（`DSH-…`，10 分钟有效）所在真实私聊事件的发送者，且须是应用创建者（新建即扫码账号，复用时取应用所有者 / 创建者；识别不到时由本机所有者确认）；随后以测试回合验证宿主模型与存储并启动长连接（最多等 45 秒）。
- 复用已有机器人只检查、不扩权：有 `im:message:readonly` 且卡片回调预检通过才启用按钮，有 `im:message.reactions:write_only` 才启用处理中反馈；缺项按提示到飞书后台补齐。
- 「扫码创建并连接」总会申请 `im:message:readonly`、`im:message.reactions:write_only`、实时回复（`cardkit:card:write`）与文档、画板权限，并注册 `card.action.trigger` 回调；清单见 [src/rich-scopes.ts](src/rich-scopes.ts)。
- 扫码接入的本人私聊固定为 Harness 模式（`directMode: "harness"`，单轮最长 15 分钟）并开启实时回复卡片；见[能力与上限](#能力与上限)。

## 作品展示与云端发布

- **本地作品卡：** 经公开的 `deliverables/presented` 事件展示，随原生 checkpoint 保存；快照是插件生成的静态 HTML（不执行脚本、不加载外部资源），以只读文件写入工作目录下的 `.dsh-lark-results/<nativeSessionId>/`。
- **云端发布：** 先建标题为「dsh 的作品」的空文档，收紧并回读权限后写入内容，最后只授本人阅读；画板预览图失败不影响链接。不覆盖手动编辑。
- **结果不确定时：** 不自动重建。有文档 ID 时核对私有权限和内容，仅续用空文档或与已保存作品完全一致的文档；无 ID 时提示人工检查（见[排障](#排障)）。

## 团队与后台部署

[配置文件模式](#两种运行方式)步骤如下，基于源码 checkout、macOS / Linux shell 与 dsh CLI `0.1.1-rc.2`，在仓库根目录执行，先暂停同一机器人的 Web / App 连接。另需能创建企业自建应用的飞书账号、dsh 可用的模型凭据；Node.js 与 pnpm 版本见[开发与测试](#开发与测试)。

| 名称 | 本文取值 | 保存什么 |
| --- | --- | --- |
| Lark CLI profile | `dsh-team-bot` | 专用飞书应用身份与凭据 |
| dsh profile | `feishu-team` | 机器人加载的插件 |
| `DSH_HOME` | `.runtime/dsh` | 专用模型设置、凭据与原生会话 |

模型配置、安装和启动须用同一个 `DSH_HOME`，不复用管理员的个人 Agent 配置。`scripts/manage-service.sh` 固定 `feishu-team`、`.runtime/dsh` 与 `.runtime/team.config.json`，`scripts/start-bot.sh` 固定 `feishu-team`；改名后只能用通用启动命令。

### 1. 安装依赖并创建飞书应用

```bash
pnpm add --global @deepseek-ai/dsh@0.1.1-rc.2
npm install -g @larksuite/cli@1.0.98
dsh --version; lark-cli --version; pnpm --version
lark-cli profile list                            # 复用已有专用机器人，或换一个尚未存在的名称
lark-cli config init --new --name dsh-team-bot   # 保留 --name：省略或同名可能覆盖已有配置
```

按终端链接在飞书确认后 CLI 自动保存凭据；该版本用固定注册模板，授权页可能带额外权限，须逐项核对。要自控最小权限，先在后台手动建企业自建应用，再用 `lark-cli config init --name dsh-team-bot` 交互录入凭据。随后在[飞书开发者后台](https://open.feishu.cn/app)确认机器人能力和可用人员，「事件与回调」选**长连接**（无需公网 Webhook 或个人 OAuth），按需开通下表后**保存并发布**：

| 能力 | 权限 / 事件 | 团队配置 | 就绪标记 |
| --- | --- | --- | --- |
| 文字收发（必需） | `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`；事件 `im.message.receive_v1` | — | `[im-larkbot] ready` |
| 卡片按钮（`/sessions`、模型选择、表单、发布作品；静态卡片不需要） | `im:message:readonly`；回调 `card.action.trigger` | `cardInteractions: true` | `[im-larkbot] cards ready` |
| 处理中表情 | `im:message.reactions:write_only` 或覆盖表情操作的权限 | `loadingReaction: true` | `Typing` 出现并在结束后清理；故障或崩溃可能残留 |
| 实时回复（Harness 模式私聊） | `cardkit:card:write` | `streamingCards: true` | 回复卡片实时更新；缺权限时自动改用普通回复 |
| 文档与画板 | `application:application:self_manage`、`docx:document:create`、`docx:document:write_only`、`docx:document:readonly`、`docs:permission.setting:write_only`、`docs:permission.setting:read`、`docs:permission.member:create`、`docs:permission.member:retrieve`；画板另需 `board:whiteboard:node:create`、`board:whiteboard:node:read`、`im:resource:upload` | — | 每次发布前实时预检 |
| 私聊底部菜单 | 事件 `application.bot.menu_v6`；后台步骤与预检见[私聊底部菜单](#私聊底部菜单) | `botMenu: true` | `[im-larkbot] menu ready` |

`docx:document` 可替代各 `docx:document:*` 与 `docs:permission.setting:*`，`im:resource` 可替代 `im:resource:upload`（见 [src/rich-scopes.ts](src/rich-scopes.ts)）。私聊加载卡与菜单回复复用 `im:message:send_as_bot`。核对身份并取得 ID：

```bash
lark-cli --profile dsh-team-bot whoami --as bot
lark-cli --profile dsh-team-bot auth status --json --verify
lark-cli --profile dsh-team-bot event consume im.message.receive_v1 --as bot --max-events 1 --timeout 2m
lark-cli --profile dsh-team-bot event consume card.action.trigger --as bot --dry-run   # 可选：卡片回调只读预检
```

- `identities.bot.openId`（`ou_…`，不是 `cli_…` App ID）即 `botOpenId`。
- 监听期间让用户私聊或在测试群 @ 机器人：`sender_id`（`ou_…`）是用户 `openId`，`chat_id` 是群 `oc_…`，`mentions[].id` 可核对机器人。后台要求先建立长连接才能保存订阅时，先运行这条监听。
- 拿到 ID 后结束监听再启动正式实例，运行期间不另起相同事件的消费者。监听输出含真实身份与消息，只留本地、不进 Git；Secret 只交给 CLI，不写入团队 JSON、源码或聊天。

### 2. 配置人员准入

```bash
umask 077
mkdir -p .runtime/workspaces/alice
export DSH_HOME="$PWD/.runtime/dsh"
export DSH_LARK_CONFIG="$PWD/.runtime/team.config.json"
export DSH_TELEMETRY_DISABLED=1
```

把最小配置存为 `.runtime/team.config.json`，替换全部 `REPLACE` 占位和 `cwd`（占位值能通过格式校验，漏改不报错）：

```json
{
  "profile": "dsh-team-bot",
  "botOpenId": "ou_REPLACE_WITH_BOT_OPEN_ID",
  "stateDir": ".state",
  "users": [{
    "openId": "ou_REPLACE_WITH_USER_OPEN_ID", "direct": true, "groupChats": [],
    "cwd": "/absolute/path/to/dsh-lark-agent/.runtime/workspaces/alice", "allowedTools": []
  }]
}
```

- **准入：** `users` 为 1–1000 人的显式名单，`openId` 不可重复。`direct: true` 开私聊（默认 `false`）；`groupChats` 默认为空，填入 `oc_…` 开群，同群每人单独授权。机器人须先入群，群消息须真正 @ 本机器人。
- **路径：** `cwd` 为该用户工作目录的绝对路径；`stateDir` 相对团队 JSON 所在目录解析，本例为 `.runtime/.state/`。
- **工具：** 从 `allowedTools: []` 开始，内置记忆与结构化展示工具自动注册；额外工具只接受精确名称，拒绝通配符和 `run_code`。
- **私聊模式：** `directMode` 默认 `"restricted"`（与群聊相同的受限助手）。设为 `"harness"` 时，该用户的私聊沿用宿主的提示词、全部工具和权限模式，确认与提问发卡片给本人（需 `cardInteractions: true`），`allowedTools` 只用于其群聊；宿主的权限模式即该用户的权限上限，只给可以操作这台电脑的人开启。

| 可选配置 | 默认 | 说明 |
| --- | --- | --- |
| `provider` / `model` | 宿主保存的默认模型 | 初始路由；用户用 `/model` 保存的选择优先 |
| `executable` | `lark-cli` | Lark CLI 路径，按服务进程的 `PATH` 解析，不搜索常见安装目录；插件配置的 `executable` 在此模式不生效 |
| `responseMode` | `auto` | `text` 关闭卡片，仅用于纯文字兼容排查，此时 `/model`、`/thinking` 只显示当前设置 |
| `cardInteractions` / `loadingReaction` / `botMenu` / `streamingCards` | `false` | 开启条件见能力表 |
| `turnTimeoutMs` / `idleTimeoutMs` | 120 秒（有 Harness 模式用户时 15 分钟）/ 30 分钟 | 单轮处理超时 / 闲置后释放 Agent |
| `maxSessions` / `maxSessionsPerUser` | 100 / 10 | 内存会话总数 / 每用户 |
| `maxPending` / `maxPendingPerSession` | 100 / 5 | 排队消息总数 / 每会话 |
| `maxInputChars` / `maxOutputChars` / `chunkBytes` | 16000 / 32000 / 4000 | 输入、输出字符数；文字分片的 UTF-8 字节数 |

完整示例见 [team.config.example.json](team.config.example.json)，取值范围见 [src/config.ts](src/config.ts)。

### 3. 配置模型并安装插件

```bash
pnpm install --frozen-lockfile
pnpm build
dsh web   # 同一 shell：在本机页面配置提供商、凭据与默认模型，确认能对话后 Ctrl+C
dsh plugin --profile feishu-team add "$PWD"
dsh --profile feishu-team --dump-config > .runtime/composed.yml
```

- 转储须含 `im-larkbot`、`agent`、`tools`、`session-persistence-jsonl`（自定义 profile 默认带 `@deepseek-ai/dsh-base`），可能含敏感信息，只留在 `.runtime/`。
- 插件依赖宿主服务 `agents`、`tools`、`sessions`、`sessionPersistence`。自定义配置写到 `$DSH_HOME/profiles/feishu-team/cordis.patch.yml`（不改启动时重建的 `cordis.yml`），并保留 JSONL 持久化后端。
- 改用已发布的包：`dsh plugin --profile feishu-team add dsh-lark-agent --allow-build=protobufjs`；或 `pnpm pack` 后用 tgz 的绝对路径（如 `/absolute/path/to/dsh-lark-agent-0.1.0.tgz`）代替包名。不带 `--allow-build=protobufjs` 时 pnpm 11 会以 `ERR_PNPM_IGNORED_BUILDS` 失败、插件不会加入 profile，可再运行 `dsh plugin --profile feishu-team approve-builds '!protobufjs'` 补救。包内不含 `scripts/`，只能用通用启动命令。

### 4. 启动与验收

```bash
dsh --profile feishu-team
```

须带第 2 步导出的三个环境变量；也可用 `bash scripts/start-bot.sh`（默认上述 `.runtime/` 路径，`DSH_HOME`、`DSH_LARK_CONFIG` 可覆盖）。`[im-larkbot] ready` 只表示事件连接就绪，还须按下表验收。Ctrl+C / SIGTERM 会等待会话保存与关闭，不要强杀。同一 `stateDir` 只能运行一个实例（`instance.lock`；原进程确认退出后由下次启动回收）。

| 检查 | 预期 |
| --- | --- |
| 白名单用户私聊 | 收到实际模型回复 |
| 获准群内真正 @ 机器人 | 正常回复；未 @、未知用户、未获准的群不触发 |
| 私聊保存非敏感偏好，停止并重启后追问 | 会话与偏好可恢复；未授权的偏好不带入群聊 |
| 第二名真实用户查询、恢复或删除第一人的资料 | 被拒绝；不能用模拟测试代替 |
| 已开卡片：先发普通消息，再发 `/sessions`，点「换个话题」并确认 | 收到开始新话题的回复 |

**macOS 后台运行：** `scripts/manage-service.sh start`，另有 `status`、`stop`、`restart`。

- 当前登录会话内的 launchd 包装：不写 LaunchAgents，不配置登录自启或崩溃重启，注销或重启后需重新 `start`；锁记录的进程仍在运行时拒绝启动，已退出进程留下的锁由服务启动时核对并回收。
- 不沿用 shell 中的自定义路径或模型凭据环境变量，模型凭据须存于专用 home；日志在 `.runtime/logs/service.stdout.log` 与 `service.stderr.log`。
- Linux 用进程管理器运行 `dsh --profile feishu-team`，保留相同环境变量与优雅停止。

## 运行边界

- **私聊加载卡：** 模型、思考深度和话题操作超过约 200 毫秒时先显示加载卡，经[卡片更新接口](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch)原地更新，未保存或未就绪时不显示成功；模型目录缓存 30 秒并合并并发读取，实际切换仍实时校验。
- **工具：** `cwd`、profile 和 `allowedTools` 都不是 OS 沙箱，额外工具须自行校验调用者和资源权限；Harness 模式私聊的边界是宿主自己的权限模式与沙箱。不互信的成员需要编程或文件工具时，用独立 OS 身份或容器执行器并按用户绑定业务凭据；不加载会向 Agent 注入私人上下文的未审核插件。
- **投递与不提供的能力：** 见[隐私与边界](#隐私与边界)。

## 备份、升级与迁移

源码 / 团队部署的升级顺序：**停止服务 → 备份 → 构建 → 重装 → 启动，确认就绪并收到实际回复**；扫码接入见[升级](#升级)。状态在下表目录、不在插件安装目录，升级时不要删除。

```bash
pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm pack
```

宿主可能经软链接加载本仓库 `dist/`，运行中重建可能触发热加载，须先停止再构建；源码链接安装把 `pnpm pack` 换成 `pnpm build`，tgz 安装对原 profile 重新 `add` 新包。

| 备份对象 | 内容 |
| --- | --- |
| 扫码接入：`~/.dsh-larkbot/hosts/<legacy\|modern>/<home 哈希>/`；设了插件 `dataDir` 时为该目录 | `connection.json`；`bots/<id>/state/` 通道状态；`bots/<id>/workspace/` 工作目录与本地作品快照 |
| 配置文件模式：`stateDir` | `memory.json`、`sessions.json`、`messages.json`（去重账本）、`model-preferences.json`、`direct-chats.json`、`artifacts.json`；启用卡片时另有 `card-actions.key` |
| 配置文件模式：`.runtime/team.config.json` 与各用户 `cwd` | 人员、群与运行参数；工作目录（含 `.dsh-lark-results/`） |
| 宿主 home 下的 `sessions/`（本例 `.runtime/dsh/sessions/`） | 原生会话日志，与通道状态一起备份 |
| 宿主模型设置 / 凭据、Lark CLI 专用 profile | 恢复运行所需，按私有凭据保管 |

- **迁移：** 保留应用 / profile、`botOpenId`、用户、聊天与 `cwd` 归属：它们参与身份键和原生日志匹配，改动后旧会话无法恢复；插件不猜测映射，不把旧群日志整体导入新会话。
- **两代宿主：** 扫码接入状态按代际分目录（见上表），不自动导入旧后台实例；两代宿主不要共用原生会话目录或 `dataDir`。
- **租约：** 机器人租约在 `~/.dsh-larkbot/leases/`（不随 `dataDir` 移动），只阻止同一系统用户下跨 `DSH_HOME` / profile 重复接收；不能复制锁文件代替恢复实例。
- **旧数据：** 旧版本未带群公开许可的个人记录默认私密，旧群记忆和上下文留在磁盘、不自动导入。
- **回滚：** 升级后的 schema 不交给不支持的旧程序；回滚须在隔离备份上验证。

## 排障

| 现象 | 检查顺序 |
| --- | --- |
| 没有「飞书」设置页，或页面无法加载 | 插件已装入当前宿主并启用；`dsh plugin` 若报 `ERR_PNPM_IGNORED_BUILDS`（随后 dsh 提示 `pnpm failed in profile directory`），运行 `dsh plugin --profile <profile> approve-builds '!protobufjs'` 后重启 → 源码安装须用 `pnpm pack` 的产物（含 `dist/client.cjs`）→ `configFile` 与 `DSH_LARK_CONFIG` 均为空（见[两种运行方式](#两种运行方式)） |
| 提示找不到 Lark CLI | Lark CLI 装在宿主所在机器 → 插件启动时只查找一次 `PATH`、`~/.local/bin`、`~/.npm-global/bin`、`/opt/homebrew/bin`、`/usr/local/bin`，后装须重启宿主或重新启用插件 → 仍不行则在插件配置 `executable` 填绝对路径 |
| 配对词发送后未连接 | 机器人已发布 → 发在本人私聊 → 配对词纯文本原样单独发送且未过期，否则「换一个配对词」→ 只认应用创建者（新建即扫码账号）→ 需要时点「这是我，完成连接」 |
| 「飞书长连接尚未就绪」或没有 `[im-larkbot] ready` | 事件为长连接订阅且已发布 → 专用 profile 的 bot 认证（`auth status --json --verify`）→ CLI 在服务 `PATH` 或团队配置 `executable` 中 → 网络 |
| 有 `ready` 但不回复 | 应用已发布、用户在可用范围 → `openId` 与 `direct` / `groupChats` 准入、群内真正 @ → 模型凭据；未授权用户与非文本消息静默忽略 |
| 提示文档权限尚未就绪 | 「检查连接」不重查文档权限 → 按[能力与上限](#能力与上限)的「文档与画板权限」补齐，或暂停后恢复；配置文件模式按[能力表](#1-安装依赖并创建飞书应用)开通并发布 |
| 「上次发布结果尚未确认」 | 创建结果未知且无文档 ID，本地内容保留 → 在宿主机器查 `[im-larkbot]` 日志与状态目录的 `artifacts.json`（权限收紧并写入前新文档只归机器人，本人通常看不到）→ 插件不自动重建；需要时请助手修改该作品，新版本发布时另建文档 |
| 私聊回复没有实时显示 | 设置页「实时回复、文档与画板」已启用，否则点「补充默认权限」，补齐后 10 分钟内生效 → 配置文件模式需 `directMode: "harness"`、`streamingCards: true` 并开通 `cardkit:card:write` → `responseMode` 不是 `text` |
| 需要确认的操作总被拒绝，或没有确认卡片 | 卡片按钮可用（见下一行）→ 5 分钟内点「允许一次」→ 群聊不支持确认 → 想少弹确认，在电脑上调整 Harness 的权限模式 |
| 文件没有发到飞书 | 文件在本人私聊的工作区内、不超过 30 MB 且不是空文件 → 机器人有 `im:resource:upload` → 回复里会说明未发送的原因和电脑上的位置 |
| 按钮无响应 | `im:message:readonly` 已授权 → `card.action.trigger` 回调已配置并发布 → 卡片预检 → `cards ready` → 重新发 `/sessions` 取新卡片（按钮 24 小时有效，修改型按钮只能用一次，切换宿主后需新卡片） |
| 底部菜单不显示或点击无响应 | 客户端 ≥ 7.22、悬浮样式、版本已发布约 5 分钟（群聊不显示）→ `application.bot.menu_v6` 已订阅、事件标识为 `dsh.new`、`dsh.sessions`、`dsh.model`、`dsh.thinking` → 菜单预检通过 → 扫码接入暂停后恢复，或 `botMenu: true` 后重启见 `menu ready` → 用户 `direct: true` 且先发过一句普通消息 |
| 「当前对话正由客户端使用」 | App 占用同一原生会话且无法自动续聊（群聊，或宿主缺只读快照续聊接口）→ 在 App 关闭该会话后重试。现代宿主下本人私聊遇明确占用时不提示，改从已保存的只读快照另起续聊：保留话题名和模型选择，重装飞书权限与记忆范围，App 原会话不受影响，之后各自发展 |
| 无法创建 / 恢复会话 | 模型路由 → JSONL 持久化后端 → `cwd` 与原生日志一致 → 原生日志可读 |
| 提示另一个实例正在使用 | 原进程退出后，锁会在下次启动或自动重试时回收（还须 CLI 确认该机器人没有在接收消息的进程）→ 仍提示时暂停同一机器人的 Web / App 或停止后台实例 → `lark-cli --profile <profile> event status --current` 查看是否还有 consumer 或 orphan bus，按提示停止残留进程 → 不要手动删除锁目录；保留 `messages.json` |
| 设置页提示另一个正在运行的 dsh 正在管理这个飞书连接 | 同一 `DSH_HOME` 或插件 `dataDir` 下还有一个 dsh（如 App 与 Web 同时运行）→ 关闭其中一个，再重启当前 dsh |
| 发送失败或结果未知 | 查 `[im-larkbot]` 阶段日志 → 按[隐私与边界](#隐私与边界)的「投递」确认上次操作是否生效后再发新消息 |
