# dsh-lark-agent 代理工作规则

这是 TypeScript ESM 的 dsh / Cordis 飞书插件，包含宿主服务和 Web / App 设置界面。飞书是个人助手的移动入口：通道历史独立，记忆在后台工作；选择旧话题、确认操作和复杂结果才使用卡片。[README.md](README.md)（英文）与 [README_zh.md](README_zh.md)（中文）只介绍能做什么和如何安装接入；命令、隐私、升级、部署、运维、排障与开发以 [DEVELOPMENT.md](DEVELOPMENT.md)（使用与开发文档）为准。

## 开始与完成

1. 先检查 `git status --short`，保留已有改动。按下表定位模块和相关测试；配置与命令参数以源码、清单和已安装 CLI 的 `--help` 为准。
2. 实现行为变更时，在相关 Vitest 用例中验证行为和边界。修复缺陷优先加入能复现问题的用例。
3. 运行相关测试和 `pnpm typecheck`。涉及多模块契约、权限、持久化或关闭流程时，再运行 `pnpm test`。具体 scripts 以 `package.json` 为准。
4. 完成前检查 `git diff --check` 和暂存差异；交付说明写清改动、实际验证及未验证项。文档和清单变更直接检查链接、忽略规则及打包清单即可。
5. `main` 受保护，不能直接推送：改动在分支上提交，经 PR 合并，CI 通过后才能合并。发版时在 PR 中改版本，合并后再给 `main` 打 `v<版本>` 标签；流水线只暂存，由维护者在 npm 上用 2FA 批准后公开。

依赖统一由 `packageManager` 指定的 pnpm 管理，提交 `pnpm-lock.yaml`；全新安装使用 `pnpm install --frozen-lockfile`，更新依赖使用 `pnpm add` / `pnpm remove`。开发基线显式声明依赖，保留严格解析，不用 hoist 掩盖缺失声明。

系统性的单元、集成和 e2e 测试统一使用 Vitest；不新增独立 JS 脚本测试。`package.json`、忽略规则等配置约束通过阅读、`rg`、Git 和打包命令核对，不写镜像配置的测试。

[vitest.config.ts](vitest.config.ts) 是测试分组的唯一配置：`host` 使用 Node，`client` 使用 jsdom 和统一 DOM 清理，`compat` 验证真实宿主。按改动运行 `pnpm vitest run <文件>` 或 `pnpm test:client`；完整质量检查用 `pnpm check`。兼容性依赖缺失导致跳过时须如实报告，不能当作通过。

## 按任务定位

