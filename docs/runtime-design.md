# phixlin-flow 核心运行时设计草案

本文是 phixlin-flow 自有实现的设计起点，不是 Comet 接口的移植说明。`native-workflow-state-machine.md` 仅作思路参考；字段、协议和测试均需在本项目实现。本文优先于路线图中的简化示例，M0 以本文为基础冻结 v1 契约。

## 1. 范围与原则

首期的管理对象是一个可实施编码需求（`change`）。一个 change 有唯一的 change-id、工作区、规格、所选 Workflow Profile 和最终交付结果；一次 Agent 调用是 operation，一次进入某阶段的 loop 是 visit。MVP 不引入 run-id，也不需要兼容此前未实现的接口。控制器使用 Node.js ESM/mjs，Agent 使用 Codex。

确定性指给定主状态和已校验事件，得到唯一下一状态和下一动作；不指模型输出、工具执行结果或重新运行代码具有确定性。主状态之外允许存在日志和产物，但不允许存在第二套可独立推进流程的状态。

## 2. 管理对象与目录

MVP 的管理目录位于目标代码库的变更目录中。change 不拥有独立代码副本，而是引用大型仓库中的 workspace，并保存本需求的 brief、规格、候选和验证证据。

```text
<repository>/.phixlin/changes/<change-id>/
  flow-state.yaml          # 唯一可恢复控制面
  brief.md                 # 用户原始需求与澄清结果
  specs/                   # 本 change 的实现规格
  artifacts/               # 不可变输出、报告、候选快照
  events.jsonl             # 诊断事件，不参与推进
  knowledge.md             # 完成后的知识摘要

<repository>/.phixlin/workflows/
  standard.yaml            # 项目预设工作流
  deep-shape.yaml          # 另一套项目预设工作流
```

`change-id` 由用户创建并可读，贯穿命令、需求文件、状态、审批和归档。项目可以维护多个 Workflow Profile，创建 change 时通过 `--workflow standard` 选择。Profile 定义属于项目，不随 change 复制和编辑；change 状态只保存 workflow 名称、版本、内容摘要及解析后的 planned Skill 快照，使已启动 change 不受项目配置随后修改影响。`workspace.root` 指向目标仓库根目录，change 只记录基线摘要、允许修改范围和实际 diff，不复制整个代码库。

## 3. 单文件状态

`flow-state.yaml` 保存所有控制信息。YAML 用成熟解析器处理，拒绝重复 key；解析后用 JSON Schema 和跨字段不变量双重校验。schema 命名为 `phixlin.flow.v1`，不读取或兼容 Comet 状态文件。未知 schema 拒绝执行，首期不做历史数据迁移。

| 字段 | 类型与职责 |
|---|---|
| schema、change_id、state_version | 协议版本、需求 ID、从 0 开始的提交版本 |
| workspace | 仓库根路径、仓库标识、初始基线摘要、允许修改范围；不隐式清理用户修改 |
| workflow | 项目 Workflow Profile 的名称、版本、摘要和本 change 的解析快照 |
| outer | 外层交付状态机的 phase、status、stage_visit、iteration |
| inner | 当前阶段 Agent loop 的 state、position 和执行绑定 |
| skills | 当前 visit 的 planned 与 contextual Skill 执行记录 |
| budget | visit turn、执行失败、修复和停滞计数与上限 |
| brief | brief.md 摘要、brief_revision、来源和确认记录 |
| shape | 规格引用、spec_revision、验收项快照、测试命令和确认记录 |
| candidate | 当前 Builder Handoff，初始为 null |
| verification | 当前候选的检查及 Verifier 结果，初始为 null |
| interaction | 待回答问题或待批准事项、绑定摘要、恢复动作，初始为 null |
| blocker | 错误码、原因、责任方及允许的恢复动作，初始为 null |
| finalization | 未开始/准备中/已完成、候选绑定及归档文件索引 |
| history | 每次提交的 action_id、版本、动作、原因、旧候选/结果引用与时间 |

状态本身包含恢复所需的计数、绑定和决策。长日志、代码 diff、Skill 输出及候选历史放在 artifacts 中，通过路径、字节数、SHA-256 引用；恢复读取所需产物并校验，缺失时 blocked。单文件状态不意味着单文件包含所有原始产物。

