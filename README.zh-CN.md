# dsh-composer-extension

这是一个处于早期开发阶段的 DSH 扩展，用于连接原生 Composer、所属主 Agent 和翻译执行器。

Client 入口只会在已打补丁的 DSH seam 明确声明 protocol 1 时注册冻结式 Composer 贡献。Host 会把读取、答复和状态工具安装到实际所属 Agent；翻译 Client 确认求助问题后才会安排一次 next-turn 通知，同一操作最多自动补充一次。Host 只在内存保存 exchange 状态；问题和答复历史归翻译插件保存。翻译模型仅能在所选 DSH 路由支持工具调用且匹配的翻译适配器已注册时，通过受限 `request_context` 工具请求补充资料。

Host 还提供独立的进程内任务阶段服务，使用扩展自己的 `phaseProtocol` 1。Owner 通过 `registerTaskPhaseInspector` 注册核验器、用 `taskPhaseCapabilities` 查询能力，再用 `notifyTaskPhase` 提交短阶段事件；扩展会先核对 inspector 返回的结果，再向准确的所属主 Agent 排入去重通知。通知只带操作和结果引用供后续查询，不带原文或结果表格。该扩展契约独立于 Composer protocol 1、Exchange protocol 1、Normal protocol 2 和 Remote v1，也不是 DSH 官方接口。用户已停止主 Agent 时会丢弃阶段通知。缺少阶段核验器或可用主 Agent 路由时，扩展会报告阶段通知不可用。

文档分批执行另行协商 `batchProtocol` 1：Owner 使用 `registerBatch` 注册执行适配器、`registerBatchTaskPhaseInspector` 注册任务事实核验器，并通过 `batchCapabilities` 分别检查求助和阶段通知能力。同一 Owner 可以同时保留普通短文和术语分析的注册。批处理求助沿既有 exchange 工具和主 Agent 队列运行；子操作引用真实文档单元、子操作、调用、上下文版本、宿主代次与事件序号，翻译插件负责准确范围转换及每块一次、整篇三次的自动补充预算。缺少批处理求助能力时使用 `text_only`。

`notifyBatchTaskPhase` 只接受关键疑点、依赖变化或整篇候选复核的短任务引用，含固定所属范围、taskId、unitId、sourceVersion、任务版本与 taskSequence。核验器在入队及交给主模型前复核事实；普通块完成不产生阶段通知。用户停止主 Agent、事实失效或 Owner 卸载时，扩展移除自己的过期通知并保留混合队列中的用户文字；补充登记期间停止或卸载不会继续派发。

Composer seam 需要匹配的 DSH 补丁构建；官方 stock `0.2.0-rc.2` 不提供该接口。原生集成检查使用合成 provider；完整 P0 矩阵和真实桌面/模型组合尚未验证，因此当前仍是开发候选。

匹配的翻译插件为 v0.19.0；文档分批控制与求助属于当前开发阶段，整篇质检和最终交付仍需后续阶段。上下文求助要求 Host/Client 协商普通协议 v2，旧连接保留原有文本执行。用户停止主模型后，迟到求助不重新唤醒；登记回执丢失或宿主重新加载时查询原事实，状态未知的操作不自动重新调用模型。术语分析阶段通知由翻译插件另行注册 `phaseProtocol` 1 inspector；旧扩展仍可查询结果，但不能排入这类通知。新增批处理能力通过独立进程内端口协商，不改变旧 Remote v1 回执和 codec。源码中的 [宿主补丁](patches/rc2-composer-submissions-v1.patch) 及 [版本与摘要](patches/source-manifest.json) 用于构建匹配的宿主。

贡献前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。测试文件只用于本地验证，不提交；提交检查会拦截用例、夹具、快照、SDK 探针及集成测试脚本。本地验证需自行准备这些文件和相应 DSH 组件。

开发环境需要 Node.js 22 或更高版本。运行时依赖由匹配的 DSH 构建提供，本包不重复打包 Cordis 或 DSH 运行时。库包不是 Windows 更新包；桌面交付须使用匹配的 DSH 构建，并通过独立流程备份、安装和回退。英文说明见 [README](README.md)。
