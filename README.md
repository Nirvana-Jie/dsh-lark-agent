<img src="https://raw.githubusercontent.com/Nirvana-Jie/dsh-lark-agent/main/assets/plugin-icon.png" width="80" align="right" alt="dsh-lark-agent icon">

# dsh-lark-agent

[中文](https://github.com/Nirvana-Jie/dsh-lark-agent/blob/main/README_zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-lark-agent)](https://www.npmjs.com/package/dsh-lark-agent)

**Reach your [DeepSeek Harness](https://www.deepseek.com/harness/) assistant from Feishu / Lark when you're away from your computer.**

dsh-lark-agent adds a Feishu / Lark private chat to a running DeepSeek Harness: hand off tasks, talk through plans, and pick up earlier topics from your phone. Feishu gets its own sessions and never takes over chats already open in the desktop app or on the web.

[![dsh-lark-agent illustrated walkthrough (Feishu chat redrawn with demo data, not a screen recording): from the Harness settings page into a Feishu private chat that returns chart and form cards](https://raw.githubusercontent.com/Nirvana-Jie/dsh-lark-agent/main/assets/readme/intro.gif)](https://github.com/Nirvana-Jie/dsh-lark-agent/blob/main/assets/readme/intro.mp4)

## Install / Update

Before you start:

- DeepSeek Harness is running, can chat, and has a default model selected: PC App `0.2.1-rc.3` (`0.2.1-rc.2` also works), or Web / `dsh` CLI `0.1.1-rc.2`.
- The official Lark CLI is installed on the same machine **before** you enable the plugin (needs Node.js / npm):

  ```sh
  npm install -g @larksuite/cli@1.0.98
  lark-cli --version
  ```

  Don't run `lark-cli config init` or `lark-cli auth login`: the plugin creates its own dedicated CLI profile when you scan, and `config init` can overwrite existing profiles.

### Install on the DeepSeek Harness desktop app

In the sidebar, open **插件 → 添加插件** (Plugins → Add plugin), enter `dsh-lark-agent`, click **安装** (Install), then **立即启用** (Enable now). Restart if the app asks.

### Install with the `dsh` CLI

[`dsh plugin`](https://www.npmjs.com/package/@deepseek-ai/dsh) runs pnpm, so pnpm must be on your PATH:

```sh
dsh plugin --profile web add dsh-lark-agent@0.5.1 --allow-build=protobufjs
```

Then restart `dsh web`.

> [!NOTE]
> `--allow-build=protobufjs` lets a dependency of the Lark SDK run its install script. Without it, pnpm 11 stops with `ERR_PNPM_IGNORED_BUILDS` and dsh does not enable the plugin. If that already happened, run:
>
> ```sh
> dsh plugin --profile web approve-builds '!protobufjs'
> ```
>
> The `!` skips that optional script (it only prints a version hint) and lets dsh finish enabling the plugin. Then restart `dsh web`.

### Update

When a new version has been out for a day, the Feishu settings page shows a notice with these steps (in the desktop app it also opens the plugin list for you). Until then, installs without an exact version, including `@latest`, still select the previous version because pnpm 11 skips releases less than 24 hours old. Use the exact version in the installation example above to install this release immediately after publication. If an install picks an older version that your DeepSeek Harness rejects as incompatible, see [Troubleshooting](https://github.com/Nirvana-Jie/dsh-lark-agent/blob/main/DEVELOPMENT.md#排障).

1. On the Feishu settings page, click **暂停连接** (pause) and back up as described in [Upgrade](https://github.com/Nirvana-Jie/dsh-lark-agent/blob/main/DEVELOPMENT.md#升级).
2. Desktop app: the Add plugin dialog says third-party plugins must be uninstalled before a new version is installed, so uninstall `dsh-lark-agent` on the Plugins page and add it again (this in-app upgrade hasn't been tested end to end yet; an earlier source build is listed as `dsh-larkbot`). CLI: run `dsh plugin --profile web update dsh-lark-agent@latest`, then restart `dsh web`.
3. Click **恢复连接** (resume) and check that the bot replies.

## Connect Feishu

Button labels are quoted in Chinese, as they appear, with an English gloss.

1. Open **设置 → 飞书 agent** (Settings → Feishu agent) in the desktop app, or **设置 → 插件 → 飞书 agent** on the web. Choose a robot and click **扫码创建并连接** (scan to create and connect). Use **添加机器人** (add robot) for another Agent; each robot has its own preset and workspace settings.
2. Scan the QR code with your own Feishu account and approve. If your organization requires admin approval, click **重新检查** (check again) once it is approved.
3. Click **打开飞书私聊** (open private chat) and, from the account that scanned, send the pairing word (`DSH-…`, valid for 10 minutes) as a plain-text message on its own, exactly as shown. If asked, confirm with **这是我，完成连接** (this is me).
4. When the page shows **已连接** (connected), send the bot a message.

The connection's model check does not create a “飞书连接测试” conversation in Harness. The Feishu entry works only while the host is online: not when the app is closed, the web host is stopped, or the computer sleeps.

## What it can do

| In Feishu, you… | The assistant… |
| --- | --- |
| Send a request | Works on it with Harness's own tools (web search, reading pages, workspace files and more), streaming the reply live into one card; its thinking and tool steps are folded inside, step by step as in the app, and the card ends with the model, thinking depth and permission mode it used |
| Let Harness delegate work to subagents | Sends follow-up results and updated deliverables back to the same topic when subagent messages wake Harness again, including after its first reply has finished |
| Use several assistants | Manages up to 10 Feishu robots from one page, each with its own Agent preset, workspace, connection and history; pause a robot to edit its settings. Preset selection is available when the host provides it |
| Send images in your private Harness chat | Reads PNG, JPEG, WebP or GIF through the host's durable attachments, when the selected model supports images; up to 4 images, 10 MB each |
| Send a voice message | Use **开通语音权限** (authorize voice) for that robot, then pause, enable and save voice input. Transcribes up to 60 seconds of Chinese / English speech and replies in text; requires FFmpeg and a tenant plan that supports ASR |
| Ask for something that needs your OK | Sends a confirmation card: tap **允许一次** (allow once) or **拒绝** (deny); no answer within 5 minutes means it won't run |
| Get asked to choose by Harness | Sends a choice card: tap an option, or fill it in and submit |
| Use `/permission`, or **设置 → 权限模式** (Settings → Permission mode) in the bottom menu | Switches between read-only, workspace edits and full access, like the app's permission selector; full access stops asking. The card you tap updates in place and turns green when done |
| Ask for the result file | Sends files from its workspace straight to the chat |
| Say "lead with the conclusion from now on" | Remembers the preference |
| Continue inside a topic, or use `/sessions`, `/new` | Keeps each conversation in its own native Feishu topic; reply beneath a new topic's entry card, or use the searchable, paged dropdown to reopen an earlier topic |
| Ask for a bar chart of some numbers | Replies with a native Feishu chart card |
| Ask it to let you pick between options first | Sends a form card and continues once you submit |
| Ask for an architecture diagram or a report | Creates a Feishu doc (with a whiteboard for diagrams) shared read-only with you alone; in App `0.2.1-rc.2` / `rc.3`, opening that Feishu session in the app also shows a local preview |
| Use `/model`, `/thinking` | Switches between the host's configured models and thinking depth, in sync with Harness on your computer (App `0.2.1-rc.2` / `rc.3`) |

By default it answers only your own private chat. In that chat the assistant is your Harness itself: the tools it can use and the actions that need your confirmation follow the permission settings on your computer. Sessions and memory stay on the computer running Harness; messages pass through Feishu and your model provider.

A new request in the main chat opens a topic; continue inside that topic to keep its context. Authorized group chats work the same way and still require an @mention on each message. `/new` opens another topic and keeps the earlier ones available.

## Good to know

- **More docs**: commands, privacy, upgrades, the chat bottom menu, team deployment and troubleshooting are in [DEVELOPMENT.md](https://github.com/Nirvana-Jie/dsh-lark-agent/blob/main/DEVELOPMENT.md) (Chinese).
- **Compatibility**: fully verified with PC App `0.2.1-rc.2` and `dsh` CLI / Web `0.1.1-rc.2`. PC App `0.2.1-rc.3` passes the real-host contract tests, and the plugin loads and connects on it (first-time QR setup on rc.3 is not tested yet). Other versions, platforms and tenants are not yet verified.
- **Language**: the settings page, the bot's built-in messages (`/help`, status text, card buttons, bottom menu) and the intro video are in Chinese.

## License

[MIT](https://github.com/Nirvana-Jie/dsh-lark-agent/blob/main/LICENSE). DeepSeek and Feishu / Lark brand assets belong to their owners and are not covered by the MIT license; this is an independent open-source plugin, not an official product.
