# dsh-composer-extension

An early-stage DSH extension for coordinating the native Composer, its owning main Agent, and a translation executor.

The Client entry registers frozen Composer contributions only when the patched DSH seam explicitly reports protocol 1. The Host installs read, resolve and status tools into the actual owning Agent, queues one next-turn notice after the translation Client confirms a question, and allows one automatic resumed call for that operation. Exchange state is transient in the Host; question and answer history belongs to the translation plugin. The translation model can request context only through its restricted `request_context` tool when its DSH route supports tool calls and the matching translation adapter is registered.

The Composer seam requires a matching patched DSH build; stock `0.2.0-rc.2` does not provide it. Native integration checks use synthetic providers. The full P0 matrix and real desktop/model combinations are not yet verified, so this package is still a development candidate.

The matching translation plugin is v0.15.0. Context exchange requires a negotiated normal protocol v2; older connections retain text execution. A late context request does not wake the main Agent after the user stops it. Lost registration acknowledgements and Host reloads are reconciled by querying recorded facts; unknown operations never automatically call the model again. Use the [Host patch](patches/rc2-composer-submissions-v1.patch) and [version and checksums](patches/source-manifest.json) to build the matching Host.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing. Test files are for local verification and must not be committed. Commit checks reject cases, fixtures, snapshots, SDK probes and integration test scripts. Prepare these files and the required DSH components locally when running checks.

Requires Node.js 22 or later for development. Runtime packages are supplied by a matching DSH build; this package does not bundle another Cordis or DSH runtime. The library tarball is not a Windows update package. Desktop delivery requires a matching DSH build and a separate backup, install, and rollback process. See [the Chinese README](README.zh-CN.md) for the same status in Chinese.
