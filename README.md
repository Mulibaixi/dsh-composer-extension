# dsh-composer-extension

[简体中文](README.md) | [English](README.en.md)

[![许可证：MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/Mulibaixi/dsh-composer-extension?label=release)](https://github.com/Mulibaixi/dsh-composer-extension/releases/latest)
[![Awesome DSH Plugin：已收录](https://img.shields.io/badge/awesome--dsh--plugin-listed-2ea44f)](https://awesome-dsh-plugin.com/?q=Mulibaixi%2Fdsh-composer-extension)
[![dsh-plugin.org：已收录](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/mulibaixi/dsh-composer-extension)

为 DeepSeek Harness（DSH）的主聊天输入框提供材料联动与任务协调能力，目标是逐步支持主会话与不同插件之间的协作交互。

本扩展当前与 `dsh-translation-plugin` 的翻译工作区配合使用。用户可以在工作区准备原稿，在主聊天中说明要求，一次发送完成材料与指令的交接。主模型能够将整合好的背景信息和翻译要求提供给翻译模型，支持当前任务的翻译、润色和审阅。

[解决什么问题](#解决什么问题) · [安装](#安装与更新) · [使用说明](#使用说明) · [发展方向](#发展方向) · [项目与文档](#项目与文档)

## 解决什么问题

- **材料与要求容易分散**：将工作区准备的待译材料随主聊天消息一起提交。
- **任务中可能缺少信息**：提供主模型整合信息提交给翻译模型的协作接口。
- **后台任务与主聊天脱节**：在接入的任务阶段提醒所属主模型继续处理，减少手动查看进度和传递结果的操作。

翻译执行、会话历史、译文版本和记忆资产由翻译插件管理；Composer 扩展负责材料交接与任务协调。

## 目前能做什么

| 能力 | 当前作用 |
| --- | --- |
| 联动发送 | 连接主聊天输入框与翻译工作区，一次提交要求和已准备的材料。 |
| 补充信息 | 支持主模型将整合好的背景信息和翻译要求递交给翻译模型。 |
| 关键阶段通知 | 为已接入的分析或文档任务传递需要主模型处理的阶段消息。 |
| 停止与失效处理 | 用户停止主模型后，不因迟到的任务消息重新唤醒；失效通知不会继续作为有效任务处理。 |

翻译交互以具体用户任务为起点。配合支持补充问题的翻译插件及支持工具调用的翻译模型，主模型可结合已有语境回答关键问题，或询问用户后发起补充翻译。任务协调覆盖已接入的分析与文档阶段，各平台和 DSH 版本的联动补丁要求见下文。

## 发展方向

后续希望将材料联动、主会话与插件任务之间的交流、阶段通知逐步整理为可供不同插件接入的协作能力。

近期以现有翻译、润色和审阅功能稳定可用为前提，逐步减少本扩展与翻译插件的耦合，明确协作交接与业务处理的边界，降低业务变化对扩展的影响。

通用协作是未来目标。当前接口仍围绕翻译场景实现，尚未提供经过验证的多插件通用接入能力。

## 环境与依赖

- DSH `>=0.2.0-rc.2 <0.2.3-0`，具备本扩展所需的插件与主会话接口；范围内按接口能力判断兼容性。
- 当前翻译工作流需要与本扩展配套构建的 `dsh-translation-plugin`，提供翻译工作区和实际任务。当前配套使用内容协议 3 和任务阶段协议 2。
- 在 DSH 中配置可用模型。
- 从源码构建需要 Node.js 22 或更高版本及 pnpm。

支持 DSH `0.2.2-rc.1`，提供匹配的补丁产物；发送时保留宿主确认接收后才清空草稿的行为，失败保留草稿。构建该版 DSH 及其宿主补丁需要 Node.js 24.9 或更高版本。

联动发送需要 submissions protocol 1。宿主已有该接口时可跳过仅用于 Client 的替换，桌面启动修复单独检查。**Windows 桌面版会按目标模块指纹匹配所需的随包补丁，正常完全退出后自动安装，重新打开生效。** DSH 更新后相关模块内容不变，可继续复用补丁，不因版本号变化要求更新扩展。已安装相同补丁时跳过，用户无需另装 Node 或运行独立脚本。

当前自动补丁产物基于 DSH `0.2.1-rc.3`、`0.2.1-rc.5` 和 `0.2.2-rc.1` 构建；这是构建基线，不是插件兼容版本白名单。目标模块已改变且宿主仍缺少提交接口时，会提示需要新的补丁产物，停止自动替换；其他已有能力可继续使用。未来宿主若改变所需接口，仍需适配。

在支持的 Windows 桌面环境中，`0.2.1-rc.5` 和 `0.2.2-rc.1` 的启动补丁仅保留当前本地 Host 的认证 Cookie，移除同类旧 Cookie，其他 Cookie 不受影响。安装新版宿主补丁并重新打开 DSH 后生效。

其他环境和旧版可使用 [0.2.0-rc.2 补丁](patches/rc2-composer-submissions-v1.patch)及其[源码清单](patches/source-manifest.json)，或 [0.2.1-rc.2 补丁](patches/dsh-0.2.1-rc.2-composer-submissions-v1.patch)及其[源码清单](patches/source-manifest-0.2.1-rc.2.json)。另提供 rc.3 的[源码补丁](patches/dsh-0.2.1-rc.3-composer-submissions-v1.patch)及[清单](patches/source-manifest-0.2.1-rc.3.json)、rc.5 的[源码补丁](patches/dsh-0.2.1-rc.5-composer-submissions-v1.patch)及[清单](patches/source-manifest-0.2.1-rc.5.json)、0.2.2-rc.1 的[源码补丁](patches/dsh-0.2.2-rc.1-composer-submissions-v1.patch)及[清单](patches/source-manifest-0.2.2-rc.1.json)。

## 安装与更新

### 安装

1. 从 [Releases](https://github.com/Mulibaixi/dsh-composer-extension/releases/latest) 下载 `dsh-composer-extension-<版本>.tgz`，在 DSH 插件管理器的安装输入框中填写安装包的完整路径或附件下载链接，安装并启用。选择包含构建产物与宿主补丁的 `.tgz` 附件，使用者无需本地构建。
2. 再从[翻译插件 Releases](https://github.com/Mulibaixi/dsh-translation-plugin/releases/latest) 安装并启用配套翻译插件。**Composer 0.4.7** 提供当前翻译工作流使用的内容协议 3 与任务阶段协议 2，并适配 DSH `0.2.2-rc.1`。工作区和维护命令已可用时可以直接检查；若插件管理器提示需要重启，再完整退出并重开。打开“Composer：联动组件维护”；若提示联动组件已准备、等待安装，正常完全退出 DSH 并重新打开以应用补丁。
3. 打开翻译工作区，确认普通模式未提示材料提交能力缺失。

### 从源码构建

准备配套 DSH 环境及扩展源码，在本项目目录执行：

   ```powershell
   pnpm install --frozen-lockfile
   pnpm build
   ```

构建完成后，可在 DSH 插件管理器中安装本目录。普通构建不生成宿主补丁模块；自动准备联动组件及生成完整分发包还需完成下文的[补丁产物构建](#构建补丁产物)。

### 更新

1. 等待当前任务结束并确认资料已保存；完整数据快照与恢复步骤见翻译插件的[备份与恢复指南](https://github.com/Mulibaixi/dsh-translation-plugin/blob/main/docs/user-guide.zh-CN.md#资料库备份与恢复)。
2. 在插件管理器的安装输入框填写**新版本 `.tgz` 的完整路径或版本下载链接**，安装并启用即可，无需预先卸载。使用带版本号的新文件名或链接；同一已安装路径可能被识别为“已安装”。仅在发行说明要求配套更新时，再更新翻译插件。
3. 按插件管理器提示刷新、重载或重启，并打开 **Composer：联动组件维护**。若已就绪，继续使用现有补丁；若显示“已准备，等待退出安装”，正常完全退出并重开 DSH 后生效。

**扩展包更新与宿主补丁更新是两件事。** 仅更新扩展代码且现有补丁匹配时，不会重复安装补丁；插件能否即时载入仍以 DSH 管理器提示为准。实际替换宿主补丁必须在 DSH 正常完全退出后进行，刷新窗口不能替代完整退出。

源码安装则更新原源码目录、重新安装依赖并构建，再刷新或重新加载扩展；无需先卸载。若管理器明确要求先卸载再安装，请在同一次 DSH 运行中完成重装并启用，避免把卸载验收中的“退出后恢复安装前状态”当作日常升级步骤。

更新时核对扩展、翻译插件与 DSH 构建是否匹配。扩展本身不保存可跨重启恢复的任务，重新加载也不会自动重发模型请求。

版本变化见 [CHANGELOG](CHANGELOG.md)。

### 联动组件维护

从命令列表选择 **Composer：联动组件维护**，或输入 `/composer-maintenance`，查看状态、重新检测或安排恢复补丁前版本。关闭窗口但仍在托盘运行时，安装助手会继续等待。尚未安装的任务会在停用、卸载或重载时撤销；崩溃或强杀不会授予补丁安装许可。官方更新改变原包时取消旧任务，下次加载重新检测。

**在 DSH 插件管理器中停用或卸载本扩展时，会自动安排恢复由本扩展安装的补丁，完全退出 DSH 后完成。** 助手与恢复材料保存在扩展目录之外，删除插件包后仍能执行。普通重载保留已安装补丁；退出前重新启用，会取消检测到的待执行自动恢复。需要继续使用普通翻译时，重新安装或启用扩展，再按维护状态完成联动组件准备。

自动恢复需要本扩展持有有效安装记录和备份，恢复到的是本次安装前状态。若本次安装是补丁升级，恢复后可能仍保留上一版补丁。手工或早期开发改包需另行恢复。宿主已升级或备份失效时会停止恢复，不覆盖后来安装的版本。

补丁备份位于当前用户本地应用数据目录的 `dsh-composer-extension/host-patches/` 下，与翻译资料库备份分开。DSH 无法打开时，完全退出后可运行对应任务目录中的 `apply-host-patch.ps1 -JobPath <job.json> -Recover`。恢复会核验版本与哈希，拒绝覆盖后来升级的安装包。恢复后须主动“重新检测”才重新安排安装。

### 构建补丁产物

一般构建生成 Host、Client 和退出安装助手。补丁模块由维护者生成后随扩展分发，用户机器不临时编译。准备固定 DSH 源码及其构建依赖、匹配的官方原版 `app.asar` 后执行：

```powershell
node scripts/build-host-patches.mjs --source <DSH源码目录> --archive <原版app.asar>
pnpm build
pnpm pack
```

工具核验固定源码补丁，在提供的源码目录应用补丁并构建，输出到 `dist/host-patches/<构建版本>/`。rc.5 和 0.2.2-rc.1 产物各包含三个 Client 模块（两个联动模块及修正重启提示的插件管理模块），另包含负责启动 Cookie 维护的 Desktop 主进程入口；旧 rc.2／rc.3 产物仍为三个 Client 模块。可对多个基线分别运行并一起打包；目录版本只记录产物来源，运行时仍核对实际目标模块指纹。构建 0.2.2-rc.1 基线需要 Node.js 24.9 或更高版本，较早基线需要 22.19 或更高版本。`--from-build` 可复用已校验源码的现有产物。打包检查各组产物和助手完整性，生成文件不提交源码仓库。

## 使用说明

### 1. 将材料和要求一起发送

在翻译插件中选择普通模式，填写待译文本或选择受支持的原稿文件，再在主聊天输入框写明本次要求并发送。

同一翻译会话和已保存资料可从不同主聊天继续使用；本次材料交给发送消息的主模型处理。

材料与这次消息一起提交，主模型根据你的意图安排处理。翻译输入框用于原稿，主聊天用于要求、讨论和修改意见。若本次只想聊天，可在翻译插件提供的入口选择**本次不附带**。

材料提交后会保留当次原稿；之后修改草稿不会改写已发送内容。查看结果、纠错或重译，请使用翻译插件的对应操作。

### 2. 补充信息

在主聊天中说明本次目标或指定信息，主模型整合相关背景和翻译要求后递交给翻译模型，用于本次翻译或润色。

交互以具体用户任务为起点。翻译过程中，配套插件可将翻译模型的关键问题返回主模型，澄清后再发起补充调用。

### 3. 后台任务完成或需要处理时

已接入的任务会在关键问题、资料变化或结果需要审阅时通知所属主模型；不是每个分块完成都发送提醒。主模型根据实际任务继续处理，你不必为每一步重复发送指令。

切换主聊天后，已有任务的通知仍发送到发起任务的主聊天。

用户停止主模型后，迟到的通知不会代替新的用户指令。如果结果未知，应先查询原任务，避免重复启动。后台结果及历史仍在翻译插件中查看。

### 4. 不可用时如何判断

- **联动发送不可用**：先检查是否使用配套 DSH 构建，并确认本扩展与翻译插件均已启用且已重启。
- **翻译模型要求补充信息**：需要支持此流程的配套翻译插件和支持工具调用的翻译模型。问题引用只在当前宿主运行期有效，每次补充调用独立计量。
- **没有阶段通知**：并非所有后台流程都使用本扩展；检查翻译插件中的实际进度与错误，不要仅凭主聊天静默重复提交。
- **重启后任务没有继续**：扩展不自动恢复临时交互；回到翻译插件核对原任务，再明确选择下一步。

## 项目与文档

| 入口 | 链接 |
| --- | --- |
| Composer 扩展 | [Mulibaixi/dsh-composer-extension](https://github.com/Mulibaixi/dsh-composer-extension) |
| 翻译插件 | [Mulibaixi/dsh-translation-plugin](https://github.com/Mulibaixi/dsh-translation-plugin) |
| 分发包 | [Composer 发行页](https://github.com/Mulibaixi/dsh-composer-extension/releases) · [翻译插件发行页](https://github.com/Mulibaixi/dsh-translation-plugin/releases) |
| 插件市场 | [Awesome DSH Plugin](https://awesome-dsh-plugin.com/?q=Mulibaixi%2Fdsh-composer-extension) · [dsh-plugin.org](https://dsh-plugin.org/plugins/mulibaixi/dsh-composer-extension) |
| 问题反馈 | [Composer Issues](https://github.com/Mulibaixi/dsh-composer-extension/issues) |
| 安装与组件维护 | [安装与更新](#安装与更新) |
| 操作说明 | [使用说明](#使用说明) |
| 更新记录 | [CHANGELOG](CHANGELOG.md) |
| 贡献指南 | [CONTRIBUTING](CONTRIBUTING.md) |

## 贡献与许可证

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，项目规范见 [AGENTS.md](AGENTS.md)。

本项目采用 [MIT 许可证](LICENSE)。