| 改动 | 先读 | 验证重点 |
| --- | --- | --- |
| 插件入口、消息服务、重连与关闭 | `src/index.ts`、`src/bot-service.ts`、`src/config.ts` | `index`、`config` 测试 |
| 扫码、应用配置、模型预检、配对与启停 | `src/onboarding/controller.ts`、`model-check.ts`、`lark-platform.ts`、`pairing.ts`、`store.ts` | `onboarding`、`onboarding-model`、`lark-platform` 测试 |
| 宿主 RPC、所有者权限、接入状态目录 | `src/onboarding/host.ts`、`protocol.ts` | `onboarding-rpc`、`client-modern-host`、`index` 测试 |
| 设置页、异步反馈、客户端打包、升级提示 | `src/client/`、`src/onboarding/updates.ts`、`scripts/build-client.mjs` | `client-api`、`client-card`、`update-check` 测试；检查 `./client` 入口及真实宿主加载 |
| 多机器人、Agent 设置与工作区 | `src/onboarding/manager.ts`、`agents.ts`、`settings-store.ts`、`controller.ts`、`src/client/ManagerPanel.tsx` | `onboarding-manager`、`client-manager`、`onboarding-rpc`、`session-store`；原连接保留原目录，各机器人独立启停 |
| 图片与语音输入 | `src/message.ts`、`src/media-input.ts`、`src/lark-cli.ts`、`src/bridge.ts`、`src/dsh-runtime.ts` | `media-input`、`lark-cli`、`bridge`、`presentation-flow`、`dsh-runtime`；真实宿主的图片入库与恢复 |
| 身份、准入、队列、命令 | `src/message.ts`、`src/bridge.ts` | `message`、`bridge`、`rich-bridge` 测试 |
| 双宿主模型、工具与原生恢复 | `src/dsh-runtime.ts` | `dsh-runtime`、`dsh-runtime-modern`、`persistence-flow` 测试 |
| 话题设置、模型选择与旧卡片冲突 | `src/settings-controls.ts`、`src/model-controls.ts`、`src/model-preferences.ts`、`src/bridge.ts` | `channel-bridge`、`model-controls-bridge`、`model-preferences`、`dsh-runtime-model-native` 测试 |
| 飞书底部菜单、私聊定位 | `src/bot-menu.ts`、`src/direct-chats.ts`、`src/lark-cli.ts` | `bot-menu`、`direct-chats`、`model-controls-bridge`、`bot-service` 测试 |
| 记忆可见性、群授权 | `src/memory-store.ts`、`src/bridge.ts` | `memory-store`、`memory-privacy` 测试 |
| 会话目录、历史选择器、原生话题、去重、全局机器人租约 | `src/session-store.ts`、`src/session-controls.ts`、`src/topic-store.ts`、`src/topic-cards.ts`、`src/bridge.ts`、`src/ledger.ts`、`src/lock.ts`、`src/bot-service.ts` | `session-store`、`session-controls`、`topic-store`、`topic-cards`、`topic-bridge`、`state`、`index`、`onboarding` 测试 |
| CLI 传输、进度、卡片 | `src/lark-cli.ts`、`src/progress.ts`、`src/replies.ts`、`src/card-actions.ts` | 同名测试与 `rich-bridge` |
| 私聊菜单加载与原地更新 | `src/command-feedback.ts`、`src/bridge.ts`、`src/lark-cli.ts` | `command-feedback`、`model-controls-bridge`、`lark-cli` 测试 |
| 结构化作品、表单、云端图示与报告 | `src/presentation.ts`、`src/artifacts.ts`、`src/artifact-publisher.ts`、`src/rich-scopes.ts` | `presentation`、`artifacts`、`artifact-publisher`、`presentation-flow`；兼容矩阵里的原生展示工具 |
| Harness 原生作品卡与本地预览 | `src/native-presentation.ts`、`src/dsh-runtime.ts` | `native-presentation`、`dsh-runtime-model-native`；公开交付事件、原生 checkpoint、实际侧栏预览 |
| Harness 模式私聊：实时卡片、确认与提问、文件交付 | `src/dsh-runtime.ts`、`src/live-reply.ts`、`src/interaction-cards.ts`、`src/bridge.ts` | `dsh-runtime`、`live-reply`、`channel-bridge`、`interaction-cards`；兼容矩阵里的 harness 用例 |
| 卡片原地更新、与 App 同步设置 | `src/bridge.ts`、`src/replies.ts`、`src/model-controls.ts`、`src/permission-controls.ts`、`src/dsh-runtime.ts` | `model-controls-bridge`、`channel-bridge`、`dsh-runtime`；兼容矩阵 `dsh-runtime-modern` 的共享模型用例 |

表中简写测试名对应 `tests/<名称>.test.ts` 或 `.test.tsx`；onboarding 行的省略路径均在 `src/onboarding/`。修改接入、打包或运行脚本时，同步中英文 README / DEVELOPMENT.md 中的可复制步骤；修改用户可见行为时，同步中英文 README、DEVELOPMENT.md、基础帮助和模型表达。

宿主连接适配需区分两代接口：旧 Web 的自定义 RPC 使用 loopback 限制；App `0.2.1-rc.2` / `rc.3` / `rc.5` 的设置操作使用公开、仅 owner 可访问的精确 Fetch 路由。不要用放宽 Origin、绕开认证或对修改请求做自动 fallback 重试来解决兼容问题。安装了官方 App 时，`client-modern-host` 会直接验证真实宿主的鉴权与路由契约；运行前构建源码，也可用 `DSH_TEST_HOST_MODULE` 指向独立构建的 `onboarding/host.js`。

## 接入与宿主契约