初始值：outer.phase=shape、outer.status=active、stage_visit=1、iteration=0；inner.state=ready、position.turn=0、attempt=0，action=skill（列表为空则 agent-work）。所有失败计数为 0，其余结果为空。stage_visit 每次重新进入工作阶段加 1；iteration 在首次进入 Build 时设为 1，每次修复加 1。重试不增加 stage_visit 或 iteration。

关键不变量：

1. outer.phase=completed 当且仅当 outer.status=done，且有当前候选的通过结果、人工批准和已完成归档。
2. 最多一个当前 Operation；其阶段访问和输入摘要必须与当前动作匹配。
3. planned skills 必须与 workflow 快照的当前阶段数组逐项一致，禁止追加或跳过；contextual skills 不改变 planned 指针和退出守卫。
4. Build 必须有当前规格确认；Verify 必须有当前规格下的候选及独立审查通过记录。
5. verification、最终审批和归档都必须绑定同一 candidate_id、candidate_digest、spec_revision。
6. outer.status 非 active 时不派发新的自动动作；允许核对/收取已经派发的结果。
7. 更新状态与追加 history 必须一次提交；诊断日志写入失败不改变已提交事实。

history 首期不静默截断，受 loop 预算限制；达到主状态大小上限则 blocked。后续另行设计历史压缩，不能删除恢复依据。

## 4. 双层状态机与数据 Schema

以下结构替代本文前文的字段简写。`outer.phase/status` 和 `inner.state/action` 分别持久化；不存在顶层 phase/status，也不再保存第三套 next_action。下一条命令由二者和守卫推导。状态采用组合约束，而不是两个状态机各自独立写盘。

### 4.1 两层的职责

外层回答“需求处于哪个交付阶段、是否允许继续”，只有阶段完成或人工控制事件才能改变它。内层回答“当前阶段工作执行到哪一步、接下来调用谁、是否等待结果”，一次 Agent 回复通常只改变内层。两层通过一个 root reducer 原子组合；内层产生 `stage-ready` 只是请求，外层验证退出守卫后才迁移。Build/Verify 的 LLM 自驱 loop 只能在当前 `brief_revision` 和 `spec_revision` 下推进；识别到需求变化时必须提交 `brief-change-proposed`，不能自行修改已确认 brief 后继续实现。

```text
outer: shape ---------> build <----------> verify ---------> completed
   ^                     ^                   |
   |                     +---- implementation repair
   +-------- brief/spec/acceptance change

每个工作阶段的 inner:
ready -> executing -> evaluating -> ready
                         |           ^
                         +-> waiting-user -- answer
                         +-> stage-ready -- 外层守卫
                         +-> blocked -- recover
执行不确定: executing -> reconciling -> evaluating / blocked
终态: completed 对应 inner=idle
```

`outer.status` 为 active、await-user、paused、blocked、done，是调度门。paused 不抹除 inner 的当前位置；执行完成时仍可以收取结果，恢复之前不能派发下一动作。await-user/blocked 必须分别有 interaction/blocker。inner.state 表示执行生命周期，inner.action 表示当前工作类型，两者不能混用。

### 4.2 v1 类型契约

以下为规范性类型草案，M0 将其转成 `additionalProperties:false` 的 JSON Schema 2020-12；使用 oneOf 为 lifecycle 和结果建立判别联合，再以 root invariants 校验跨字段关系。ArtifactRef 的 path 必须位于 change artifacts 目录，拒绝路径逃逸。所有摘要为 SHA-256 十六进制值。

