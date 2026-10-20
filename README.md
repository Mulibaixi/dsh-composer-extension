# dsh-composer-extension

[English](README.md) | [简体中文](README.zh-CN.md)

Linked material submission and task coordination for the main chat input in DeepSeek Harness (DSH), helping the main model and translation plugin work on the same request.

Prepare source material in the translation workspace, describe requirements in the main chat, and send both together. When supported translation tasks need more background or attention to a critical issue, the extension routes the request back to the appropriate main chat, reducing manual copying and message passing.

## What problem does it solve?

- **Source material and instructions get separated**: submit prepared translation material with the main-chat message.
- **Translation may need more background**: let the translation model ask the main model for context in supported tasks.
- **Background work gets disconnected from the chat**: notify the owning main model at integrated task stages, reducing manual progress checking and result handoffs.

This is a companion extension, not a standalone translator. The translation plugin manages execution, session history, translation versions, and memory assets. This extension does not provide another translation workspace.

## What it can do today

| Capability | Current role |
| --- | --- |
| Linked submission | Connect the main chat input with the translation workspace to submit instructions and prepared material together. |
| Context requests | Route translation questions to the owning main model when supported by the translation plugin and selected model. |
| Key-stage notices | Deliver messages requiring main-model attention for integrated analysis or document tasks. |
| Stop and stale-task handling | Avoid waking a user-stopped main model for late requests, and prevent stale notices from being treated as current tasks. |

Available features depend on the DSH build, translation plugin, and selected models. Installing the extension does not mean that it schedules every background task, nor does it guarantee translation speed or quality.

The project is still in development. Complete desktop workflows and different model combinations need confirmation in the actual environment.

## Requirements

- A companion DSH `0.2.0-rc.2` or `0.2.1-rc.2` build supporting the extension.
- A companion build of `dsh-translation-plugin` providing the workspace and translation tasks. The companion builds use content protocol 3 and task-phase protocol 2.
- Configured models in DSH. Context requests from the translation model also require tool-call support in that model.
- Node.js 22 or later and pnpm to build from source.

**Official, unmodified DSH does not provide linked material submission in either supported version. Installing this extension alone does not add it; a matching host patch is required.** Use the [0.2.0-rc.2 patch](patches/rc2-composer-submissions-v1.patch) with its [source manifest](patches/source-manifest.json), or the [0.2.1-rc.2 patch](patches/dsh-0.2.1-rc.2-composer-submissions-v1.patch) with its [source manifest](patches/source-manifest-0.2.1-rc.2.json). Rebuild and apply the matching patch after a DSH upgrade. The extension does not modify or upgrade the desktop application automatically.

## Installation and updates

### Install

1. Prepare the companion DSH environment and extension source. In this repository, run:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm build
   ```

2. In DSH's plugin manager, install this directory as a local plugin named `dsh-composer-extension` and enable it.
3. Install and enable a matching translation plugin, then restart DSH.
4. Open the translation workspace and confirm that Normal mode does not report missing material-submission support.

### Update

1. Save work you want to retain in the translation plugin and back up important material.
2. Update both source directories and reinstall dependencies. Build the Composer extension first, then the translation plugin.
3. Refresh or reload the extension in the plugin manager and restart DSH. If there is no refresh action, uninstall and reinstall the same directory.

Check compatibility between the extension, translation plugin, and DSH build when updating. Do not treat a restart as automatic recovery while work is running or its outcome is unknown. The extension does not persist recoverable tasks across restarts, and reloading does not automatically repeat model requests.

See [CHANGELOG](CHANGELOG.md) for version changes.

## User guide

### 1. Send material and instructions together

Choose Normal mode in the translation plugin, enter source text or select a supported source file, then write the current requirements in the main chat input and send.

Use the same translation session and saved material from different main chats. The model in the chat where you send the message handles the current submission.

The material accompanies that message, and the main model arranges processing according to your intent. Use the translation input for source material and the main chat for instructions, discussion, and revision requests. To send only a chat message this time, select **本次不附带 (Do not attach this time)** where offered by the translation plugin.

Submission retains the source as sent. Editing the next draft does not rewrite it. Use the translation plugin to inspect results, correct source material, or retranslate.

### 2. Handle questions during translation

In tasks supporting context requests, the translation model can ask for missing background or context. The main model may provide a supplement, defer to the user, or stop the operation.

Automatic exchanges are limited, rather than an unlimited discussion loop. If processing cannot continue, provide the necessary information in the main chat and check the task state shown by the translation plugin. Not every file task or model combination supports context requests.

### 3. When background work needs attention

Integrated tasks notify the owning main model about critical questions, changed material, or results needing review. They do not send a notice for every completed chunk. The main model continues from the actual task without requiring a repeated user instruction at each step.

After switching main chats, context requests and notices for existing tasks still go to the chat that started the task.

After you stop the main model, late notices do not substitute for a new user instruction. Check the original task before retrying an unknown outcome. Background results and history remain available in the translation plugin.

### 4. When a feature is unavailable

- **Linked submission is unavailable**: check the companion DSH build, confirm both plugins are enabled, and restart DSH.
- **No context request appears**: the current model or task may not support it; this alone does not indicate translation failure.
- **No stage notice appears**: not all background workflows use this extension. Inspect progress and errors in the translation plugin instead of resubmitting solely because the main chat is quiet.
- **Work does not continue after restart**: the extension does not automatically restore temporary exchanges. Check the original task in the translation plugin before explicitly choosing the next action.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution instructions and [AGENTS.md](AGENTS.md) for project rules.

Licensed under [MIT](LICENSE).