- `configFile` / `DSH_LARK_CONFIG` 有值时加载显式团队配置；留空时注册连接设置。两条入口复用 `createBotService`，保持相同准入、持久化和关闭规则。
- 控制面只允许宿主所有者访问：旧 RPC 保留 loopback 授权，新 RPC 校验 owner principal。UI 只传协议列出的操作字段，不接受任意配置路径、身份或密钥。
- 多机器人沿用原目录作为 `default`，新增入口只接受服务端生成的 ID。列表修改与命令准入串行；移除前确认该连接已停止，保留资料和 CLI 凭据。入口改绑机器人时先保留新身份，替换记录可靠保存后才释放旧身份；保存结果不确定时保留两者。Agent 与工作区设置在暂停后保存，新会话记录选择，旧 Harness 私聊会话保留原预设和工作区；受限会话继续服从当前管理员配置。App 的一级「飞书 agent」使用公开 `settings.section`，旧 Web 仍用 `settings.plugins.tab`。
- 设置页按插件内容区宽度响应，不能用整个窗口宽度推断嵌入面板布局。消息输入开关与能力就绪分开：展示宿主附件、模型图片能力、FFmpeg 和飞书权限，未知能力不冒充已验证。图片/语音增补授权只接受固定特性枚举，按已验证机器人的专用 profile 用官方扫码增补固定 bot scopes；回读身份和权限后才标记就绪，取消不停止服务、不重新配对，不自动启用输入。
- 设置页的升级提示只读 npm 包文档中的 `latest` 标签及其发布时间（只发包名；设置页轮询时最多 6 小时一次，后台进行，不阻塞状态读取，失败不提示），发布满 24 小时才经快照的 `update` 字段送到页面：App 与 `dsh plugin` 的 pnpm 11 默认跳过发布不满一天的版本，提前提示只会装上旧版。插件不自行下载、替换或重装自己：App 内只经公开的 `pluginNavigation.openList()` 打开插件列表，旧 App 与 Web 只给步骤和命令。测试经 `latestRelease` 注入，不访问网络。
- 绑定来自未过期配对词对应的真实私聊事件，并匹配创建者或经过本机所有者确认。模型连通性检查、连接就绪和飞书确认回复成功后才持久化启用；取消、响应未知、关闭失败时保留可恢复状态。
- 连接模型预检通过宿主公开的 `llm.stream()` 发送固定测试消息，成功、失败、取消和超时均不创建或保留测试会话。仅验证模型，不读取用户内容或调用工具。
- 自动接入仅授权本人私聊，`groupChats: []`，本人私聊为 Harness 模式（`directMode: 'harness'`）；团队配置默认仍是受限助手，群聊始终受限并使用 `allowedTools`。Secret 仅交给官方 CLI 凭据存储；连接快照、浏览器、日志和 `connection.json` 使用字段白名单。
- Harness 模式只用于已验证本人的私聊（运行时对非私聊策略拒绝创建），飞书只是该 Harness 会话的入口：保留宿主人设、运行时上下文、工具、展示模式与权限策略，只追加 `lark-channel` 渠道段。宿主审批和提问由插件按 agent 作用域监听，转成签名卡片发给本人；卡片答复绕过会话队列（运行中的回合正占着它），按 ID 一次有效并校验操作者与聊天，超时、取消或卡片不可用一律拒绝。旧宿主的提问只有全局浏览器提供方，Harness 模式下隐藏 `ask_user_question`，由模型在回复里提问。会话按宿主的 agent 预设组成（新会话记录默认预设，恢复时用记录的或默认的），受限会话不加入预设。
- Harness 子智能体回传唤起的主会话续跑也归原话题队列：在公开提示词组装接口等待准入、加载当前渠道上下文并安装交互监听，原生 checkpoint 后复用回复与交付流程。续跑绑定精确原生 Session 和服务端保存的原话题，以原生会话／回合标识去重；不重复提交用户输入、不转发其他 agent 的日志、不扩展到群聊。取消、容量拒绝和关闭须释放等待组装的宿主，保存结果不确定时停止访问。
- 权限模式只在本人 Harness 私聊切换，目录取自公开 `permissionPresets.catalog()`。话题内的选择只作用于该逻辑话题并与同一原生会话同步；恢复时保留原生记录，App 的修改不传播到兄弟话题或默认。新话题在创建入口时捕获权限默认，旧版私聊选择只作为新话题默认的迁移来源。旧宿主没有目录时不显示该选项。设置卡先编辑内存草稿，保存时重新校验目录、话题、会话和设置 revision，原生 checkpoint 后将模型与权限作为同一快照持久化；过期卡片只刷新，结果不确定时停止访问。
- 双宿主通过公开能力适配。保留 legacy persona/readFrom 与 modern prefix/snapshotEvents/open-read 的分支；现代 required cwd 取自当前 Agent。更新 peer 范围前，在对应真实宿主依赖上验证，不能只改版本字符串或跳过安全能力。
- 自动接入状态按宿主代际及 home 分目录；原生持久化跟随宿主。跨代迁移需明确验证，不复用旧后台状态或混写原生日志。
- 项目、仓库与 npm 包名为 `dsh-lark-agent`；插件 ID 与日志前缀 `im-larkbot`、数据目录 `~/.dsh-larkbot/`、RPC 路径 `larkbot`、设置页与样式 ID、应用注册来源、launchd 标签和构建环境变量沿用旧名。改这些运行标识会让已有安装丢失配置、状态或后台服务，或破坏设置页与宿主的契约，须先设计并验证迁移。
- 模型目录与思考档位来自宿主公开接口。App 宿主的本人 Harness 私聊与 App 中同一原生会话共用模型记录；话题内修改追加 `model/selection` 并 checkpoint，仅修改该话题。只有明确修改「新话题默认」（含主聊天 `/model` / `/thinking`）才调用 `agentDefaultModel.saveSelection`；失败报错。新话题创建入口时捕获默认，首次创建原生会话时记录这份选择；已保存的会话以自己的原生记录为准。按钮 revision 在同步共享记录和重新打开会话之后校验。旧宿主、受限模式和管理员固定路由按原用户／聊天／话题保存，不改宿主全局默认。保存结果不确定时停止推理。
- 目录展示可以短时缓存和合并并发读取；实际切换仍实时校验。加载卡只更新已确认创建的消息，创建或更新结果未知时不另发 fallback、不重跑命令。本人私聊里点设置或话题卡片时只更新被点的卡片（处理中、结果、过期刷新），不另发卡片；群聊卡片仍另发回复，继续经过记忆授权检查。
- 菜单事件没有消息 ID 或聊天 ID。仅接受固定 event key，以结构化 operator 身份查找已验证的私聊，再向该 open ID 发送；不能伪造 reply message ID。配对私聊映射在服务取得两把锁后写入。菜单订阅与菜单定义分别配置，发布后预检成功才启用接收。

