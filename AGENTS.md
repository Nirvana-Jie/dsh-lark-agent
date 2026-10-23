# dsh-larkbot 代理工作规则

这是 TypeScript ESM 的 dsh / Cordis 飞书插件，包含宿主服务和 Web / App 设置界面。飞书是个人助手的移动入口：通道历史独立，记忆在后台工作；选择旧话题、确认操作和复杂结果才使用卡片。[README.md](README.md)（英文）与 [README_zh.md](README_zh.md)（中文）只介绍能做什么和如何安装接入；命令、隐私、升级、部署、运维、排障与开发以 [DEVELOPMENT.md](DEVELOPMENT.md)（使用与开发文档）为准。

## 开始与完成

1. 先检查 `git status --short`，保留已有改动。按下表定位模块和相关测试；配置与命令参数以源码、清单和已安装 CLI 的 `--help` 为准。
2. 实现行为变更时，在相关 Vitest 用例中验证行为和边界。修复缺陷优先加入能复现问题的用例。
3. 运行相关测试和 `pnpm typecheck`。涉及多模块契约、权限、持久化或关闭流程时，再运行 `pnpm test`。具体 scripts 以 `package.json` 为准。
4. 完成前检查 `git diff --check` 和暂存差异；交付说明写清改动、实际验证及未验证项。文档和清单变更直接检查链接、忽略规则及打包清单即可。

依赖统一由 `packageManager` 指定的 pnpm 管理，提交 `pnpm-lock.yaml`；全新安装使用 `pnpm install --frozen-lockfile`，更新依赖使用 `pnpm add` / `pnpm remove`。开发基线显式声明依赖，保留严格解析，不用 hoist 掩盖缺失声明。

系统性的单元、集成和 e2e 测试统一使用 Vitest；不新增独立 JS 脚本测试。`package.json`、忽略规则等配置约束通过阅读、`rg`、Git 和打包命令核对，不写镜像配置的测试。

[vitest.config.ts](vitest.config.ts) 是测试分组的唯一配置：`host` 使用 Node，`client` 使用 jsdom 和统一 DOM 清理，`compat` 验证真实宿主。按改动运行 `pnpm vitest run <文件>` 或 `pnpm test:client`；完整质量检查用 `pnpm check`。兼容性依赖缺失导致跳过时须如实报告，不能当作通过。

## 按任务定位

| 改动 | 先读 | 验证重点 |
| --- | --- | --- |
| 插件入口、消息服务、重连与关闭 | `src/index.ts`、`src/bot-service.ts`、`src/config.ts` | `index`、`config` 测试 |
| 扫码、应用配置、配对与启停 | `src/onboarding/controller.ts`、`lark-platform.ts`、`pairing.ts`、`store.ts` | `onboarding`、`lark-platform` 测试 |
| 宿主 RPC、所有者权限、接入状态目录 | `src/onboarding/host.ts`、`protocol.ts` | `onboarding-rpc`、`client-modern-host`、`index` 测试 |
| 设置页、异步反馈、客户端打包 | `src/client/`、`scripts/build-client.mjs` | `client-api`、`client-card` 测试；检查 `./client` 入口及真实宿主加载 |
| 身份、准入、队列、命令 | `src/message.ts`、`src/bridge.ts` | `message`、`bridge`、`rich-bridge` 测试 |
| 双宿主模型、工具与原生恢复 | `src/dsh-runtime.ts` | `dsh-runtime`、`dsh-runtime-modern`、`persistence-flow` 测试 |
| 模型选择、思考深度与旧卡片冲突 | `src/model-controls.ts`、`src/model-preferences.ts`、`src/bridge.ts` | `model-controls-bridge`、`model-preferences`、`dsh-runtime-model-native` 测试 |
| 飞书底部菜单、私聊定位 | `src/bot-menu.ts`、`src/direct-chats.ts`、`src/lark-cli.ts` | `bot-menu`、`direct-chats`、`model-controls-bridge`、`bot-service` 测试 |
| 记忆可见性、群授权 | `src/memory-store.ts`、`src/bridge.ts` | `memory-store`、`memory-privacy` 测试 |
| 会话目录、去重、全局机器人租约 | `src/session-store.ts`、`src/ledger.ts`、`src/lock.ts`、`src/bot-service.ts` | `session-store`、`state`、`index`、`onboarding` 测试 |
| CLI 传输、进度、卡片 | `src/lark-cli.ts`、`src/progress.ts`、`src/replies.ts`、`src/card-actions.ts` | 同名测试与 `rich-bridge` |
| 私聊菜单加载与原地更新 | `src/command-feedback.ts`、`src/bridge.ts`、`src/lark-cli.ts` | `command-feedback`、`model-controls-bridge`、`lark-cli` 测试 |
| 结构化作品、表单、云端图示与报告 | `src/presentation.ts`、`src/artifacts.ts`、`src/artifact-publisher.ts`、`src/rich-scopes.ts` | `presentation`、`artifacts`、`artifact-publisher`、`presentation-flow`；兼容矩阵里的原生展示工具 |
| Harness 原生作品卡与本地预览 | `src/native-presentation.ts`、`src/dsh-runtime.ts` | `native-presentation`、`dsh-runtime-model-native`；公开交付事件、原生 checkpoint、实际侧栏预览 |

