# phixlin-flow 技术路线图与实施计划书

## 1. 文档目的

本文档定义 phixlin-flow 在 `native-workflow-state-machine.md` 设计参考基础上的实现路线。参考文档不是现成代码，不能直接照抄接口或假定函数存在。单文件状态、CAS 写入、内层 loop、Builder Handoff 和 Verify 修复循环必须按本项目约束重新设计、实现并用故障测试验证。详细协议见 [runtime-design.md](runtime-design.md)。

首要交付目标：在 Codex CLI 平台上跑通一次完整的 `shape -> build -> verify -> completed` 流程，包括需求确认、Skill 执行、代码修改、验证、结果确认和本地知识归档。先完成真实闭环，再增强恢复与运维能力。

Claude Code 作为后续 Runtime Adapter，不进入首个可用版本的验收范围。

## 2. 设计原则

### 2.1 阶段少而稳定

三个工作阶段和一个终态：

```text
shape -> build -> verify -> completed
```

人工确认使用 `status: await-user`，不增加主阶段。Verify 失败回到 Build；验证通过且人工确认后，由 finalize 动作完成本地归档再进入 completed。参考文档的 archive 阶段在此收敛为动作，原有 done 对应 completed。

### 2.2 人工编排，机器执行

每个 change 由用户的 `brief.md` 和人工编排的 `Run Plan` 驱动。Run Plan 决定各阶段使用哪些 Skill 及顺序；列入计划即必须执行。开始执行后生成计划快照。Agent 不动态改变计划；需求变化需回 Shape，经人工确认后递增 brief_revision。

### 2.3 Skill 是阶段内执行单元

Skill 不是状态，也不单独扩展状态图。阶段内部统一执行：

```text
读取阶段计划 -> 执行 Skill -> Agent 工作 -> 检查完成条件 -> 提交检查点
                                  ^                         |
                                  +-------- 未完成 --------+
```

Build 没有 Skill 时也必须可执行；Shape 可以强制执行 `grill-me`、`brainstorming` 等 Skill。

### 2.4 单文件状态与恢复边界

主状态文件是唯一恢复依据，包含计划快照、Skill 进度、交接引用和 history；checkpoint 指主状态的一次原子提交，不增加独立检查点数据库。JSONL 是运行诊断日志，不能覆盖主状态。外部调用前先记录 running；调用结果与状态写入无法跨进程原子提交，中断后的未知结果必须核对，不能承诺副作用恰好执行一次。

## 3. 目标架构

```text
                    +----------------------+
                    | Human-authored Plan  |
                    | run-plan.yaml        |
                    +----------+-----------+
                               |
                               v
+----------------+   +---------+----------+   +-------------------+
| mjs CLI        |-->| Native State       |-->| Codex Runtime     |
| start/resume   |   | Machine + CAS      |   | Adapter           |
| pause/status   |   | phases + loops     |   | codex exec        |
+----------------+   +---------+----------+   +---------+---------+
                               |                         |
                               v                         v
                    +----------+----------+   +----------+----------+
                    | Stage Runner       |   | Skill Launcher       |
                    | guards/checkpoints |   | local/open-source    |
                    +----------+----------+   +----------+----------+
                               |                         |
                               +------------+------------+
                                            v
                                  +---------+----------+
                                  | Evidence / State  |
                                  | state + events    |
                                  | artifacts + logs  |
                                  +--------------------+
```

### 3.1 模块边界

| 模块 | 首期职责 |
|---|---|
| `state-machine` | 状态解析、转换守卫、CAS、版本冲突处理 |
| `stage-runner` | 阶段内 loop、Skill 顺序、退出检查、检查点 |
| `skill-runner` | 加载和调用已编排 Skill，记录执行结果 |
| `codex-adapter` | 将统一调用映射到 Codex CLI/runtime |
| `evidence-store` | 事件、日志、Skill 输出、handoff 和报告 |
| `cli` | 创建运行、推进、暂停、恢复、审批、导出 |
| `schemas` | Run Plan、状态、事件、handoff 的最小校验 |

## 4. Run Plan 设计

Run Plan 是人针对一个可实施编码需求编排的计划，不是运行实例。需求以 change-id 为唯一管理单元；恢复、修复、需求调整和重新确认都属于同一个 change。MVP 不引入 run-id。计划仅保存各阶段 Skill 名称与顺序，不扩展 Skill 注册系统。