```ts
type Phase = 'shape' | 'build' | 'verify' | 'completed';
type Gate = 'active' | 'await-user' | 'paused' | 'blocked' | 'done';
type Action = 'skill' | 'agent-work' | 'capture-candidate'
  | 'review-candidate' | 'run-checks' | 'verify-candidate' | 'finalize';
type ArtifactRef = { path: string; sha256: string; bytes: number };
type Binding = {
  change_id: string; stage_visit: number; workflow_digest: string;
  brief_revision: number;
  spec_revision: number | null; candidate_id: string | null;
  input_digest: string;
};
type Operation = {
  operation_id: string; execution_ref: string; binding: Binding;
  action: Action; attempt: number; reserved_at: string;
  process: { pid: number; started_at: string } | null;
};
type LoopPosition = {
  action: Action; skill_index: number | null;
  turn: number; attempt: number;
};
type Lifecycle =
  | { state: 'idle' }
  | { state: 'ready'; position: LoopPosition }
  | { state: 'executing'; position: LoopPosition; operation: Operation }
  | { state: 'reconciling'; position: LoopPosition; operation: Operation }
  | { state: 'evaluating'; position: LoopPosition; operation: Operation;
      result: ArtifactRef }
  | { state: 'waiting-user'; position: LoopPosition; interaction_id: string }
  | { state: 'blocked'; position: LoopPosition; blocker_id: string }
  | { state: 'stage-ready'; position: LoopPosition; evidence: ArtifactRef[] };
type SkillExecutionRecord = {
  invocation_id: string; mode: 'planned' | 'contextual';
  index: number | null; name: string; source_digest: string;
  observation: 'host-observed' | 'model-reported';
  status: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number; input_digest: string | null;
  raw_output: ArtifactRef | null; artifacts: ArtifactRef[];
  workspace_before: string | null; workspace_after: string | null;
  completed_by: string | null;
};
type StageContext = {
  binding: Binding; revision: number;
  planned_completed: string[];
  execution_records: string[];
  stage_artifacts: ArtifactRef[];
};
type ChangeState = {
  schema: 'phixlin.flow.v1'; change_id: string; title: string;
  state_version: number; created_at: string; updated_at: string;
  workspace: { root: string; repository: string; baseline: ArtifactRef;
    allowed_paths: string[] };
  workflow: { name: string; version: number; digest: string;
    stages: Record<'shape'|'build'|'verify',
      {name: string; path: string; digest: string}[]> };
  outer: { phase: Phase; status: Gate; stage_visit: number; iteration: number };
  inner: Lifecycle;
  budget: { turns_used: number; turn_limit: number;
    execution_failures: number; execution_failure_limit: number;
    repairs_used: number; repair_limit: number;
    no_progress: number; no_progress_limit: number };
  skills: SkillExecutionRecord[];
  stage_context: StageContext;
  brief: { revision: number; digest: string; artifact: ArtifactRef;
    confirmed: Approval | null };
  shape: ShapeSnapshot | null;
  candidate: BuilderHandoff | null;
  verification: VerificationSnapshot | null;
  interaction: Interaction | null; blocker: Blocker | null;
  finalization: Finalization;
  history: TransitionRecord[];
};
type Approval = {
  actor: string; action_id: string; subject_digest: string; at: string;
};
type Check = {
  id: string; argv: string[]; cwd: string; timeout_ms: number;
};
type ShapeSnapshot = {
  spec_revision: number; digest: string; documents: ArtifactRef[];
  acceptance: { id: string; text: string; verification: string }[];
  checks: Check[]; approval: Approval | null;
};
type BuilderHandoff = {
  candidate_id: string; spec_revision: number; iteration: number;
  candidate_digest: string; file_manifest: ArtifactRef; diff: ArtifactRef;
  builder_execution_ref: string; summary: string;
  addressed_acceptance_ids: string[]; known_limits: string[];
  review: { execution_ref: string; candidate_digest: string;
    verdict: 'pass'|'fail'; report: ArtifactRef } | null;
};
type VerificationSnapshot = {
  candidate_id: string; candidate_digest: string; spec_revision: number;
  attempt: number; execution_ref: string | null;
  checks: { id: string; result: 'pending'|'pass'|'fail'|'error';
    exit_code: number | null; report: ArtifactRef | null }[];
  acceptance: { id: string; result: 'pending'|'pass'|'fail'; reason: string }[];
  verdict: 'pending'|'pass'|'fail'|'blocked';
  unresolved_ids: string[]; approval: Approval | null;
};
type Interaction = {
  id: string; kind: 'question'|'shape-approval'|'result-approval'|'budget';
  binding: Binding; questions: string[]; answers: string[];
  resume: Lifecycle;
};
type Blocker = {
  id: string; code: string; reason: string; allowed_actions: string[];
  resume: Lifecycle;
};
type Finalization =
  | { state: 'pending' }
  | { state: 'prepared'|'completed'; candidate_id: string;
      candidate_digest: string; artifacts: ArtifactRef[] };
type TransitionRecord = {
  action_id: string; payload_digest: string; action: string;
  from_version: number; to_version: number; at: string;
  before: { phase: Phase; status: Gate; inner_state: Lifecycle['state'] };
  after: { phase: Phase; status: Gate; inner_state: Lifecycle['state'] };
  evidence: ArtifactRef[];
};
```