表中简写测试名对应 `tests/<名称>.test.ts` 或 `.test.tsx`；onboarding 行的省略路径均在 `src/onboarding/`。修改接入、打包或运行脚本时，同步中英文 README / DEVELOPMENT.md 中的可复制步骤；修改用户可见行为时，同步中英文 README、DEVELOPMENT.md、基础帮助和模型表达。

宿主连接适配需区分两代接口：旧 Web 的自定义 RPC 使用 loopback 限制；App `0.2.1-rc.2` 的设置操作使用公开、仅 owner 可访问的精确 Fetch 路由。不要用放宽 Origin、绕开认证或对修改请求做自动 fallback 重试来解决兼容问题。安装了官方 App 时，`client-modern-host` 会直接验证真实宿主的鉴权与路由契约；运行前构建源码，也可用 `DSH_TEST_HOST_MODULE` 指向独立构建的 `onboarding/host.js`。

## 接入与宿主契约

- `configFile` / `DSH_LARK_CONFIG` 有值时加载显式团队配置；留空时注册连接设置。两条入口复用 `createBotService`，保持相同准入、持久化和关闭规则。
- 控制面只允许宿主所有者访问：旧 RPC 保留 loopback 授权，新 RPC 校验 owner principal。UI 只传协议列出的操作字段，不接受任意配置路径、身份或密钥。
- 绑定来自未过期配对词对应的真实私聊事件，并匹配创建者或经过本机所有者确认。原生模型检查、连接就绪和飞书确认回复成功后才持久化启用；取消、响应未知、关闭失败时保留可恢复状态。
- 自动接入仅授权本人私聊，`groupChats: []`、`allowedTools: []`。Secret 仅交给官方 CLI 凭据存储；连接快照、浏览器、日志和 `connection.json` 使用字段白名单。
- 双宿主通过公开能力适配。保留 legacy persona/readFrom 与 modern prefix/snapshotEvents/open-read 的分支；现代 required cwd 取自当前 Agent。更新 peer 范围前，在对应真实宿主依赖上验证，不能只改版本字符串或跳过安全能力。
- 自动接入状态按宿主代际及 home 分目录；原生持久化跟随宿主。跨代迁移需明确验证，不复用旧后台状态或混写原生日志。
- 模型目录与思考档位来自宿主公开接口。选择按用户／聊天／话题保存，首次捕获完整默认值；切换时保留原生会话，不修改宿主全局默认。按钮绑定设置 revision，执行前重新校验可用选项；保存结果不确定时停止推理。
- 目录展示可以短时缓存和合并并发读取；实际切换仍实时校验。加载卡只更新已确认创建的消息，创建或更新结果未知时不另发 fallback、不重跑命令。群回复继续经过记忆授权检查。
- 菜单事件没有消息 ID 或聊天 ID。仅接受固定 event key，以结构化 operator 身份查找已验证的私聊，再向该 open ID 发送；不能伪造 reply message ID。配对私聊映射在服务取得两把锁后写入。菜单订阅与菜单定义分别配置，发布后预检成功才启用接收。