```yaml
version: 1
name: implement-user-auth
workflow: phixlin-flow-v1
runtime: codex

stages:
  shape:
    skills:
      - grill-me
      - brainstorming
  build:
    skills: []
  verify:
    skills:
      - test-runner
      - code-review
```

首期只需要支持以下字段：

- `version`
- `workflow`
- `runtime`
- `stages.<stage>.skills[]`（Skill 名称或相对路径）
- Skill 顺序（数组顺序）
- 首期固定 Shape 和最终结果人工确认，不增加可配置审批策略

Skill 使用既有 SKILL.md，不设计新 Manifest。名称通过本地简短映射解析到路径，也可以直接引用路径。自建 Skill 与开源仓库的某个子目录走相同解析流程；首期由人提前安装，保留来源和许可证，启动时校验相对资源可访问。数组内声明的 Skill 全部必执行，不想执行就不放入计划。

### 4.1 计划快照

`start` 时将解析后的计划嵌入主状态，`plan.snapshot.yaml` 只是可再生的导出副本，并记录：

- 计划内容哈希
- 每个 Skill 的解析路径、内容摘要和相关本地资源摘要；可得时记录来源 commit
- 运行时名称
- 创建时间和创建者

执行期间禁止直接修改快照。人工 replan 在同一 change 中递增 plan.revision，回 Shape 重新确认并使旧候选/审批失效；恢复和执行重试不创建新需求。

## 5. 状态机扩展

由参考设计收敛得到：

```text
shape -> build -> verify -> completed
```

在状态中增加最小 Skill 执行信息：

```yaml
plan_snapshot:
  hash: sha256:...
  stages:
    shape: [grill-me, brainstorming]
    build: []
    verify: [test-runner, code-review]
stage_execution:
  stage: shape
  stage_visit: 1
  skill_index: 1
  skills:
    - name: grill-me
      status: completed
      execution_ref: exec-001
    - name: brainstorming
      status: running
      execution_ref: exec-002
```

Skill 状态只需要支持：

```text
pending | running | completed | failed
```

阶段退出守卫检查：

1. 当前阶段进入轮次中，所有已编排 Skill 是否 `completed`
2. 阶段输出是否存在
3. 本项目定义的阶段验收条件是否满足
4. 是否存在未解决 blocker
5. 当前输入、候选与执行结果是否匹配，然后原子提交阶段结果与推进状态

每次进入阶段生成 stage_visit，Skill 标识为 stage_visit + 数组位置；attempt 仅表示同一调用的重试。Verify 回 Build 时新一轮 Build Skill 全部重新执行，新候选进入 Verify 后也重新执行 Verify Skill。同轮恢复保留已完成项；规格漂移回 Shape 时生成新轮次并重新确认验收项。

每个 Agent turn 返回 `continue`、`needs-user`、`blocked` 或 `stage-ready`，只有控制器可推进。首期默认每阶段最多 20 次自动 turn，同一执行连续失败 3 次进入 blocked；Verify 失败修复最多 3 轮，连续 3 轮未解决验收项没有减少则 await-user。用户等待不占自动重试次数。

grill-me、brainstorming 等分析 Skill 默认顺序调用；TDD 等持续约束 Skill 在派发时加载，其指令同时进入本阶段后续 Agent 工作上下文，避免把“加载过”误当作整个实现过程已遵循。

## 6. Codex Runtime 适配