`Operation` 嵌入 inner 是唯一 in-flight 权威字段，不另设副本。Interaction/Blocker.resume 是恢复位置快照，只允许 ready、reconciling 或 stage-ready。人工批准绑定待批准对象摘要。规格发生改变时增加 spec_revision，保留历史，回 Shape；change-id 不变。项目 Workflow Profile 修改只影响之后启动的 change。已启动 change 如需切换 profile，执行显式 `switch-workflow`，重新解析快照并回 Shape，使旧审批和候选失效。

turn、attempt 是当前动作定位；budget.turns_used 是当前 visit 消耗总量，二者不能替代。操作 ID、时间和 UUID 在事件进入 reducer 前由宿主生成，reducer 内不读时钟、不生成随机值、不访问文件系统。

### 4.3 组合合法性表

| outer.phase | inner.action 合法值 | stage-ready 的外层处理 |
|---|---|---|
| shape | skill、agent-work | 冻结待批准 brief/spec，await-user；确认后进入 Build |
| build | skill、agent-work、capture-candidate、review-candidate | 通过候选/审查/规格守卫后进入 Verify |
| verify | skill、run-checks、verify-candidate、finalize | 验证通过先 await-user；批准后 finalize，归档后 completed；需求变化回 Shape |
| completed | 无，inner 必须 idle | 拒绝继续派发 |

outer.active 可以组合 ready/executing/evaluating/stage-ready；outer.paused 可以保留这些位置及 reconciling。waiting-user 必须组合 await-user（或用户手动 paused）；inner.blocked 必须组合 outer.blocked。reconciling 不允许任何新派发，核对事件后才能恢复。outer.done 只允许 completed/idle。

### 4.4 内层事件与转换

| 事件 | 前置 | 原子变化 |
|---|---|---|
| reserve-operation | active/ready、预算内、无旧执行 | 扣预算、分配 operation，inner=executing |
| execution-result | 匹配 operation 与 binding | inner=evaluating，持久化结果引用 |
| result-continue | evaluating、结果合法 | 写产物，inner=ready，选择同阶段后继 action |
| skill-completed | evaluating/action=skill、输出和工件边界校验通过 | 保存 SkillExecutionRecord；planned 项 completed 并前移指针 |
| contextual-skill-observed | Agent 工作期间由模型触发计划外 Skill | 追加 mode=contextual 的审计记录和工件；恢复原 position，不移动 planned 指针 |
| result-needs-user | evaluating | 保存 interaction，inner=waiting-user、outer=await-user |
| user-answer | 对应 interaction/binding | 保存回答，inner=ready 恢复原 action，outer=active |
| result-stage-ready | evaluating、无未完成 Skill | inner=stage-ready，再由外层守卫消费 |
| brief-change-proposed | build/verify 的 Agent 识别需求变化 | 保存 change proposal，废弃当前候选/验证/审批，outer=shape、inner=ready；等待人工确认新 brief |
| execution-lost | executing | inner=reconciling，停止自动派发 |
| execution-error | 已确认执行结束 | 记录错误；预算内 ready，否则 blocked |
| stage-transition | stage-ready 且外层守卫通过 | outer.phase/visit 改变，重置 inner、skills 与 visit 预算 |

执行事件重复回传按 action_id 去重；不同 action_id 携带已消费 operation 的结果也不允许二次计数。用户回答后继续原 Skill，并不将 Skill 提前标为 completed。人工暂停不消耗 turn，预算增加必须有人工动作；修复计数不会随 visit 重置。

### 4.5 Agent Loop 调度算法