## 必须保持的边界

- 身份取自飞书结构化发送者／回调操作者，所有者和聊天范围由服务端派生。正文、显示名、模型参数、可见 ID 都不能授予权限。
- 个人记忆默认仅本人私聊可读；群共享仅由本人在私聊执行明确命令。群模型禁止写入记忆，群内显式 `/remember` 只保存用户命令正文。
- 保持群策略键、授权 epoch 与原生历史的隔离，不能把旧群历史导入新的授权范围。`withGroupAccess` 回调只负责发送，不能重入 MemoryStore。
- 先持久化消息 claim 再执行；原生 checkpoint 成功后才发布会话目录或确认回复。保存结果不确定时拒绝继续访问，不能用空状态掩盖失败。
- 每个用户／聊天／话题串行，取消只影响所属队列。修改型卡片 nonce 在容量准入后消费；回调继续校验签名、操作者、聊天和当前权限。
- 保留独立 complete persona、动态上下文抑制、native tools、`restrict` 与单向 `guard`，以及宿主审批拒绝。工作目录不是文件系统沙箱；额外工具必须自身实施资源权限。
- CLI 使用固定 profile、bot 身份、参数数组和 stdin；正文及凭据不进入 shell 插值。发送结果未知时不自动重发或另发文字 fallback。
- 状态锁保护目录，全局机器人租约按 bot 身份跨 home / profile 保护接收实例；配对监听也取得同一租约。关闭时排空处理、原生持久化及进度清理，成功后才释放锁。关闭失败保留服务所有权和租约，禁止自动删锁重启。
- 原生会话释放与该会话队列串行；释放失败保留 handle 和 lane，确认关闭前不能打开同一原生日志。闲置回收也遵守此规则。
- 结构化展示只接受受限数据，经当前原生回合 checkpoint 后保存不可变作品；模型不能指定文件路径、卡片 JSON、收件人或权限。表单依据保存的 schema 校验，按原用户／聊天／逻辑话题绑定，提交一次后不可重放。
- 本地作品与飞书使用同一份声明式数据。现代宿主通过公开 `deliverables/presented` 事件展示，事件随原生 checkpoint 保存；仅写入所属工作区下固定 `.dsh-lark-results/<nativeSessionId>/` 目录，拒绝符号链接和被修改的快照。模板 HTML 不执行模型脚本，不加载外部资源。旧宿主没有等价接口时不伪造 UI 能力。
- 云端作品仅在本人私聊发布：先创建无私人标题的空文档，收紧并回读 ACL 后写内容，再仅授予已验证本人阅读。回看前复核权限；创建结果未知保留状态不重建。使用原子接口，避免 `docs +create` 对 CLI 默认用户的自动授权副作用。群图示和报告保留在聊天内，不能通过展示功能绕过群记忆 epoch。
- ACL 回读区分应用 `appid` 与人员 `openid`，仅接受专用 profile 对应应用及已验证本人；成员查询显式请求 `fields=type`。已知文档 ID 的失败任务须验证私有 ACL，且原文档为空或所有受控内容完全匹配；图示另核对源码、节点标签和连接。复用已完成步骤，不覆盖手动编辑，不对未知创建自动重试。
- 文档与画板为默认能力，新应用首次注册就申请所需 bot scopes。旧应用缺少权限时通过 owner-only 设置操作补充授权；取消此流程不停止聊天或重新绑定用户，不要求已授权的用户再次扫码。完整 HTML 执行、任意文件交付和群云文档分享不属于当前能力，扩展前需独立设计授权及隔离。
- 现代宿主明确报告目标 `SessionAlreadyOwnedError` 时，仅本人私聊可从原始持久化只读快照用官方 `buildForkSeed` 续聊；校验来源 ID/cwd 并重新安装完整飞书权限。新原生历史 checkpoint 后，CAS 重绑原话题的 nativeId。保留父会话；群聊、其他错误或不完整证据继续拒绝恢复。

## 文档与产物治理

