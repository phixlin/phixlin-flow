# Context

M3 初版 Codex Adapter 直接接受模型返回的 `ArtifactRef`、候选摘要和检查退出码。模型无法可靠计算宿主文件摘要，也不能作为机器检查结果的可信来源，因此该接口不能满足 M3 的候选绑定和验证门禁。

# Decision

Codex 只返回阶段语义结果，并由 `--output-schema` 约束结果外形。Adapter 保存事件和文本输出，Build 后由宿主读取 Git 状态与 diff 生成候选工件，`run-checks` 由宿主按 Shape 冻结的 argv 直接执行并记录退出码。Reviewer 和 Verifier 的执行标识及候选绑定继续由控制器注入。用户回答同样由宿主保存为不可变工件，恢复时注入阶段输入。

Stage Runner 的每次提交同时携带调用前完整状态摘要。Store 在版本检查之外核对该摘要，从而发现 `danger-full-access` 外部进程绕过 Store 改写主状态但不递增版本的情况。

Adapter 在保存 stdout/stderr 前替换调用方配置的非空敏感值，并拒绝工作区外的检查 cwd。超时、非零退出和损坏结构化输出统一形成 blocked 结果，由状态机预算决定重试或阻塞。

# Consequences

候选摘要、工件哈希和检查退出码不再由 Agent 声明。当前实现要求工作区是 Git 仓库，且候选采集以 `HEAD` 为基线；未跟踪文件内容进入 manifest，但不会进入 `git diff HEAD`，后续完整归档仍需显式保存这些文件。