```js
async function driveChange(changeId) {
  // 持有需求执行器锁；每次 mutation 单独持有短状态锁。
  for (;;) {
    const state = await store.read(changeId);
    validateState(state);
    const command = decide(state); // 纯函数，唯一下一动作
    if (command.kind === 'wait' || command.kind === 'done') return command;
    if (command.kind === 'reconcile') return reconcile(state);
    if (command.kind === 'dispatch') {
      const reserved = await reserve(state, command);
      const result = await adapter.execute(makeInput(reserved));
      await collectBoundResult(reserved, result);
    } else {
      // evaluate/advance 都经事件提交，不直接改 YAML；advance 按 position.action 执行业务守卫。
      await applyCommand(state, command);
    }
  }
}
```

makeInput 读取已确认规格、当前 planned Skill 指令、前项 Skill 输出、累计工作摘要、失败反馈及用户回答，不以历史聊天记录为必需输入。执行级结果统一是 `{kind, summary, artifacts, questions?, proposal?, skill_invocations?}`；kind 为 continue、needs-user、stage-ready、blocked。planned Skill 用 stage-ready 表示本次编排动作完成；基础 Agent 工作的 stage-ready 表示阶段就绪请求。无 planned Skill 的 Build 直接从 ready/agent-work 开始。

模型在 agent-work 或 planned Skill 执行内部可以按上下文调用 Workflow Profile 之外的 Skill。此类调用标记为 `contextual`：不要求固定顺序、不要求一定发生、不计入阶段退出条件，也不能修改 workflow 快照。若 runtime 提供可信 Skill 调用事件，Adapter 直接记录；若平台只返回模型声明，则记录为 `reported` 级别，不能冒充宿主确认。contextual Skill 的输出可以进入后续上下文和证据，但其失败默认按普通 Agent turn 处理，不阻断 planned Skill 完成，除非它导致当前 turn 整体失败或产物不满足阶段守卫。

### 4.6 Skill 间确定性交接

MVP 不在每两个业务 Skill 之间增加 LLM normalizer。Harness 用普通代码记录 `SkillExecutionRecord`，保存调用绑定、原始输出、工件引用和 workspace 前后摘要，不解释第三方 Skill 的语义。输出和工件边界校验成功后，planned Skill 即可标记 completed。

```text
planned Skill A
  -> 保存 raw output、artifact refs、workspace digest
  -> 原子提交 SkillExecutionRecord
  -> 组装 Skill B 输入
  -> planned Skill B
  -> 阶段 Agent 汇总并生成阶段 Handoff
```

后续 Skill 的输入由确定性规则组装：包含当前 brief/spec、阶段目标、直接前驱的完整 raw output、此前执行记录和全部工件引用、当前 workspace diff，以及当前 Skill 的 SKILL.md。此前完整输出不重复注入；需要细节时由 Agent 按 artifact 引用读取。Harness 不从原始文本猜测 findings、decisions、constraints 或 conflicts，也不静默改写第三方 Skill 的结论。

业务语义在阶段边界收口：Shape Agent 生成 Shape Handoff，Build Agent 生成 Builder Handoff，Verifier 生成 Verification Result。这些输出本就是阶段完成条件，可由对应 Schema 和守卫校验，不需要为每个 Skill 再调用一个模型。

contextual Skill 使用同一种执行记录。host-observed 表示 runtime 提供了可信调用事件；model-reported 只表示 Agent 声明调用过，不作为 planned 完成证据。contextual 输出可以进入后续输入和阶段 Handoff，但不移动 planned 指针。将来只有真实第三方 Skill 无法通过原始输出和工件引用交接时，才为该 Skill 增加显式 adapter；MVP 不预建通用 adapter 或相关配置。

模型内部工具循环属于 Codex adapter，Harness 不把每次读文件变成状态提交。Harness 的一个 turn 是一次有绑定输入和可验证输出的宿主调用；不同 turn 可创建新会话。Builder/Reviewer/Verifier 的会话和执行引用分离，阶段交接靠冻结工件。

## 5. CAS 与提交协议

公开写入口为 `mutate(changeId, {expectedVersion, actionId, action, payload})`。所有 CLI、Runner 回调都经过此入口，Agent 不能直接提交持久化结构。

首期在 Linux 本地文件系统采用内核 advisory lock（通过经验证的锁封装），所有写入方遵守同一锁。锁文件是固定 inode，不用删除锁文件来解锁；进程退出由内核释放锁。平台不支持时明确拒绝该运行模式，不能退化成仅比较版本。具体 Node 封装在 M0 spike 中确定。

