# dsh-composer-extension

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/Mulibaixi/dsh-composer-extension?label=release)](https://github.com/Mulibaixi/dsh-composer-extension/releases/latest)

Provides linked material submission and task coordination for the main chat input in DeepSeek Harness (DSH), with the goal of gradually supporting collaboration between the main conversation and different plugins.

The extension currently works with the translation workspace in `dsh-translation-plugin`. Prepare source material in the workspace, describe requirements in the main chat, and send both together. The main model can provide the translation model with consolidated background information and translation requirements for translation, refinement, and review.

[What problem does it solve?](#what-problem-does-it-solve) · [Installation](#installation-and-updates) · [User guide](#user-guide) · [Development direction](#development-direction) · [Projects and documentation](#projects-and-documentation)

## What problem does it solve?

- **Material and instructions get separated**: submit prepared translation material from the workspace with the main-chat message.
- **Tasks may need information**: provide an interface for the main model to consolidate information and submit it to the translation model.
- **Background work gets disconnected from the chat**: notify the owning main model at integrated task stages, reducing manual progress checking and result handoffs.

The translation plugin manages execution, session history, translation versions, and memory assets; the Composer extension handles material handoffs and task coordination.

## What it can do today

| Capability | Current role |
| --- | --- |
| Linked submission | Connect the main chat input with the translation workspace to submit instructions and prepared material together. |
| Supplementary information | Lets the main model deliver consolidated background information and translation requirements to the translation model. |
| Key-stage notices | Deliver messages requiring main-model attention for integrated analysis or document tasks. |
| Stop and stale-task handling | Avoid waking a user-stopped main model for late task messages, and prevent stale notices from being treated as current tasks. |

Current translation-model interactions start from specific user actions. The translation model cannot yet proactively ask the main model for additional information. Task coordination covers integrated analysis and document stages; platform and DSH-version requirements for the linked-submission patch are described below.

## Development direction

The future goal is to develop material submission, exchanges between the main conversation and plugin tasks, and stage notifications into collaboration capabilities that different plugins can adopt.

Near-term work prioritizes keeping the existing translation, refinement, and review features working reliably while gradually reducing coupling between this extension and the translation plugin. Clearer boundaries between collaboration handoffs and business logic should reduce the effect of business changes on the extension.

General-purpose collaboration is a future goal. The current interfaces are still built around translation, and a verified general-purpose integration for multiple plugins is not available yet.

## Requirements

- DSH `>=0.2.0-rc.2` with the plugin and main-session interfaces required by this extension. Compatibility follows interface capabilities rather than an enumerated list of DSH versions.
- The current translation workflow requires a companion build of `dsh-translation-plugin` providing the workspace and translation tasks. The companion builds use content protocol 3 and task-phase protocol 2.
- Configured models in DSH.
- Node.js 22 or later and pnpm to build from source.

Linked submission requires submissions protocol 1. An existing host interface is used directly without replacing files. Otherwise, **Windows Desktop matches bundled patches by target-module fingerprints, installs after a normal full exit, and uses them when DSH is reopened.** If an update leaves the relevant modules unchanged, the patch can be reused without updating the extension merely for a new version number. An identical installed patch is skipped. Users need no separate Node installation or installer script.

The current automatic patch artifacts are built from DSH `0.2.1-rc.3` and `0.2.1-rc.5`. These are build baselines, not an exhaustive plugin compatibility list. If target modules change and the host still lacks the submission interface, automatic replacement stops and requests new patch artifacts; other available capabilities remain usable. Future changes to required host interfaces may still need adaptation.

Other environments and older versions can use the [0.2.0-rc.2 patch](patches/rc2-composer-submissions-v1.patch) and [manifest](patches/source-manifest.json), or the [0.2.1-rc.2 patch](patches/dsh-0.2.1-rc.2-composer-submissions-v1.patch) and [manifest](patches/source-manifest-0.2.1-rc.2.json). Also available are the rc.3 [source patch](patches/dsh-0.2.1-rc.3-composer-submissions-v1.patch) and [manifest](patches/source-manifest-0.2.1-rc.3.json), and the rc.5 [source patch](patches/dsh-0.2.1-rc.5-composer-submissions-v1.patch) and [manifest](patches/source-manifest-0.2.1-rc.5.json).

## Installation and updates

### Install

1. Download `dsh-composer-extension-<version>.tgz` from [Releases](https://github.com/Mulibaixi/dsh-composer-extension/releases/latest). Enter its full local path or the asset's download URL in DSH's plugin manager, then install and enable it. Choose the `.tgz` asset containing the build output and host patch artifacts; no local build is needed.
2. Then install and enable the companion translation plugin from its [Releases](https://github.com/Mulibaixi/dsh-translation-plugin/releases/latest). Composer **0.4.5** provides the content protocol 3 and task-phase protocol 2 used by the current translation workflow. If the workspace and maintenance command are available, check them directly; fully restart if the plugin manager requests it. Open **Composer：联动组件维护**. If the component is prepared and awaiting installation, exit DSH completely and reopen it to apply the patch.
3. Open the translation workspace and confirm that Normal mode does not report missing material-submission support.

### Build from source

Prepare the companion DSH environment and extension source. In this repository, run:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm build
   ```

After building, install this directory in DSH's plugin manager. The regular build does not generate host patch modules; automatic linked-component setup and complete distribution packaging also require [building patch artifacts](#building-patch-artifacts) below.

### Update

1. Wait for current tasks to finish and confirm that material is saved. See the translation plugin's [backup and restoration guide (简体中文)](https://github.com/Mulibaixi/dsh-translation-plugin/blob/main/docs/user-guide.zh-CN.md#资料库备份与恢复) for a complete data snapshot.
2. Enter the **new version's full `.tgz` path or versioned download URL** in the plugin manager, then install and enable it. No prior uninstall is required. Use a new versioned filename or URL; the same installed path may be reported as already installed. Update the translation plugin as well only when the release notes require a companion update.
3. Follow the plugin manager's refresh, reload, or restart instructions, then open **Composer：联动组件维护**. If ready, keep using the existing patch. If a patch is prepared and awaiting installation, exit DSH normally and completely, then reopen it.

**Updating the extension package and updating the host patch are separate operations.** An extension-code update does not reinstall a matching host patch. Whether the plugin can load immediately still depends on DSH's instructions. Replacing a host patch requires a normal full exit; refreshing the window does not apply it.

For source installations, update the original source directory, reinstall dependencies, build, and refresh or reload the extension without uninstalling first. If the manager explicitly requires removal before installation, reinstall and enable it in the same DSH run. The uninstall test's exit-and-restore cycle is not the routine upgrade procedure.

Check compatibility between the extension, translation plugin, and DSH build when updating. The extension does not persist recoverable tasks across restarts, and reloading does not automatically repeat model requests.

See [CHANGELOG](CHANGELOG.md) for version changes.

### Linked component maintenance

Choose **Composer：联动组件维护** in the command list, or enter `/composer-maintenance`, to inspect status, check again, or arrange restoration of the previous host. A window closed to the tray keeps the helper waiting. Disabling, uninstalling, or reloading cancels a pending installation; a crash or forced exit does not authorize patch installation. An official update that changes the archive cancels the old task, and detection runs on the next load.

**Disabling or uninstalling this extension through DSH's plugin manager automatically schedules restoration of a patch installed by this extension. Restoration completes after DSH exits completely.** The helper and recovery files stay outside the extension directory and remain usable after the package is removed. A normal reload retains the installed patch; enabling the extension again before exit cancels a detected pending automatic restoration. To resume Normal translation, install or enable the extension again and follow its linked-component maintenance status.

Automatic restoration requires a valid installation record and backup owned by the extension. It returns to the state before that installation; manual or early development patches need separate recovery. An upgraded host or invalid backup stops restoration rather than overwriting a later installation.

Host-patch backups are under `dsh-composer-extension/host-patches/` in the current user's local application data directory, separate from translation-library backups. If DSH cannot open, exit it completely and run the corresponding task's `apply-host-patch.ps1 -JobPath <job.json> -Recover`. Recovery validates the version and hashes and refuses to replace a subsequently upgraded archive. A restored host is patched again only after **重新检测** is selected.

### Building patch artifacts

The regular build generates Host, Client, and the exit helper. Maintainers generate the patch modules for distribution; users do not compile the host at runtime. Prepare the fixed DSH source with its build dependencies and the matching official `app.asar`, then run:

```powershell
node scripts/build-host-patches.mjs --source <DSH-source> --archive <official-app.asar>
pnpm build
pnpm pack
```

The tool validates and applies the fixed source patch in the provided source tree, then builds into `dist/host-patches/<build-version>/`: two linked-submission modules and the plugin manager with corrected restart copy. Run it for multiple baselines to bundle them together. Directory versions record build provenance; runtime checks compare actual target-module fingerprints. It needs Node.js 22.19 or later; `--from-build` reuses existing artifacts after source validation. Packaging checks each artifact set and helper integrity. Generated files do not enter the source repository.

## User guide

### 1. Send material and instructions together

Choose Normal mode in the translation plugin, enter source text or select a supported source file, then write the current requirements in the main chat input and send.

Use the same translation session and saved material from different main chats. The model in the chat where you send the message handles the current submission.

The material accompanies that message, and the main model arranges processing according to your intent. Use the translation input for source material and the main chat for instructions, discussion, and revision requests. To send only a chat message this time, select **本次不附带 (Do not attach this time)** where offered by the translation plugin.

Submission retains the source as sent. Editing the next draft does not rewrite it. Use the translation plugin to inspect results, correct source material, or retranslate.

### 2. Supplementary information

Describe the current goal or specify information in the main chat. The main model consolidates the relevant background and translation requirements, then delivers them to the translation model for the current translation or refinement.

Current interactions start from specific user actions. The translation model does not yet initiate interactions on its own or proactively ask the main model for additional information.

### 3. When background work needs attention

Integrated tasks notify the owning main model about critical questions, changed material, or results needing review. They do not send a notice for every completed chunk. The main model continues from the actual task without requiring a repeated user instruction at each step.

After switching main chats, notices for existing tasks still go to the chat that started the task.

After you stop the main model, late notices do not substitute for a new user instruction. Check the original task before retrying an unknown outcome. Background results and history remain available in the translation plugin.

### 4. When a feature is unavailable

- **Linked submission is unavailable**: check the companion DSH build, confirm both plugins are enabled, and restart DSH.
- **Proactive requests for additional information**: proactive interaction is not supported yet. Specified information can be delivered to the translation model through the main model.
- **No stage notice appears**: not all background workflows use this extension. Inspect progress and errors in the translation plugin instead of resubmitting solely because the main chat is quiet.
- **Work does not continue after restart**: the extension does not automatically restore temporary exchanges. Check the original task in the translation plugin before explicitly choosing the next action.

## Projects and documentation

| Entry | Link |
| --- | --- |
| Composer extension | [Mulibaixi/dsh-composer-extension](https://github.com/Mulibaixi/dsh-composer-extension) |
| Translation plugin | [Mulibaixi/dsh-translation-plugin](https://github.com/Mulibaixi/dsh-translation-plugin) |
| Distribution packages | [Composer releases](https://github.com/Mulibaixi/dsh-composer-extension/releases) · [Translation releases](https://github.com/Mulibaixi/dsh-translation-plugin/releases) |
| Bug reports | [Composer issues](https://github.com/Mulibaixi/dsh-composer-extension/issues) |
| Installation and component maintenance | [Installation and updates](#installation-and-updates) |
| Operations | [User guide](#user-guide) |
| Changes | [CHANGELOG](CHANGELOG.md) |
| Contributions | [CONTRIBUTING](CONTRIBUTING.md) |

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution instructions and [AGENTS.md](AGENTS.md) for project rules.

Licensed under [MIT](LICENSE).