首期使用 Codex 的非交互执行能力承载自动化阶段。[官方非交互执行文档](https://developers.openai.com/codex/noninteractive/)说明 `codex exec` 支持脚本执行、显式 sandbox 配置、`--json` 事件流及 `--output-schema` 结构化最终结果（核对日期：2026-09-08）。实现时封装在 CodexRuntimeAdapter，具体 CLI 版本、参数兼容性与本机认证在 M0 实测冻结。

这些 CLI 能力不等同于稳定的原生 Skill 调用 API。首期由控制器解析 SKILL.md 和本地资源，为每个 Skill 创建专门的 Codex 调用，明确加载指令及任务输入。Skill 依赖 Claude 专属工具、不可用命令或仓库外资源时，应在启动检查中报出不兼容，不能声称所有开源 Skill 都能直接运行。

非交互调用需要提问时输出 `needs-user` 和问题，控制器保存后进入 await-user。用户通过 answer 命令提交文本，resume 再把回答和既有产物交给同一逻辑调用。主状态恢复不依赖 Codex 会话恢复，必要时创建新会话。审批由 CLI 单独接收，绑定 state_version、规格摘要或 candidate_id；Agent 输出 confirmed 不算人工批准。

建议接口：

```ts
interface RuntimeAdapter {
  start(input: StartInput): Promise<ExecutionRef>;
  runStage(input: StageInput): Promise<StageResult>;
  runSkill(input: SkillInput): Promise<SkillResult>;
  interrupt(ref: ExecutionRef): Promise<void>;
  resume(input: StageInput): Promise<StageResult>;
  collect(ref: ExecutionRef): Promise<ExecutionArtifacts>;
}
```

Codex Adapter 负责：

- 生成稳定的阶段提示和 Skill 提示
- 注入当前状态、计划快照和阶段交接
- 设置最小所需 sandbox 权限
- 捕获 JSONL 事件和最终结构化结果
- 绑定 `execution_ref`
- 将输出写入 evidence store

状态机负责：

- 何时可以调用 Adapter
- Skill 是否已经执行
- 阶段是否可以推进
- 失败是否重试或阻塞

## 7. 阶段运行协议

### 7.1 Shape

运行顺序：

```text
加载 shape 计划
-> grill-me
-> brainstorming
-> Agent 汇总需求、约束和验收项
-> 写入 brief/specs
-> 人工确认或继续 loop
```

Shape 输出至少包括：

- 目标和非目标
- 约束
- 验收项
- 未决问题
- 风险
- 面向 Build 的 handoff

### 7.2 Build

运行顺序：

```text
读取 Shape handoff
-> 按计划执行 Skill
-> Agent 修改代码
-> 运行开发期检查
-> 生成 Builder Handoff
-> 进入 Verify
```

Build 允许空 Skill 列表。自行设计 Builder Handoff、候选摘要、执行引用和独立 Review 绑定。独立 Review 是内置门禁，不强制用户配置 review Skill；通过独立 Codex 调用执行，和用户编排 Skill 分开记录。

### 7.3 Verify

运行顺序：

```text
读取 Builder Handoff
-> 执行 verify Skills
-> 运行必需检查
-> 生成 Verifier Envelope
-> pass: 等待人工确认，然后 finalize
-> fail: 在预算内回 Build repairing
-> blocked: await-user
```

自行实现失败次数、停滞检测和执行失败重试规则，详见运行时设计。首期每轮候选全量验证，不照搬参考文档的局部结果保留和 recovery 分支。

### 7.4 Finalize 与 completed

Finalize 是 Verify 阶段的完成动作，主要执行：

- 检查 Verify pass
- 生成最终报告
- 检查当前候选已有人工确认
- 归档 plan、state、events、handoff、测试报告和代码变更摘要
- 本地归档成功后将 phase 置为 `completed`，status 置为 `done`

首期归档采用 keep 工作区语义，不自动 merge、push、创建 PR 或发布。归档写入失败时留在 Verify 的 blocked 状态，修复后可幂等重试，不重新运行已确认的候选。

## 8. 证据与可恢复性

每个 Skill 执行至少记录：

```json
{
  "execution_ref": "exec-002",
  "stage": "shape",
  "skill": "brainstorming",
  "status": "completed",
  "input_hash": "sha256:...",
  "output_artifact": "artifacts/exec-002.json",
  "started_at": "...",
  "completed_at": "..."
}
```

恢复规则：

- `pending`：从该 Skill 开始
- `running`：归类为结果未知，核对进程、持久化结果与工作区；无法确认时 blocked，禁止自动重做代码修改
- `completed`：不重复执行，直接消费输出
- `failed`：按阶段策略重试，超过预算进入 `blocked`
- 缺失 Skill 或执行失败不允许静默跳过

所有状态写入使用 `state_version` + mutation lock + 原子替换。单纯先读版本再 rename 并不足以防止并发写入。锁覆盖读取、校验和提交；实现必须测试并发竞争、陈旧锁及写入中断。外部调用成功但状态尚未提交的窗口通过结果核对处理，不宣称 CAS 能消除该窗口。

保证触发意味着控制器按计划显式派发 Skill 内容，并记录宿主生成的 execution_ref、输入摘要、过程和输出；不是依赖 Agent 自行发现 Skill，也不是信任模型自报的 completed。控制器校验结构化结果和阶段工件后才提交完成。模型是否完全遵循自然语言 Skill 的每条指令无法机械证明，需依靠针对任务的验证与人工确认。源码写权限若同时覆盖状态目录，这也不是恶意 Agent 防篡改边界；控制目录应置于 Agent 可写工作区之外，并在 Codex 能力试验中验证隔离。

## 9. 技术路线图

### 路线 A：最小闭环（首要）

目标是 Codex 单平台可完整运行：

```text
Run Plan -> Shape Skills -> Build -> Verify -> finalize -> completed
```

M0 就进行真实 Codex 调用试验；M1、M2 每完成一部分即接入真实调用，避免直到 M3 才暴露平台问题。M3 是首个端到端可用版本的硬验收门，完整故障恢复与运维增强随后交付。

### 路线 B：可编排增强

在闭环稳定后增加：

- 更多 Skill 来源
- Skill 版本锁定
- Skill 输出 Schema
- Skill 条件执行
- 并行 Skill
- 可视化运行状态

### 路线 C：平台复用

实现第二个 Runtime Adapter：

- Claude Code 会话调用
- 工具权限映射
- 输出和恢复语义适配
- 同一 Run Plan 的跨平台契约测试

## 10. 实施计划与验收标准

按一名熟悉 Node.js 的工程师估算，自行设计并实现核心机制后，M0 至 M3 为 15–23 个工作日，M4 至 M5 为 7–11 个工作日。时间是排期参考，按验收结果放行；在 M0 完成协议与平台试验后重新估算。所有任务当前均为待实施，本文没有宣称已有可运行实现。

| 里程碑 | 依赖 | 预计工作日 | 发布门 |
|---|---|---:|---|
| M0 自有状态协议与能力试验 | 无 | 4–6 | 设计契约、reducer fixture、真实 Codex 最小调用可行 |
| M1 自有状态机骨架 | M0 | 4–6 | 单文件 CAS、动作表、故障向量通过 |
| M2 编排与交接 | M1 | 3–4 | 本地和开源子目录 Skill 可触发 |
| M3 Codex 完整闭环 | M2 | 4–7 | 人工确认、真实代码变更、验证及归档全部完成 |
| M4 恢复增强 | M3 | 4–6 | 故障注入矩阵通过 |
| M5 可运维 MVP | M4 | 3–5 | 文档、诊断与审计包可独立使用 |
| M6 Claude Code | M5 稳定后 | 另行估算 | 不阻塞首个平台发布 |

建议使用 Node.js LTS + ESM `.mjs`，YAML 使用成熟解析库，Schema 使用 JSON Schema/Ajv，测试使用 node:test；不手写 YAML 解析器，不在首期引入数据库或工作流框架。CLI 所有推进均带 expected state_version 与 expected action。

### M0：自有状态协议与能力试验

目标：把参考文档中的想法转成 phixlin-flow 自有、可机器验证的状态协议；同时确认 Codex 和 Skill 加载的真实能力。

#### M0.1 设计自有单文件状态

子任务：

- 按 `runtime-design.md` 定义 v1 状态字段、初始值和跨字段不变量
- 定义 outer.phase/status 与 inner.state/position 的双层组合关系，next_action 由 decide(state) 推导
- 明确 artifact 引用、哈希、历史和运行目录不进入 Agent 工作区的边界

验收标准：

- 形成可评审的状态 Schema 和字段字典
- 完整初始、Build、Verify、Completed fixture 均可解析
- 通过非法 phase、过期 candidate、重复 Skill、错误状态组合测试

#### M0.2 设计 CAS 提交协议

子任务：

- 确认 Linux 文件锁封装、固定锁 inode、超时和 stale 进程行为
- 实现 `mutate(expectedVersion, actionId, action)` 的接口草案
- 设计 temp write、fsync、rename、目录 fsync 和异常恢复测试
- 明确 reserve/dispatch/collect/commit 外部调用窗口

验收标准：

- 产出 CAS 序列图和错误码表
- D01-D04 故障向量通过设计审查，并至少有一个真实文件系统 spike
- 相同 actionId 幂等，不同载荷冲突；未知外部执行不会盲目重做
- 不以“先读版本再 rename”作为并发安全实现

#### M0.3 冻结 Run Plan v1

子任务：

- 定义 YAML/JSON Schema
- 支持 shape/build/verify 三阶段 Skill 数组
- 支持 `runtime: codex`
- 固定最终人工确认

验收标准：

- 合法计划可以解析并生成快照
- 缺少 workflow、runtime 或非法阶段时明确报错
- Build 空 Skill 计划可以通过校验

#### M0.4 冻结首期 CLI 和目录结构

子任务：

- 确定 `<repository>/.phixlin/changes/<change-id>/` 布局，包含 brief/specs 和需求创建、恢复、修复、完成的 CLI 生命周期
- 定义 `start/status/resume/pause/answer/confirm-shape/accept-result/request-changes/history/export-evidence` 命令
- 定义事件和 Skill 执行记录格式

验收标准：

- 新开发者可以创建一个编码需求，重启和修复始终用同一 change-id 管理
- 目录中能区分状态、计划、事件、工件和日志

#### M0.5 前置 Codex 能力试验（进入 M1 前完成）

子任务：

- 核对 Codex 安装、认证、事件输出和结构化结果，记录测试版本。
- 用一个自建 Skill 和一个开源项目子目录 Skill 验证加载及相对资源读取。
- 验证 needs-user/answer 往返、workspace-write 和控制目录隔离。

验收标准：

- 保存一次真实执行的脱敏事件与结果，结果通过 Schema 校验。
- 两类 Skill 都留下宿主派发记录；缺失资源时失败且不推进。
- 用户回答后可继续同一 Shape 轮次；Agent 不能以结果字段代替人工批准。
- 对未验证能力列出阻塞项或明确降级方案，禁止把缺失能力标成已支持。

### M1：自有状态机与内层 Loop

目标：实现自己的状态解析、CAS、reducer、动作表、外部调用恢复和 Verify 修复循环，不复用参考文档中的实现代码。

#### M1.1 实现状态解析与 reducer

子任务：

- 实现完整 v1 JSON Schema、双层状态组合不变量和 root reducer
- 实现 action guard、history 和版本递增
- 实现严格拒绝未知 schema/字段组合

验收标准：

- reducer 对所有 M0 fixture 输出预期状态
- 非法 action 不产生写入
- 过期 candidate、审批和 verification 全部拒绝

#### M1.2 实现自有 CAS Store

子任务：

- 实现固定 inode 锁、原子状态替换和 actionId 幂等
- 实现进程退出、锁超时、临时文件和目录同步处理
- 实现 reserve/collect/commit 的 in_flight 处理

验收标准：

- D01-D04 自动化测试通过
- 并发写只有一个版本递增，原状态不会被半写文件替代
- in_flight 未知时进入 blocked，不自动重复代码修改

#### M1.3 实现 Stage Runner 与内层 Loop

子任务：

- 实现 ready/executing/evaluating/waiting-user/reconciling/stage-ready 内层状态转换与纯函数 decide
- 实现外层阶段守卫及 turn/visit/iteration 预算，双层更新必须同次提交
- 实现 reserve/dispatch/collect/commit
- 实现阶段退出守卫和 checkpoint（即主状态的一次提交）

验收标准：

- Shape 配置两个 Skill 时，缺任意一个都不能进入 Build
- Build 空 Skill 时可以直接进入实现 loop
- 阶段中断后按 in_flight 规则恢复
- D05、D06、D11 通过

#### M1.4 实现 Fake Runtime 与状态机测试向量

子任务：

- 为 Shape、Build、Verify、finalize 提供可控 fake runtime
- 覆盖候选绑定、独立审查、预算和恢复

验收标准：

- 自动化测试跑通完整 happy path
- Verify fail 能回 Build repairing
- D07-D10、D12 通过

### M2：Skill Runner 与阶段交接

目标：让“人编排 Skill、状态机保证触发”成为可验证能力。

#### M2.1 实现 Skill Resolver

子任务：

- 根据 plan snapshot 按名称解析 Skill
- 支持本地 Skill 入口
- 记录解析失败和版本信息

验收标准：

- 计划中的 Skill 能按数组顺序解析
- 缺失 Skill 会阻止阶段推进
- 自建 Skill 和开源子目录 Skill 都可解析；缺少被引用的本地资源时启动失败

#### M2.2 实现 Skill Invocation

子任务：

- 实现 pending/running/completed/failed 状态
- 记录 execution ref、输入输出和工件
- 防止已完成 Skill 被恢复流程重复执行

验收标准：

- `grill-me` 和 `brainstorming` 能在 Shape 中按顺序触发
- 重启进程后已完成 Skill 不重复触发
- Skill 失败可以重试并留下每次尝试记录

#### M2.3 自行设计并实现 Handoff 与候选绑定

子任务：

- 定义 Shape 确认快照、Builder proposal 与控制器生成的 Handoff
- 实现候选文件摘要、规格版本、独立审查及执行 ID 绑定
- 实现当前候选替换和旧候选历史引用

验收标准：

- Build 只能消费有效 Shape Handoff
- Verify 只能消费当前 candidate 的 Builder Handoff
- 交接引用错误时状态保持不变并返回可诊断错误

#### M2.4 自行实现 Verify 判定与修复循环

子任务：

- 实现宿主机器检查结果与 Verifier 结果的合并守卫
- 实现全量验收、失败集合比较、三次自动修复预算
- 实现规格漂移、候选漂移、过期结果和执行错误的不同恢复路径

验收标准：

- 失败检查不能被 Agent 的 pass 覆盖
- 新候选不继承上轮 passed，修复破坏其他验收项时能检出
- D07-D10 通过真实产物绑定测试，修复进入新 visit 后重跑相应 Skill

### M3：Codex Runtime 端到端闭环

目标：首个可用版本，使用 Codex 跑完整流程。

#### M3.1 实现 CodexRuntimeAdapter

子任务：

- 封装 `codex exec`
- 支持 workspace-write 等显式 sandbox 选项
- 捕获 JSONL 事件
- 获取结构化最终输出
- 绑定 execution ref 和运行目录

验收标准：

- Adapter 可以启动 Codex 并获得最终结果
- 原始事件和最终结果都写入 evidence store
- Codex 退出码、超时和结构化输出错误均能映射为运行状态

#### M3.2 实现 Codex Skill 调用

子任务：

- 将 Skill 名称和当前阶段上下文注入 Codex 调用
- Shape 支持 `grill-me`、`brainstorming` 示例 Skill
- Build 支持无 Skill
- Verify 支持测试 Skill

验收标准：

- 使用示例 Run Plan 能观察到两个 Shape Skill 的实际执行记录
- Build 空 Skill 时 Agent 仍能修改代码
- Verify 产生测试报告并绑定 candidate

#### M3.3 完成首个真实任务

子任务：

- 选择一个小型、可验证的 bugfix 或功能任务
- 执行 Shape、Build、Verify、finalize
- 保存完整审计包

验收标准：

- 一次真实运行进入 `phase: completed, status: done`
- `plan.snapshot`、状态文件、事件、Skill 输出、diff、测试报告和归档报告齐全
- 从中断点恢复后仍能完成，不重复已完成 Skill

#### M3.4 人工门禁、finalize 和真实修复闭环

子任务：

- 提供 answer、confirm-shape、accept-result、request-changes 最小 CLI。
- 以独立 Codex 执行完成 Reviewer 和 Verifier；执行 ID 由控制器生成，不接受 Agent 伪造身份。
- 必需测试由控制器运行并捕获退出码，不把 Builder 自报 passed 当测试依据。
- 绑定候选文件摘要；验证和审批前检查候选未变化。修复后执行最终全量验证。
- finalize 写 verification.md、交付摘要、知识条目与本地工件索引，完成后提交 completed。

验收标准：

- 未确认 Shape 不能进 Build；未确认当前候选不能 completed；旧审批和旧 Verifier 结果被拒绝。
- 人为制造一个测试失败，运行自动返回 Build 修复，重新执行该轮 Skill，最终全量验证通过。
- 同一候选验证后发生文件修改，旧结果失效；不会沿用上轮 passed 直接完成。
- 缺少测试报告或归档写入失败时不能 completed；可恢复后完成本地归档。
- 无需外部 subagent API，通过顺序独立 Codex 调用完成审查和验证；不可用时阻塞，首期不降级自动通过。
- 首个发布包包含可安装 CLI、可执行示例计划、真实成功运行与修复运行的脱敏记录。

### M4：可靠性和人工确认增强

目标：让闭环具备实际使用所需的失败处理和人工门禁。

#### M4.1 实现暂停、恢复和重放

子任务：

- CLI pause/resume
- 基于主状态 history 展示历史动作；不通过日志重新执行代码或工具
- 检查点一致性校验

验收标准：

- Shape、Build、Verify 任一阶段暂停后可恢复
- 历史展示与主状态一致，诊断日志缺失不影响主状态恢复
- 工件哈希不一致时拒绝恢复

#### M4.2 实现人工确认

子任务：

- Shape 确认
- Verify 通过确认
- 最终确认与 finalize 的故障恢复
- reject/request-changes 回退路径

验收标准：

- 未确认不能进入受保护的下一阶段
- request-changes 回 Build；需求变更回 Shape；不允许任意阶段跳转
- 审批人、时间、依据和意见进入审计记录

#### M4.3 故障注入与安全边界

子任务：

- Codex 超时、进程退出、输出损坏
- Skill 缺失、重复、无限 loop
- 工作区越权和敏感日志脱敏

验收标准：

- 每种故障都有确定状态和恢复动作
- 不允许无限重试
- 日志中不出现已配置的敏感值

### M5：可运维 MVP

目标：在完成端到端闭环后，提升可观察性和团队使用效率。

#### M5.1 运行状态查询

子任务：

- status 输出当前阶段、loop、Skill 进度、blocker
- 输出最近事件和下一动作

验收标准：

- 只通过 `status` 就能判断运行是否需要人工介入
- 错误信息包含恢复命令或下一步动作

#### M5.2 审计包导出

子任务：

- 导出状态快照、plan、事件、handoff、报告和工件索引
- 生成 manifest 和哈希

验收标准：

- 导出的审计包可离线校验
- 缺失或篡改文件能被发现

#### M5.3 文档和示例

子任务：

- 编写 Run Plan 示例
- 编写 Skill 接入说明
- 编写失败恢复手册

验收标准：

- 新用户可以按文档运行一个本地示例
- 示例覆盖有 Skill、无 Skill、Verify 失败三种路径

### M6：第二平台适配（后续）

目标：保持工作流、Run Plan 和证据格式不变，接入 Claude Code。

#### M6.1 Runtime capability contract

子任务：核对 Claude Code 的执行、结构化输出、Skill 加载与中断方式，实现第二个 Adapter 和安装诊断。

验收标准：

- Codex 和 Claude Code 都实现相同最小 Adapter 接口
- 平台差异只存在于 Adapter 和配置层

#### M6.2 跨平台契约测试

子任务：复用成功、Skill 缺失、人工问答、Verify 修复、进程中断五类 fixture，分别运行两个 Adapter。

验收标准：

- 同一个 Run Plan 在两个 runtime 上阶段序列一致
- Handoff、验收项和最终状态格式一致
- 平台能力不足时显式 blocked，不静默跳过必需动作

## 11. 首个 MVP 的明确范围

首个 MVP 只承诺：

- 单项目、以一个可实施需求为管理单元、每个工作区串行执行
- Codex runtime
- 本地 Run Plan
- 本地 Skill
- shape/build/verify/completed，归档为 finalize 动作
- Skill 顺序执行
- 必选 Skill 触发保证
- Build 可无 Skill
- CAS、checkpoint、resume、retry
- Builder Handoff、Verifier Envelope 和审计包

首个 MVP 暂不承诺：

- 并行 Skill
- 动态 Skill 规划
- Skill 市场
- 多租户权限中心
- Web UI
- Claude Code 适配
- 跨项目 DAG 编排

## 12. 最终完成定义

当以下命令在 Codex 环境中成功完成，并生成可校验审计包时，首期目标完成：

```bash
phixlin create fix-login --plan examples/codex-full-flow.yaml
phixlin start fix-login
phixlin status fix-login
phixlin resume fix-login
phixlin export-evidence fix-login
```

对应运行必须满足：

1. Shape 中配置的必需 Skill 按顺序实际触发。
2. Build 即使没有 Skill 也能完成代码实现。
3. Verify 能执行检查并绑定当前候选。
4. Verify 实现失败能按预算回到 Build 修复；brief/验收变化能回到 Shape。
5. Verify 通过后可执行人工确认，并由 finalize 完成本地归档。
6. 进程中断后能恢复且不重复已完成 Skill。
7. 最终状态为 `phase: completed, status: done`，所有状态、计划、Skill 输出和验证报告均可审计。