提交步骤：

1. 获取每个 change 的短时独占锁；超时返回 LOCK_BUSY，不修改状态。
2. 读取、解析并校验 flow-state.yaml；初始创建也在同一锁内完成。
3. 若 actionId 已提交且载荷摘要相同，返回已提交回执；同 ID 不同载荷报 ACTION_CONFLICT。
4. 检查 expectedVersion 和当前允许动作；不匹配返回 VERSION_CONFLICT 或 INVALID_ACTION。
5. 运行纯函数 reduce(state, event)，校验所有不变量，将版本加 1 并追加 history。
6. 在同目录唯一临时文件写完整新状态，fsync 文件，原子 rename 替换主文件，再 fsync 父目录。
7. 释放锁，返回版本与下一动作。外部 Agent/测试绝不在持锁期间执行。

可恢复错误：rename 前退出仍读旧状态；rename 后响应丢失时按 actionId 查询并去重。目录同步失败属于提交结果不确定，重新读主状态核对，不能直接重复动作。解析失败不自动回退旧备份，以免重复副作用。临时文件不能被恢复逻辑当成正式状态。

状态锁只保护提交；另设每个 change 的执行器锁，确保同一时刻只有一个调度进程。执行器退出不代表其子进程已终止：恢复前必须处理 in_flight，禁止直接再派发写代码动作。

## 6. 外部执行与中断恢复

采用 reserve -> dispatch -> collect -> commit 四步：

1. reserve：主状态写入 operation_id、宿主分配的 execution_ref、输入摘要、visit/candidate 绑定及 running 状态。
2. dispatch：将保留动作传给 Adapter，持久化事件和最终结果。Agent 返回正文，不能指定可信身份。
3. collect：控制器检查退出码、结构化结果、工件摘要和输入绑定。
4. commit：以独立 actionId 提交完成。并发 pause 改变了版本时重新读取状态，在仍匹配同一 operation 的前提下收取结果；paused 保持暂停，不自动推进。

| 中断窗口 | 恢复动作 |
|---|---|
| reserve 前 | 没有动作，可正常派发 |
| reserve 后、是否派发未知 | 查进程与执行产物，无法确认则 blocked，不盲目重试 |
| 工具仍在运行 | 附着观察或请求终止并确认退出，禁止启动第二个写入执行 |
| 结果已落盘、状态未提交 | 校验结果与当前 operation 后补交完成 |
| 完成已提交、回执丢失 | actionId 去重，不重复执行 |

暂停阻止后续派发，可请求停止当前进程；只有确认进程停止或完成后才报告静止。超时不等于工具没有副作用，必须先收敛子进程。对未知执行，人工可选择核对后采用结果或重新执行，决定写入 history。不承诺 exactly-once 外部副作用。

## 7. 阶段内业务动作

下面描述业务动作的顺序；执行生命周期按第 4 节内层状态机推进。next_action 是 decide(state) 的推导输出，不是替代 inner.state 的持久化字段。

| 当前条件 | 动作 | 守卫与结果 |
|---|---|---|
| 当前 visit 有待执行 planned Skill | run-skill | 按数组位置派发；完成后进入下一项，全部完成后 agent-work |
| shape、Skill 完成 | agent-work | 整理规格及验收项，stage-ready 后等待 confirm-shape |
| shape、等待确认 | confirm-shape | 人工绑定规格摘要；冻结验收项，进入 Build 新 visit |
| build、Skill 完成 | agent-work | 实现或修复；准备好后 capture-candidate |
| build、候选已捕获 | review-candidate | 独立只读执行审查，通过才允许 submit-candidate |
| build、审查通过 | submit-candidate | 校验候选没变、规格未漂移，进入 Verify 新 visit |
| verify、Skill 完成 | run-checks | 按冻结测试命令运行，绑定当前候选 |
| verify、检查完成 | verify-candidate | 独立判定，必须覆盖全部验收 ID；失败进入修复分支 |
| verify、全部通过 | accept-result | 等待人工批准当前候选，批准后 finalize |
| verify、已批准 | finalize | 本地归档完成后进入 completed |

