# dsh-composer-extension

这是一个处于早期开发阶段的 DSH 扩展，用于连接原生 Composer、所属主 Agent 和翻译执行器。

Client 入口只会在已打补丁的 DSH seam 明确声明 protocol 1 时注册冻结式 Composer 贡献。Host 会把读取、答复和状态工具安装到实际所属 Agent；翻译 Client 确认求助问题后才会安排一次 next-turn 通知，同一操作最多自动补充一次。Host 只在内存保存 exchange 状态；问题和答复历史归翻译插件保存。翻译模型仅能在所选 DSH 路由支持工具调用且匹配的翻译适配器已注册时，通过受限 `request_context` 工具请求补充资料。

Composer seam 需要匹配的 DSH 补丁构建；官方 stock `0.2.0-rc.2` 不提供该接口。原生集成检查使用合成 provider；完整 P0 矩阵和真实桌面/模型组合尚未验证，因此当前仍是开发候选。

匹配的翻译插件为 v0.15.0。新交互要求 Host/Client 协商普通协议 v2，旧连接保留原有文本执行。用户停止主模型后，迟到求助不重新唤醒；登记回执丢失或宿主重新加载时查询原事实，状态未知的操作不自动重新调用模型。源码中的 [宿主补丁](patches/rc2-composer-submissions-v1.patch) 及 [版本与摘要](patches/source-manifest.json) 用于构建匹配的宿主。

贡献前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。测试文件只用于本地验证，不提交；提交检查会拦截用例、夹具、快照、SDK 探针及集成测试脚本。本地验证需自行准备这些文件和相应 DSH 组件。

开发环境需要 Node.js 22 或更高版本。运行时依赖由匹配的 DSH 构建提供，本包不重复打包 Cordis 或 DSH 运行时。库包不是 Windows 更新包；桌面交付须使用匹配的 DSH 构建，并通过独立流程备份、安装和回退。英文说明见 [README](README.md)。