## 必须保持的边界

- 身份取自飞书结构化发送者／回调操作者，所有者和聊天范围由服务端派生。正文、显示名、模型参数、可见 ID 都不能授予权限。
- 个人记忆默认仅本人私聊可读；群共享仅由本人在私聊执行明确命令。群模型禁止写入记忆，群内显式 `/remember` 只保存用户命令正文。
- 保持群策略键、授权 epoch 与原生历史的隔离，不能把旧群历史导入新的授权范围。`withGroupAccess` 回调只负责发送，不能重入 MemoryStore。
- 先持久化消息 claim 再执行；原生 checkpoint 成功后才发布会话目录或确认回复。保存结果不确定时拒绝继续访问，不能用空状态掩盖失败。
- 每个用户／聊天／话题串行，取消只影响所属队列。修改型卡片 nonce 在容量准入后消费；回调继续校验签名、操作者、聊天和当前权限。
- 私聊与群聊的新会话均绑定飞书原生话题；只使用真实事件的 `thread_id` 或已确认的机器人回复回执，不从引用/root ID 猜测。主聊天新问题先创建并持久化绑定，再推理，首轮与立即到达的话题消息共用队列。菜单、新话题和旧会话入口可新建根消息；创建结果未知不重发、不转到主聊天推理。菜单和 `/new` 使用卡片作为独立话题根消息，不另发独立确认卡，可复用的历史选择卡不改绑成新话题；收到问题才创建原生会话；`/resume` 定位话题，旧记录用原 context 与显式 sessionId 绑定，不修改兄弟会话的 activeId。话题目录按所有者与聊天授权，群聊仍需 @、保持受限模式，授权 epoch 变化后旧话题不得续聊。话题绑定在原生 checkpoint 与目录保存成功后补记 sessionId，持久化结果未知时停止访问。
- 话题入口控制不恢复主聊天的旧 active 会话；空的命令队列完成后及时回收。本人 Harness 私聊的新话题创建入口时捕获新话题默认，已有话题独立保存；群聊和受限助手保持原继承规则。设置绑定服务端保存的逻辑话题，原生会话 fork 后继续沿用原话题设置。菜单没有话题信息，设置先选择默认或获准的话题；运行中拒绝修改且不消耗卡片 nonce，后台续跑仍归原话题队列。
- 受限模式（群聊、团队配置的默认私聊）保留独立 complete persona、动态上下文抑制、native tools、`restrict` 与单向 `guard`，以及宿主审批拒绝；不能把 Harness 模式、思考过程、实时卡片或确认卡片扩展到群聊。工作目录不是文件系统沙箱；额外工具必须自身实施资源权限。
- CLI 使用固定 profile、bot 身份、参数数组和 stdin；正文及凭据不进入 shell 插值。发送结果未知时不自动重发或另发文字 fallback。实时卡片只有首次回复算发送：卡片实体创建失败才改用普通回复（之后 10 分钟不再尝试）；回复结果未知时继续更新卡片、不另发消息。对同一卡片实体的更新幂等，可用更高的 sequence 重试。一次回复只用一张卡片：思考过程与工具步骤默认折叠、按 App 的步骤名逐行显示，终稿优先放回答，过程用全部剩余空间，超出卡片上限时从最早的步骤省略并注明，不另发消息；工具详情和面板标题只用纯文本或转义后的内容。
- Harness 交付的文件只在 realpath 位于该用户工作区内、是非空普通文件且不超过 30 MB 时上传，CLI 只收到以文件所在目录为 cwd 的 `./basename`；其余只告知电脑上的位置，上传结果未知时不重发。
- 入站图片与语音仅本人 Harness 私聊可用，先鉴权并持久化消息 claim，再在所属队列下载原消息的资源键。图片交给宿主 `attachments.saveImages` 后才追加原生输入；语音经固定 FFmpeg 参数转成有界 PCM，再用专用 bot profile 调用飞书 ASR。转写作为普通输入，不触发命令；附件准备须保留表单提交等已整理的正文。临时文件在子进程退出后清理，原生图片保留跟随宿主。
- 状态锁保护目录，全局机器人租约按 bot 身份跨 home / profile 保护接收实例；配对监听也取得同一租约。关闭时排空处理、原生持久化及进度清理，成功后才释放锁。关闭失败保留服务所有权和租约；持锁进程仍在或无法确认已退出时，禁止接管或删锁。只有确认原持锁进程已退出（PID 不存在、PID 已属于另一进程，或无法核对身份的锁早于本次开机），且机器人租约经专用 profile 的 CLI 确认没有活跃 consumer 时，才原子接管遗留锁；不按锁的年龄猜测，锁目录须在本机磁盘。
- 原生会话释放与该会话队列串行；释放失败保留 handle 和 lane，确认关闭前不能打开同一原生日志。闲置回收也遵守此规则。
- 结构化展示只接受受限数据，经当前原生回合 checkpoint 后保存不可变作品；模型不能指定文件路径、卡片 JSON、收件人或权限。表单依据保存的 schema 校验，按原用户／聊天／逻辑话题绑定，提交一次后不可重放。
- 本地作品与飞书使用同一份声明式数据。现代宿主通过公开 `deliverables/presented` 事件展示，事件随原生 checkpoint 保存；仅写入所属工作区下固定 `.dsh-lark-results/<nativeSessionId>/` 目录，拒绝符号链接和被修改的快照。模板 HTML 不执行模型脚本，不加载外部资源。旧宿主没有等价接口时不伪造 UI 能力。
- 云端作品仅在本人私聊发布：先创建无私人标题的空文档，收紧并回读 ACL 后写内容，再仅授予已验证本人阅读。回看前复核权限；创建结果未知保留状态不重建。使用原子接口，避免 `docs +create` 对 CLI 默认用户的自动授权副作用。群图示和报告保留在聊天内，不能通过展示功能绕过群记忆 epoch。
- ACL 回读区分应用 `appid` 与人员 `openid`，仅接受专用 profile 对应应用及已验证本人；成员查询显式请求 `fields=type`。已知文档 ID 的失败任务须验证私有 ACL，且原文档为空或所有受控内容完全匹配；图示另核对源码、节点标签和连接。复用已完成步骤，不覆盖手动编辑，不对未知创建自动重试。
- 文档、画板与实时回复（`cardkit:card:write`）为默认能力，新应用首次注册就申请所需 bot scopes。旧应用缺少权限时通过 owner-only 设置操作补充授权；取消此流程不停止聊天或重新绑定用户，不要求已授权的用户再次扫码。完整 HTML 执行、工作区外或群聊中的文件交付和群云文档分享不属于当前能力，扩展前需独立设计授权及隔离。
- 现代宿主明确报告目标 `SessionAlreadyOwnedError` 时，仅本人私聊可从原始持久化只读快照用官方 `buildForkSeed` 续聊；校验来源 ID/cwd 并重新安装完整飞书权限。新原生历史 checkpoint 后，CAS 重绑原话题的 nativeId。保留父会话；群聊、其他错误或不完整证据继续拒绝恢复。