任何 phase 的 needs-user 保存问题及原动作，回答只恢复原动作，不代替阶段审批。continue 不重复已完成 planned Skill，持续约束 Skill 内容继续附在阶段上下文中。Skill 的“调用完成”与阶段完成独立；TDD 等规则最终还需检查实现证据。contextual Skill 不改变 planned 顺序。

审查失败留在 Build，候选和旧审查失效，回 agent-work，不重新执行同 visit 已完成 Skill；它消耗阶段 turn 预算。规格摘要改变则回 Shape 新 visit，废弃当前审批、候选和验证的有效性，旧引用保留到 history。

预算默认：每阶段 visit 最多 20 个自动 Agent turn；同一逻辑操作连续基础设施失败 3 次则 blocked；最多 3 次自动 Verify -> Build 修复；连续 3 次失败判定无进展则 await-user。自动 turn 在派发前计数，等待用户不计数。一次成功执行清零对应执行失败数；普通 resume 不清零预算。人工续跑必须写明新增预算及原因。

## 8. Builder Handoff 与候选绑定

Builder 只提交 proposal：summary、addressed_acceptance_ids、开发检查声明、known_limits。控制器生成持久化 Handoff：

```text
candidate_id, spec_revision, iteration,
candidate_digest, file_manifest_ref, diff_ref,
builder_execution_ref, summary, addressed_acceptance_ids,
developer_checks, known_limits,
review {execution_ref, candidate_digest, verdict, report_ref}, submitted_at
```

候选摘要基于明确文件清单的路径、类型、权限和字节摘要，包含基线中已有修改、新增未跟踪文件和删除项；不只使用 HEAD commit。排除的构建缓存/日志清单在 Shape 确认，不能在验证时临时排除失败文件。运行目录放在代码工作区之外，不进入候选摘要。

首期使用受控工作区，在候选捕获、审查前后、机器验证前后、最终批准和 finalize 前重新校验摘要。不能保证外部编辑器完全不修改文件；发现漂移即使测试通过也作废。后续可引入只读候选快照强化隔离。

审查执行 ID 由控制器创建且与 Builder 不同，必须绑定同一候选；仅不同字符串不构成独立执行证明，需要宿主派发记录。Build 无 Skill 时仍走基础实现和审查协议。旧 candidate 完整副本持久化为不可变产物，history 引用它，主状态只保留当前 candidate。

## 9. Verify 判定与修复循环

规格确认时冻结 brief_revision、acceptance 数组（唯一 ID、描述、验证方式）以及必需检查命令（argv、cwd、timeout）。Build/Verify 发现实现问题应在当前 revision 自驱修复；发现目标、范围、验收标准或关键约束变化时，必须提交 brief-change-proposed 回 Shape。命令用 spawn 参数数组执行，不通过拼接 shell；需要 shell 的项目命令显式声明。测试退出码和报告由控制器采集，Builder 声明仅供参考。

Verifier 返回 verdict、各验收项结果和理由、报告引用。控制器补全并校验 operation_id、execution_ref、candidate_id、candidate_digest、spec_revision、iteration 和 verify_attempt。Verifier 与 Builder/Reviewer 使用独立执行；首期不声称有外部数字签名认证。

pass 必须同时满足：必需检查全部成功、验收项完整且无重复/未知 ID、每项 passed、候选未改变、结构化结果有效。测试失败直接进入失败处理，Agent 的 pass 不能覆盖非零退出码；命令启动失败、超时或结果损坏属于执行错误，不算代码验证失败。

修复规则：

1. 记录本轮失败验收 ID 及失败检查 ID，构成 unresolved 集合。
2. 与上一失败集合比较：只有严格真子集才算进展，否则 no_progress +1；有进展归零。第一次失败没有比较基线。
3. 若已有 3 次自动修复或 no_progress 达 3，停在 Verify/await-user，保存失败依据；否则进入 Build，iteration 与 visit 各加 1。
4. Build 获得失败报告、上轮 Handoff 和原规格，修复后创建全新候选并重新审查；不能复用旧审查。
5. 新候选进入 Verify 新 visit，重新触发 Verify Skill。首期每轮全量验证并把当前验收结果全部置为 pending，不继承旧候选 passed，不引入局部 recovery 模式。

Verify 回 Shape 规则：