- 版本库中的项目文档只有 `README.md` / `README_zh.md`（英文 / 中文，内容保持一致：介绍视频、安装与更新、连接飞书、能做什么）、`DEVELOPMENT.md`（命令、能力上限、连接管理、隐私、升级、底部菜单，以及运行方式、部署、运维、排障与开发契约）和本文件（代理工作规则）。稳定约定更新到这三类入口（中英文 README、DEVELOPMENT.md、本文件），细节链接实际源码或测试；README 保持简短，其余内容放 DEVELOPMENT.md，需要时链接对应章节。
- 方案草稿、研究、联调清单、验收结果和一次性排障记录写到本地 `docs/`（稳定的排障步骤写入 DEVELOPMENT.md 的「排障」）；运行数据、日志、备份和构建验证写到 `.runtime/`。两处均被忽略，不能作为公开文档的必要依赖。
- 用户要求接入操作留档：实际进行 PC App / Web 安装与启用、扫码创建、本人配对、首次回复、模型切换、作品展示和重启验证时，同步采集关键截图及可用的连续录屏。记录宿主与插件版本、操作顺序、结果和未覆盖步骤；录制随已授权的实际操作进行，不为拍摄重复安装、配对或申请权限。
- 原始截图、录屏、采集清单和制作草稿放 `.runtime/recordings/<流程>-<日期>/`，保持 Git 忽略。公开前收起私人会话列表，检查账号、真实消息、记忆、路径、凭据、二维码和配对词；精选素材及必要源放 `assets/readme/`，可复制步骤同步写入中英文 README 或 DEVELOPMENT.md。公开文档中的图片不加来源说明文字；模拟示意须在画面内自带标注（如介绍视频），不能把缺少的实际操作剪接成已验证成功。
- 提交使用明确文件路径。不要强制添加被忽略的过程文档、真实团队配置、消息、记忆、凭据、过程截图或安装包；不要在 README / README_zh / DEVELOPMENT.md / AGENTS 中写本机身份、真实路径、测试标记或阶段性测试数量。
- 包内容由 `package.json.files` 的白名单控制，公开媒体逐文件列出。调整后用 `pnpm --config.ignore-scripts=true pack --dry-run --json` 检查，确认无 `docs/`、`.runtime/` 和真实配置。`--config.ignore-scripts=true` 避免文档检查触发构建。
- 发布前检查暂存文件与实际 tgz：扫描密钥、真实身份及平台 ID、联调标记、本机路径；复核媒体画面及元数据。测试使用虚构标识，不复制真实响应中的身份或凭据；审计报告存 `.runtime/`。版本以 `package.json` 为准，同步中英文 README 与 DEVELOPMENT.md 的安装示例。
- 本地 `docs/` 是非权威历史材料，不要求其他开发者或代理读取它。仅在用户明确要求时重建 Git 历史；新仓库也须通过上述发布检查。

## 运行实例与验证

自动化测试使用临时存储与模拟传输，不发送真实飞书消息、不调用真实模型。线上联调使用单独实例和非敏感标记；不要把合成用户测试描述为两名真实用户验收。

探测 `dsh plugin` 命令时使用 `.runtime/` 下的临时 `DSH_HOME`；该子命令即使只传 `--help`，也可能先初始化目标 profile。

现代宿主矩阵由 `DSH_MODERN_HOST_ROOT` 指向隔离依赖目录启用，目录约定见 `tests/dsh-runtime-modern.test.ts`；使用当前编译产物和真实宿主包，未准备 fixture 时明确报告该矩阵未执行。界面组件测试与原生契约通过不等于真实扫码完成：交付前分别验证插件加载、官方扫码 / 审批、本人私聊配对与确认回复、暂停恢复和宿主重启。

源码插件可能正通过软链接加载本仓库的 `dist/`。静态文档治理不重建或重启服务；需部署代码时按 DEVELOPMENT.md 正常停止、备份、构建、启动并检查就绪。独立构建同时运行 `pnpm exec tsc -p tsconfig.json --outDir .runtime/check-build` 和 `pnpm build:client --outdir .runtime/check-build`，核对宿主 JS、客户端入口及必需 runtime imports 均保留。