## 文档与产物治理

- 版本库中的项目文档只有 `README.md` / `README_zh.md`（英文 / 中文，内容保持一致：介绍视频、安装与更新、连接飞书、能做什么）、`DEVELOPMENT.md`（命令、能力上限、连接管理、隐私、升级、底部菜单，以及运行方式、部署、运维、排障与开发契约）和本文件（代理工作规则）。稳定约定更新到这三类入口（中英文 README、DEVELOPMENT.md、本文件），细节链接实际源码或测试；README 保持简短，其余内容放 DEVELOPMENT.md，需要时链接对应章节。
- 方案草稿、研究、联调清单、验收结果和一次性排障记录写到本地 `docs/`（稳定的排障步骤写入 DEVELOPMENT.md 的「排障」）；运行数据、日志、备份和构建验证写到 `.runtime/`。两处均被忽略，不能作为公开文档的必要依赖。
- 用户要求接入操作留档：实际进行 PC App / Web 安装与启用、扫码创建、本人配对、首次回复、模型切换、作品展示和重启验证时，同步采集关键截图及可用的连续录屏。记录宿主与插件版本、操作顺序、结果和未覆盖步骤；录制随已授权的实际操作进行，不为拍摄重复安装、配对或申请权限。
- 原始截图、录屏、采集清单和制作草稿放 `.runtime/recordings/<流程>-<日期>/`，保持 Git 忽略。公开前收起私人会话列表，检查账号、真实消息、记忆、路径、凭据、二维码和配对词；精选素材及必要源放 `assets/readme/`，可复制步骤同步写入中英文 README 或 DEVELOPMENT.md。公开文档中的图片不加来源说明文字；模拟示意须在画面内自带标注（如介绍视频），不能把缺少的实际操作剪接成已验证成功。
- 提交使用明确文件路径。不要强制添加被忽略的过程文档、真实团队配置、消息、记忆、凭据、过程截图或安装包；不要在 README / README_zh / DEVELOPMENT.md / AGENTS 中写本机身份、真实路径、测试标记或阶段性测试数量。
- 包内容由 `package.json.files` 的白名单控制：只发布运行所需的 `dist`（不含 source map 和 `dist/client/` 下的 tsc 产物）与 `cordis.patch.yml`；文档与媒体只留在仓库。README.md 同时是 npm 页面，其中图片和文档链接用 GitHub 绝对地址；客户端内联的图标不超过 256 像素。调整后用 `pnpm --config.ignore-scripts=true pack --dry-run --json` 检查，确认无 `assets/`、`docs/`、`.runtime/` 和真实配置。`--config.ignore-scripts=true` 避免文档检查触发构建。
- 发布前检查暂存文件与实际 tgz：扫描密钥、真实身份及平台 ID、联调标记、本机路径；复核媒体画面及元数据。测试使用虚构标识，不复制真实响应中的身份或凭据；审计报告存 `.runtime/`。版本以 `package.json` 为准，同步中英文 README 与 DEVELOPMENT.md 的安装示例。
- 本地 `docs/` 是非权威历史材料，不要求其他开发者或代理读取它。仅在用户明确要求时重建 Git 历史；新仓库也须通过上述发布检查。