1. Agent、Verifier 或人工确认指出 brief、目标、范围、约束或 acceptance 需要改变时，提交 `brief-change-proposed`，附原因、受影响验收项和建议修改。
2. 控制器废弃当前 candidate、review、verification 和 result approval 的有效性，但保留为历史证据；workspace 修改不自动回滚。
3. Shape 重新编辑 `brief.md`，递增 `brief_revision`；规格与验收项重新生成并由人工确认。
4. 确认后进入新的 Build visit；Build/Verify Skill 按新 revision 重新执行。旧候选只能作为参考。
5. 如果只是测试失败、代码缺陷或实现偏差，保持 brief_revision/spec_revision 不变，走 Verify -> Build repairing，不回 Shape。

例如 A1/A2 首轮失败 -> 自动修复 1 -> 仅 A2 失败（有进展）-> 自动修复 2 -> 全量通过 -> 人工确认 -> finalize。若连续四个候选都失败，最多派发三次自动修复，此后等待用户，不产生第五个候选。

## 10. 完成与错误分类

finalize 先在主状态保留归档 operation，再按候选绑定生成本地 verification.md、交付摘要、知识条目和文件索引，校验后提交 completed。部分文件写入失败时 blocked；同候选重试核对已有文件摘要，避免重复知识条目。审批后代码或规格改变则审批失效，禁止 finalize。

| 错误码 | 行为 |
|---|---|
| VERSION_CONFLICT / LOCK_BUSY | 调用方刷新或稍后重试，不产生副作用 |
| INVALID_STATE / UNSUPPORTED_SCHEMA | 停止执行，保留原文件供诊断 |
| PLANNED_SKILL_MISSING / RESOURCE_DRIFT | blocked，修复项目 workflow 或显式切换 workflow |
| SPEC_DRIFT | 回 Shape，重新确认 |
| CANDIDATE_DRIFT | 作废当前验证/审批，回 Build 捕获新候选 |
| EXECUTION_UNKNOWN | blocked，核对外部结果，不自动重做 |
| EXECUTION_FAILED | 确认旧执行终止后按预算重试 |
| VERIFICATION_FAILED | 按修复预算回 Build 或等待用户 |
| STALE_RESULT | 拒绝过期结果，不覆盖当前候选 |
| ARTIFACT_MISSING / FINALIZE_FAILED | blocked，补齐或恢复后继续 |

## 11. 设计冻结与实现验收

M0 必须产出可解析的完整初始/Build/Verify/Completed 状态 fixture、Schema、动作表和 reducer 测试向量；本文表格不能代替这些机器可验证契约。M1 至 M3 按以下场景落实：

| 编号 | 验收场景 | 预期 |
|---|---|---|
| D01 | 同版本两次并发写 | 只有一次提交，版本恰加 1 |
| D02 | 相同 actionId 重交及载荷冲突 | 相同载荷返回原回执，不同载荷拒绝 |
| D03 | 写文件、rename、回执前分别 kill | 主状态始终是完整旧版或新版，恢复不猜测副作用 |
| D04 | reserve 后 kill、工具执行中 kill | 不启动第二个未知写入操作 |
| D05 | 少执行一个 Skill 或重用旧 visit 结果 | 不能退出阶段 |
| D05a | 模型调用计划外 Skill | 记录 contextual 调用，planned 顺序和退出守卫不变 |
| D06 | Build 空 Skill | 仍执行实现、独立审查、提交候选 |
| D07 | 老候选报告、伪造身份、缺验收 ID | 全部拒绝 |
| D08 | 四轮候选连续失败 | 三次自动修复后等待人工 |
| D09 | 修复 A2 却破坏原通过 A1 | 全量验证发现回归，不完成 |
| D10 | 修改规格或已批准候选 | 旧审批失效，分别回 Shape/Build |
| D11 | pause 与执行完成并发 | 结果可以收取，后续动作不自动派发 |
| D12 | 归档写一半失败再恢复 | 不提前 completed，不重复知识条目 |

M0 尚需通过试验确认：锁封装及 fsync 行为、工作区摘要排除规则、Codex 控制目录隔离。若试验不支持，先修订本文和测试向量再实现，不能以参考文档“已有此能力”为理由跳过验证。
