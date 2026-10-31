# 贡献指南

开发需要 Node.js 22 或更高版本及 pnpm。执行 `pnpm install --frozen-lockfile` 后运行 `pnpm hooks:install`，公开源码的构建检查入口为 `pnpm build`。完整发行包还需按 README 准备宿主补丁产物，再执行 `pnpm pack`。构建及合成验证不能代替 DSH 桌面实测。

Host 负责交换协调，翻译插件持有材料、模型调用及历史；Client 使用原生 Composer 提交接口。DSH 和 Cordis 运行时使用 peer dependency，不打包第二份。

测试文件仅用于本地验证，不得提交。包括测试用例、测试夹具、快照、测试专用 SDK 探针和集成测试脚本；已有被 Git 跟踪的测试文件，其本次修改也不得暂存或提交。删除重复或无意义的测试，保留能验证关键行为的本地检查。提交前明确选择源码、构建工具及公开文档，不使用全量暂存；Git hooks 会拒绝新增或修改的测试文件。

`pnpm test:unit` 与 `pnpm test:native` 是维护者准备好本地用例及所需 DSH 环境后的验证入口，测试文件不随公开仓库提供。仅获取公开源码时，先运行 `pnpm build`；按改动影响范围运行已具备的本地验证。

已有测试应通过 `git rm --cached` 停止跟踪并提交索引删除，保留本地文件；不删除本地测试，也不重写历史。`.gitignore` 只阻止未跟踪文件入库，不能代替已有测试的停止跟踪操作。

不得提交密钥、用户翻译正文、本机路径、profile、内部设计与验收资料、依赖目录或构建产物。内部资料保存在工作区的 `docs/plugin-development/dsh-translation-plugin/`。

`README.md` 使用英文，`README.zh-CN.md` 使用中文并保持同步；CHANGELOG 和提交说明使用中文。提交采用 Conventional Commits，不绕过 Git hooks，不重写历史。本地提交不代表远程发布，远程发布需用户明确授权。