## 运行实例与验证

自动化测试使用临时存储与模拟传输，不发送真实飞书消息、不调用真实模型。线上联调使用单独实例和非敏感标记；不要把合成用户测试描述为两名真实用户验收。

探测 `dsh plugin` 命令时使用 `.runtime/` 下的临时 `DSH_HOME`；该子命令即使只传 `--help`，也可能先初始化目标 profile。

现代宿主矩阵由 `DSH_MODERN_HOST_ROOT` 指向隔离依赖目录启用，目录约定见 `tests/dsh-runtime-modern.test.ts`；使用当前编译产物和真实宿主包，未准备 fixture 时明确报告该矩阵未执行。界面组件测试与原生契约通过不等于真实扫码完成：交付前分别验证插件加载、官方扫码 / 审批、本人私聊配对与确认回复、暂停恢复和宿主重启。

源码插件可能正通过软链接加载本仓库的 `dist/`。静态文档治理不重建或重启服务；需部署代码时按 DEVELOPMENT.md 正常停止、备份、构建、启动并检查就绪。独立构建同时运行 `pnpm exec tsc -p tsconfig.json --outDir .runtime/check-build` 和 `pnpm build:client --outdir .runtime/check-build`，核对宿主 JS、客户端入口及必需 runtime imports 均保留。
