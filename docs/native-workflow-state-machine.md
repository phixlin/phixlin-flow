# Native 工作流状态机架构（v4）

> 本文档分析 Comet Native 工作流在 Claude Code 平台的流转逻辑，聚焦 Shape、Build、Verify、Archive 四个阶段的状态机设计、状态文件结构和实现思想。

---

## 一、整体架构

当前版本只有一个状态机：**v4 Portable 状态机**（`comet.native.v4`）。

所有状态收敛到 `comet-state.yaml` 一个文件中，不再依赖 Transition Journal、Evidence 文件、Checkpoint 等外部存储。

```
┌─────────────────────────────────────────────────────────┐
│                    comet-state.yaml                      │
│  (schema: comet.native.v4, 单文件承载全部工作流状态)      │
│                                                         │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ │
│  │phase │ │status│ │loop  │ │accept│ │block │ │history│ │
│  │外层  │ │状态  │ │内层  │ │验收项│ │阻塞  │ │循环  │ │
│  │阶段  │ │      │ │循环  │ │追踪  │ │管理  │ │历史  │ │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ │
└─────────────────────────────────────────────────────────┘
```

**关键文件**：

| 文件 | 路径 | 用途 | 写入方式 |
|---|---|---|---|
| `comet-state.yaml` | `<change-dir>/` | 主状态文件 | CAS（Compare-And-Swap），`state_version` 乐观锁 |
| `state.json` | `<runtime-dir>/` | 本地执行状态 | 原子写入 |
| `verification.md` | `<change-dir>/` | 验收报告 | 写入后不可变 |
| `brief.md` | `<change-dir>/` | 需求简述 | 编辑 |
| `specs/` | `<change-dir>/specs/` | 能力规格目录 | 编辑 |

---

## 二、状态数据结构

```typescript
interface NativePortableState {
  schema: 'comet.native.v4';
  name: string;
  language: 'en' | 'zh-CN';
  phase: 'shape' | 'build' | 'verify' | 'archive';   // 外层阶段
  status: 'active' | 'await-user' | 'blocked' | 'done'; // 整体状态
  state_version: number;           // 乐观锁，每次推进 +1
  brief: 'brief.md';
  spec_changes: NativePortableSpecChange[];
  workspace: NativePortableWorkspace;  // 工作区绑定
  loop: NativePortableLoopState;       // ⭐ 内层循环状态机
  acceptance: NativePortableAcceptanceState[];  // ⭐ 验收项追踪
  builder_handoff: NativeBuilderHandoff | null; // ⭐ Builder→Verifier 交接
  blockers: NativePortableBlockerState[];       // ⭐ 阻塞管理
  verification: NativePortableVerificationState | null; // ⭐ 验收结果
  history: NativePortableHistoryEntry[];        // ⭐ 循环历史
  history_overflow: NativePortableHistoryOverflow;
  verification_result: 'pending' | 'pass' | 'fail' | 'blocked';
  verification_report: 'verification.md' | null;
  archived: boolean;
  created_at: string;
}
```

### CAS 写入机制

```typescript
// native-portable-state.ts | compareAndSwapNativePortableState()
//
// 1. 验证 next.state_version === expected + 1
// 2. 读取当前文件，比较 state_version
// 3. 匹配则写入，否则抛 NativePortableStateVersionConflictError
// 4. beforeCommit 钩子最后一次验证
```

解决多 Agent、多会话并发推进同一个 change 时的冲突问题。

---

## 三、四阶段流转总览

```
                    ┌──────────┐
                    │  Shape   │ 需求澄清
                    │  phase   │
                    └────┬─────┘
                         │ confirm acceptance
                         ▼
                    ┌──────────┐
              ┌─────│  Build   │ 实现 ←────────────┐
              │     │  phase   │                    │
              │     └────┬─────┘                    │
              │          │ submit candidate         │
              │          ▼                          │
              │     ┌──────────┐                    │
              │     │  Verify  │ 验收                │
              │     │  phase   │── fail ── return ──┘
              │     └────┬─────┘
              │          │ pass
              │          ▼
              │     ┌──────────┐
              │     │ Archive  │ 归档
              │     │  phase   │
              │     └────┬─────┘
              │          │
              │          ▼
              │     ┌──────────┐
              └─────│   Done   │
                    └──────────┘
```

---

## 四、Shape——需求澄清

### Loop 合法状态

`shape` → `await-user` → `blocked`

### 初始状态

```yaml
phase: shape
status: active
loop:
  stage: shape
  iteration: 0
  attempt: 0
  retry_epoch: 0
  failed_iteration_count: 0
  no_progress_count: 0
  execution_failure_count: 0
  previous_unresolved_ids: []
  next_action: confirm-shape
acceptance: []
builder_handoff: null
blockers: []
verification: null
verification_result: pending
```

### 推进条件（Shape → Build）

**触发命令**：

```bash
comet native next <change-name> \
  --summary "<summary>" \
  --confirmed \
  --expected-state-version <n> \
  --expected-action confirm-shape
```

**状态文件依据**（`comet-state.yaml`）：

| 字段 | 要求 | 说明 |
|---|---|---|
| `phase` | `shape` | 必须处于 Shape 阶段 |
| `status` | `active` | 不能已阻塞或等待用户 |
| `loop.stage` | `shape` | 内层循环必须在 Shape 阶段 |
| `loop.next_action` | `confirm-shape` | 下一步动作必须是确认 Shape |
| `state_version` | `n` | 必须匹配 `--expected-state-version` |

**磁盘证据**：

| 证据 | 来源 | 用途 |
|---|---|---|
| `brief.md` | `<change-dir>/brief.md` | 读取需求简述，提取验收项 |
| `specs/<capability>/spec.md` | `<change-dir>/specs/*/spec.md` | 读取能力规格，提取验收项 |
| 验收项列表 | 从 brief + specs 自动提取 | `readNativePortableAcceptance()` 解析 |
| Spec 变更声明 | 文件系统扫描 | `discoverNativePortableSpecChanges()` 检测 specs/ 目录下的新增/修改/删除 |
| 验收项漂移检测 | 对比当前状态 | `inspectNativePortableAcceptanceDrift()` 校验 specs 和验收项是否与上次确认时一致 |

**状态文件变更**：

```yaml
phase: build                    # 从 shape → build
loop:
  stage: building               # 从 shape → building
  iteration: 1                  # 从 0 → 1
  attempt: 0
  next_action: submit-builder-candidate
acceptance:                     # 填入从 brief+specs 提取的验收项
  - id: A1
    source: brief.md
    text: "..."
    result: pending
    reason: null
  - id: A2
    source: specs/foo/spec.md
    text: "..."
    result: pending
    reason: null
state_version: previous + 1     # 乐观锁递增
```

**实现思想**：Shape 确认不是简单的"用户说可以了"，而是**契约锁定**——把 brief 和 specs 中的所有验收项冻结为一份不可变的验收清单，后续所有 Build 和 Verify 都以此为准。验收项漂移检测确保 specs 修改后必须重新确认 Shape。

**核心函数**——`confirmNativePortableAcceptance()`（`native-loop-runtime.ts`）：

```typescript
// 守卫：phase === 'shape' && status === 'active'
// 守卫：acceptance 不能为空，ID 不能重复
//
// 输出新状态：
//   phase → 'build'
//   loop.stage → 'building', iteration → 1, attempt → 0
//   next_action → 'submit-builder-candidate'
//   acceptance 全部设为 result: 'pending'
```

**决策树 + 最小化用户打断**。能自动确定的就不问用户，只把"会改变用户可见结果且无法可靠推断的决定"交给用户。

---

## 五、Build——实现

### Loop 合法状态

`building` | `repairing` | `await-user` | `blocked`

| 场景 | Loop Stage |
|---|---|
| 首次进入 | `building` |
| 从 Verify 返回修复 | `repairing` |

### 状态转换图

```
building ──submit-candidate──→ verify (verify-ready)
    ↑
    │  [Verify 失败]
    └────────── return-to-build ─────┘
    ↑
repairing (从 Verify 返回修复)
    ├── iteration +1
    ├── attempt → 0
    └── next_action → 'submit-builder-candidate'
```

### 推进条件（Build → Verify）

**触发命令**：

```bash
comet native next <change-name> --runner-input <temporary-json-file>
```

JSON 文件内容（`RunnerBuilderInput`）：

```json
{
  "kind": "builder-handoff",
  "summary": "实现了用户登录功能",
  "addressed_acceptance_ids": ["A1", "A2", "A3"],
  "checks": [
    { "name": "TypeScript 编译", "result": "passed", "note": null },
    { "name": "单元测试", "result": "passed", "note": "全部 42 个测试通过" }
  ],
  "known_limits": ["尚未测试 Edge 浏览器"],
  "review": {
    "status": "passed",
    "summary": "代码审查通过，逻辑正确",
    "reviewer_execution_ref": "agent-xyz-789"  // 必须与 Builder 的 execution_ref 不同
  }
}
```

**状态文件依据**（`comet-state.yaml`）：

| 字段 | 要求 | 说明 |
|---|---|---|
| `phase` | `build` | 必须处于 Build 阶段 |
| `status` | `active` | 不能已阻塞或等待用户 |
| `loop.stage` | `building` 或 `repairing` | 首次或修复 |
| `loop.next_action` | `submit-builder-candidate` | 下一步必须是提交候选 |

**磁盘证据**：

| 证据 | 来源 | 用途 |
|---|---|---|
| Builder 身份 | Runner 通道 | `identity_provider` 和 `execution_ref` 必须来自可信通道 |
| 独立 Review 签名 | JSON 输入 | `reviewer_execution_ref !== builder_execution_ref` |
| 验收项漂移检测 | `ensureNativePortableAcceptanceCurrentLocked()` | 如果 specs 已变更，自动回退到 Shape |

**状态文件变更**：`phase` → `verify`，`loop.stage` → `verify-ready`，`loop.next_action` → `run-required-checks-and-dispatch-verifier`，`builder_handoff` 写入交接包（含 `candidate_id`、`checks`、`review` 等），`blockers` 清空，`verification_result` → `pending`，`state_version` +1。完整 YAML 结构见 Handoff 章节示例。

### 推进条件（Verify → Build，返回修复）

**触发命令**：

```bash
comet native next <change-name> \
  --summary "<summary>" \
  --revise-implementation \
  --expected-state-version <n> \
  --expected-action revise-implementation
```

**状态文件依据**：

| 字段 | 要求 |
|---|---|
| `phase` | `verify` |
| `status` | `await-user` |
| `loop.next_action` | `await-user`（预算超限）或 `resolve-verifier-blocker` 等 |

**转换条件**：

- Verifier 返回 `verdict: 'fail'`
- `failed_iteration_count < maxVerifyFailures`（预算未超限）
- `no_progress_count < 3`（未停滞）
- 或用户主动选择 `revise-implementation`

**状态文件变更**：`phase` → `build`，`loop.stage` → `repairing`，`iteration` +1，`attempt` → 0，`failed_iteration_count` +1，`no_progress_count` 按停滞检测更新，`previous_unresolved_ids` 记录未通过 ID，`next_action` → `submit-builder-candidate`。`acceptance` 中只重置 unresolved 项为 pending（已 passed 的保留），`builder_handoff` 保留前一次以供诊断，`state_version` +1。

---

## 六、Builder Handoff——Builder→Verifier 交接协议

### 设计思想

**Builder 不提交"代码"，而是提交"候选+证据包"**。这是 Handoff 机制的核心设计思想。

传统工作流中，Builder 完成实现后直接进入验收，验收方需要重新理解 Builder 做了什么、为什么这么做、还有哪些已知问题。Handoff 模式将这一过程结构化：Builder 提交的不仅是一个实现，而是一个完整的**候选证据包**，包含：

| 要素 | 说明 |
|------|------|
| **候选摘要** | Builder 本轮做了什么、实现了哪些验收项 |
| **开发期检查** | 运行时检查、Lint、类型检查等结果 |
| **已知限制** | 当前候选的已知问题或未覆盖场景 |
| **独立 Review** | 第三方的只读审查结论，证明实现经过了独立审核 |

**解耦 Builder 与 Verifier**：Handoff 让 Builder 和 Verifier 不需要共享上下文。Verifier 只需要读取 `builder_handoff` + `acceptance` + `brief/specs` 即可独立做出验收判断，不依赖与 Builder 的对话历史。

**审计追踪**：每个 Handoff 包含 `candidate_id`、`iteration`、`builder_execution_ref`、`submitted_at`，形成完整的候选链。即使归档后，Handoff 记录仍然保留在状态文件中，可追溯每个候选的完整信息。

### 数据结构与 Schema

```typescript
// native-portable-types.ts | NativeBuilderHandoff
interface NativeBuilderHandoff {
  candidate_id: string;               // 候选唯一标识(UUID)，每个候选全局唯一
  identity_provider: string;          // 身份提供者 ('skill-coordinated' | 'host-attested')
  builder_execution_ref: string;      // Builder 执行引用，关联到 Runner 通道
  iteration: number;                  // 当前迭代号，与 loop.iteration 一致
  summary: NativePortableText;        // 交接摘要：Builder 本轮做了什么
  addressed_acceptance_ids: string[]; // 本轮处理的验收项 ID 列表
  checks: NativeBuilderCheckSummary[]; // 开发期检查结果摘要
  checks_truncated: boolean;          // 检查结果是否被截断
  known_limits: NativePortableText[];  // 已知限制与未覆盖场景
  known_limits_truncated: boolean;     // 已知限制是否被截断
  review: {                           // 独立的只读代码审查结论
    status: 'passed';                 // 审查必须通过
    summary: NativePortableText;      // 审查摘要
    reviewer_execution_ref: string;   // 审查者执行引用，必须与 builder 不同
  } | null;
  submitted_at: string;               // 提交时间戳
}

interface NativeBuilderCheckSummary {
  name: NativePortableText;           // 检查名称
  result: 'passed' | 'failed' | 'not-run';  // 检查结果
  note: NativePortableText | null;    // 额外说明
}
```

**RunnerInput 关系**：`NativeBuilderHandoff` 是持久化到 `comet-state.yaml` 的内部格式，比 Agent 提交的 `RunnerBuilderInput`（见 Build 章节 JSON 示例）多出 `candidate_id`、`identity_provider`、`builder_execution_ref`、`iteration` 等由 Runtime 自动填充的字段。

### 实现方式

#### 创建流程

`submitNativeBuilderCandidate()`（`native-loop-runtime.ts:123`）是 Handoff 的创建入口：

```typescript
export function submitNativeBuilderCandidate(options: {
  state: NativePortableState;
  input: NativeBuilderCandidateInput;
}): NativePortableState {
```

**前置校验**：

1. **阶段守卫**：当前 `phase` 必须是 `build`，`status` 必须是 `active`
2. **身份验证**：`identity` 必须来自可信的 Runner 通道（`isNativeTrustedExecutionIdentity()`）
3. **独立 Review 验证**：必须包含 `review.status === 'passed'` 的审查结论
4. **执行引用隔离**：`reviewerExecutionRef !== identity.executionRef`——强制 Builder 和 Reviewer 不能是同一执行实体
5. **修复模式守卫**：在 `repairing` 阶段重新提交时，Review 必须是全新的（`reviewer_execution_ref` 不能与上一轮相同）

**验收项处理**：

```typescript
const addressed = uniqueKnownIds(
  input.addressedAcceptanceIds,
  state.acceptance,
  'Native Builder addressed acceptance',
);
```

- `addressed_acceptance_ids` 必须是已知的验收项 ID，不能包含重复
- 在 `repairing` 模式下，只有 `repairScope` 内的验收项被重置为 `pending`，其他验收项保持原有结果
- 在首次 `building` 模式下，所有验收项重置为 `pending`

**状态转换**：

```typescript
return parseNativePortableState({
  ...state,
  phase: 'verify',                  // Build → Verify
  state_version: nextVersion(state), // 乐观锁 +1
  verification_result: 'pending',    // 等待 Verifier 判定
  builder_handoff: { ... },          // 持久化 Handoff
  loop: {
    ...state.loop,
    stage: 'verify-ready',           // 内层循环进入 verify-ready
    attempt: 0,                      // 新候选重置尝试次数
    execution_failure_count: 0,      // 重置执行失败计数
    next_action: 'run-required-checks-and-dispatch-verifier',
  },
});
```

#### 外层 Runtime 包装

`submitNativePortableBuilderCandidate()`（`native-portable-runtime.ts:626`）在 `submitNativeBuilderCandidate()` 之上增加了：

1. **Mutation Lock**：`withNativeMutationLock()` 确保并发安全
2. **Acceptance 新鲜度**：`ensureNativePortableAcceptanceCurrentLocked()` 检查验收项是否与最新 Spec 一致
3. **Supervisor 检查**：如果是父级 change，检查所有子 change 是否已完成
4. **CAS 写入**：`writePortableMutation()` 通过 Compare-And-Swap 原子写入状态文件
5. **本地执行状态**：`writeNativeLocalExecution()` 更新本地执行状态

#### 持久化与验证

**写入**：Handoff 作为 `comet-state.yaml` 的 `builder_handoff` 字段持久化：

```yaml
schema: comet.native.v4
phase: verify
state_version: 7
builder_handoff:
  candidate_id: "a1b2c3d4-..."
  identity_provider: "skill-coordinated"
  builder_execution_ref: "exec_abc123"
  iteration: 3
  summary:
    text: "实现了用户认证模块的登录和注册功能"
    truncated: false
  addressed_acceptance_ids:
    - "auth-001"
    - "auth-002"
  checks:
    - name: "类型检查"
      result: "passed"
      note: null
    - name: "Lint"
      result: "passed"
      note: null
  checks_truncated: false
  known_limits:
    - text: "未处理 OAuth 第三方登录"
      truncated: false
  known_limits_truncated: false
  review:
    status: "passed"
    summary:
      text: "独立审查通过，实现覆盖了所有验收项"
      truncated: false
    reviewer_execution_ref: "exec_def456"
  submitted_at: "2026-09-04T10:30:00.000Z"
```

**读取解析**：`parseBuilderHandoff()`（`native-portable-state.ts:321`）对每个字段进行严格的类型验证：

- `rejectUnknown()` 拒绝未知字段，防止状态文件损坏
- `assertUnique()` 确保 `addressed_acceptance_ids` 无重复
- `integerValue()` 校验 `iteration >= 1`
- `timestamp()` 校验 `submitted_at` 格式

**交叉引用验证**：`assertReferences()`（`native-portable-state.ts:591`）在每次 CAS 写入时执行：

1. **验收项引用**：`addressed_acceptance_ids` 必须全部存在于 `acceptance` 数组中
2. **迭代一致性**：`builder_handoff.iteration` 必须等于 `loop.iteration`（或在修复模式下等于 `loop.iteration - 1`）
3. **执行引用隔离**：`review.reviewer_execution_ref !== builder_execution_ref`
4. **Verification 绑定**：如果 `verification` 存在，其 `candidate_id` 必须与 `builder_handoff.candidate_id` 一致，且 `identity_provider` 必须匹配

**Handoff 在被新候选覆盖前一直保留在状态文件中**，即使归档后 `comet-state.yaml` 仍保留最后一个 Handoff 记录。

### 与 Verifier Envelope 的绑定

`applyNativeVerifierEnvelope()`（`native-loop-runtime.ts:258`）将 Handoff 与 Verifier 结果绑定在一起：

```typescript
const response = validateNativeTrustedVerifierEnvelope({
  envelope: options.envelope,
  binding: {
    candidateId: state.builder_handoff.candidate_id,     // 绑定候选 ID
    identityProvider: state.builder_handoff.identity_provider, // 身份一致
    builderExecutionRef: state.builder_handoff.builder_execution_ref, // Builder 引用
    iteration: state.loop.iteration,     // 迭代一致
    attempt: state.loop.attempt,         // 尝试次数
    acceptanceIds: scopeIds,             // 验收项范围
    requiredChecksPassed: ...,           // 检查是否全部通过
  },
});
```

**绑定验证**：

| 检查项 | 说明 |
|--------|------|
| `candidate_id` | Verifier 结果必须绑定到当前 Handoff 的候选 ID |
| `identity_provider` | Builder 和 Verifier 的身份提供者必须一致 |
| `builder_execution_ref` | Builder 执行引用，用于审计链 |
| `iteration + attempt` | 确保 Verifier 结果对应正确的候选轮次和尝试次数 |
| `acceptanceIds` | Verifier 必须覆盖所有待验收项 |
| `requiredChecksPassed` | 所有必须的检查通过后才能进入 Verifier 判定 |

### Runner 通道与身份模型

Handoff 的身份验证通过 `NativeRunnerChannel`（`native-runner-protocol.ts`）实现：

```typescript
export function createNativeRunnerChannel(): NativeRunnerChannel {
  // 只能创建 Skill-Coordinated 身份
  captureExecutionIdentity(input): NativeTrustedExecutionIdentity {
    // 强制 identityProvider = 'skill-coordinated'
    // 返回带 Symbol 标记的可信身份
  }
  envelopeVerifierResponse(options): NativeTrustedVerifierEnvelope {
    // 验证身份是否由本通道创建
    // 返回带 Symbol 标记的可信信封
  }
}
```

**两种身份模式**：

| 模式 | 说明 | 信任基础 |
|------|------|----------|
| **Skill-Coordinated** | Agent 通过 Runner 通道提交身份，Runtime 分配 executionRef | 本地进程信任 |
| **Host-Attested** | 由宿主平台（如 IDE Plugin、CI）签名认证 | 外部签名信任（预留） |

当前实现仅支持 `skill-coordinated` 模式，`host-attested` 为未来扩展预留。

### 独立 Review 强制要求

Handoff 最关键的约束是**独立审查**，通过三个层次强制执行：创建时校验 `reviewerExecutionRef !== builder_execution_ref`；修复模式反重复（`repairing` 阶段要求全新 `reviewer_execution_ref`，不能复用上一轮）；持久化后交叉验证（`reviewer_execution_ref` 和 `verifier_execution_ref` 都与 `builder_execution_ref` 不同）。

```typescript
// 三个执行引用两两不同，确保 实现→审查→验收 三方独立
if (input.review.reviewerExecutionRef === input.identity.executionRef)        // 创建时
  throw Error('reviewer ≠ builder');
if (repairing && oldRef === input.review.reviewerExecutionRef)                 // 修复反重复
  throw Error('fresh review required');
if (state.verification.verifier_execution_ref === state.builder_handoff.builder_execution_ref) // 持久化后
  throw Error('verifier ≠ builder');
```

---

## 七、Verify——验收

**独立只读仲裁 + 有界修复循环**。Verifier 不是"测试工具"而是"仲裁者"——独立于 Builder 的会话，只读检查代码和证据。修复循环有双重预算（失败次数 + 停滞检测），避免无限循环。

### Loop 合法状态

`verify-ready` | `await-user` | `blocked`

### 状态转换图（完整）

```
verify-ready
    │
    ├── reserveVerifierAttempt()
    │   → attempt +1, next_action → 'await-verifier-result'
    │
    │   [Verifier 返回结果]
    │
    ├── applyNativeVerifierEnvelope() → verdict === 'pass'
    │   ├── 有修复历史
    │   │   → recovery 模式，重置为 pending，做最终全量验证
    │   └── 无修复历史
    │       ├── skill-coordinated → await-user，等待用户确认
    │       └── host-attested → archive-ready，准备归档
    │
    ├── applyNativeVerifierEnvelope() → verdict === 'fail'
    │   ├── 预算内（failed_iteration_count < max 且 no_progress_count < 3）
    │   │   → build (repairing)，iteration +1，修复失败项
    │   │   → 无进展警告 ≥2 次时加 blocker（owner: builder）
    │   └── 预算外
    │       → await-user（stop_reason: 'budget' | 'stalled'）
    │
    ├── applyNativeVerifierEnvelope() → verdict === 'blocked'
    │   → await-user, blocker (owner: user, resolution: resolve-verifier-blocker)
    │
    ├── recordNativeVerifierExecutionError()
    │   ├── execution_failure_count < 3
    │   │   → verify-ready, retry
    │   └── ≥3
    │       → blocked (owner: runtime, resolution: retry-verifier)
    │
    └── recordNativeVerifierUnavailable()
        → await-user, blocker (owner: user, resolution: confirm-verifier-unavailable)
```

### Verifier 执行协议

Runtime 通过 `runnerAction` 驱动 Verifier 生命周期：`dispatch-verifier`（派发）→ `await-verifier`（等待）→ 提交结果。Agent 提交 Verifier 结果时使用 RunnerInput JSON：

```json
{
  "kind": "verifier-response",
  "response": {
    "verdict": "pass",
    "summary": "全部验收项通过",
    "acceptance": [
      { "id": "A1", "result": "passed", "reason": "验证通过" },
      { "id": "A2", "result": "passed", "reason": "验证通过" }
    ],
    "risks": ["Edge 浏览器下未测试"]
  }
}
```

### 推进条件（Verify → Archive）

**触发命令**（host-attested 模式下自动推进，skill-coordinated 模式需要用户确认）：

```bash
comet native next <change-name> \
  --summary "<summary>" \
  --accept-result \
  --expected-state-version <n> \
  --expected-action accept-result
```

**状态文件依据**：

| 字段 | 要求 |
|---|---|
| `phase` | `verify` |
| `status` | `await-user` |
| `loop.next_action` | `confirm-skill-coordinated-pass` |
| `verification_result` | `pass` |
| `verification.verdict` | `pass` |

**证据要求**：

| 证据 | 来源 | 用途 |
|---|---|---|
| Verifier Envelope | `verifier-response` JSON | 包含签名绑定的验收结果 |
| Envelope 绑定验证 | `applyNativeVerifierEnvelope()` | 验证 candidateId、identityProvider、iteration、attempt、acceptanceIds 全部匹配 |
| 检查结果 | `checks` 数组 | 所有检查必须 `passed` |
| 验收项 | `acceptance` 数组 | 所有项必须 `passed` |
| Verifier 独立性 | `verifier_execution_ref !== builder_execution_ref` | 确保不是 Builder 自检 |
| 修复历史 | `loop.previous_unresolved_ids` | 有修复历史时先进入 recovery 模式做最终全量验证 |

**状态文件变更**（host-attested 自动通过时）：

```yaml
phase: archive                   # 从 verify → archive
status: active
loop:
  stage: archive-ready           # 从 verify-ready → archive-ready
  next_action: archive
verification_result: pass
verification_report: verification.md  # 验收报告写入
verification:                    # 写入验收结果
  candidate_id: "<uuid>"
  verdict: "pass"
  checks: [...]
  summary: { text: "全部验收项通过", truncated: false }
  completed_at: "2026-09-04T..."
blockers: []                     # 清空
state_version: previous + 1
```

**skill-coordinated 模式**：需要额外一步用户确认：

```bash
# Continuation 返回 action: 'confirm-skill-coordinated-pass'
# 用户确认后执行：
comet native next <change-name> \
  --summary "<summary>" \
  --accept-result \
  --expected-state-version <n> \
  --expected-action accept-result
```

### 推进条件（Verify → blocked，执行失败）

`execution_failure_count < 3` 时自动重试；`≥ 3` 时进入 `blocked`，blocker 允许 `retry-verifier` 恢复。恢复后重置 `execution_failure_count`，回到 `verify-ready`。

### 推进条件（Verify → Verifier Unavailable + 降级通过）

平台无可用 subagent 时提交 `verifier-unavailable`，用户确认后降级为 `user-confirmed-degraded` 通过，进入 archive-ready。

### 通过验收的完整路径

`applyNativeVerifierEnvelope()` 收到 `verdict: 'pass'` 时，根据是否有修复历史走不同路径：有修复历史时进入 recovery 模式（重置所有验收项为 pending，回到 verify-ready 做最终全量验证）；无修复历史时，skill-coordinated 模式需要用户确认（`await-user`），host-attested 模式直接进入 archive-ready。

### Verifier 执行错误处理

- 连续 3 次执行失败 → `blocked`，blocker 允许 `retry-verifier`
- `retryNativeVerifier()` 清除阻塞状态，重置 `execution_failure_count`，回到 `verify-ready`
- 平台无 subagent 能力时提交 `verifier-unavailable`，用户确认后降级为 `user-confirmed-degraded` 通过

---

## 八、Archive——归档

### Loop 合法状态

`archive-ready` | `await-user` | `blocked` | `done`

### 前置条件

- `verification_result === 'pass'`
- `verification_report !== null`

### 状态转换图

```
archive-ready
    │
    ├── archive (--confirmed)
    │   → done
    │   ├── 合并分支 (merge)
    │   ├── 推送远程 (push)
    │   ├── 创建 PR (pull-request)
    │   └── 保留工作区 (keep)
    │
    ├── return-to-build
    │   → build (repairing)
    │
    └── await-user
        (archive_confirmation === 'required' 时等待确认)
```

### 推进条件（Archive → Done）

**状态文件依据**（`comet-state.yaml`）：

| 字段 | 要求 | 说明 |
|---|---|---|
| `phase` | `archive` | 必须处于 Archive 阶段 |
| `status` | `active` | 不能已阻塞或等待用户 |
| `loop.stage` | `archive-ready` | 内层循环必须在 archive-ready |
| `verification_result` | `pass` | 验收必须通过 |
| `verification.verdict` | `pass` | 验收结论必须通过 |
| `verification_report` | `verification.md` | 验收报告必须存在 |
| `archived` | `false` | 不能已归档 |

**第一阶段：Dry-Run 预览**

```bash
comet native archive <change-name> --dry-run [--finish merge|push|pull-request|keep]
```

Dry-Run 检查项：

| 检查 | 来源 | 失败后果 |
|---|---|---|
| Capability 冲突 | `otherPortableCapabilityOwners()` | 检测其他活跃 change 是否声明了相同 capability |
| Spec 基线一致性 | `assertSpecBase()` | 目标 Spec 文件的 base_hash 是否匹配预期 |
| 验收项完整性 | `assertArchiveReady()` | 所有验收项必须已通过 |
| 工作区收尾准备 | `prepareNativePortableWorkspaceFinish()` | 分支合并、推送、PR 创建是否可行 |
| 工作区收尾选择 | `workspace.finish` | `isolation !== 'current'` 时必须设置 finish |

**工作区收尾方式选择**：

```bash
# Continuation 提供五种选择的 commandAlternatives：
# 1. keep-workspace:  保留工作区
comet native archive <change-name> --dry-run --finish keep
# 2. merge-locally:   本地合并到目标分支
comet native archive <change-name> --dry-run --finish merge
# 3. push-branch:     推送 change 分支
comet native archive <change-name> --dry-run --finish push
# 4. push-pull-request: 推送并创建 PR
comet native archive <change-name> --dry-run --finish pull-request
# 5. defer-archive:   暂不归档，保留当前状态
```

**第二阶段：执行归档**

```bash
comet native archive <change-name> --confirmed
```

**归档操作**（`archiveNativePortableChange()`）：

1. **冻结 Spec 内容**：`freezeArchiveSpecChanges()` 将所有 spec 内容读入内存
2. **创建事务**：`comet.native.archive-transaction.v1` 事务日志
3. **应用 Spec 变更**：将 change 中的 spec 写入 canonical 位置（`specs/<capability>/spec.md`）
4. **写入验收报告**：将 `verification.md` 写入归档目录
5. **移动 state 文件**：`comet-state.yaml` 写入归档目录
6. **清理 Runtime 目录**：删除临时 runtime 文件
7. **提交事务**：`status → committed`

**第三阶段：工作区收尾**

根据 `workspace.finish` 执行：

| finish 值 | 操作 | 成功标志 |
|---|---|---|
| `keep` | 不操作 | `completed` |
| `merge` | `git merge` 到目标分支 | `merged: true` |
| `push` | `git push` 远程分支 | `pushed: true` |
| `pull-request` | `git push` + 创建 PR | `pullRequestUrl` |
| `null`（未设置） | 阻塞，要求选择 | `blocked` |

**状态文件变更**：

```yaml
phase: archive
status: done                      # 从 active → done
archived: true                    # 从 false → true
state_version: previous + 1
```

### 实现思想

**原子性归档 + 工作区收尾协议**。归档不是简单的"把文件归档"，而是：验证 Spec 基线一致 → 复制正式产物到归档目录 → 原子提交状态 → 收尾工作区。`workspace.finish` 字段确保分支/工作区隔离有明确的清理策略。

---

## 九、内层循环状态机（Loop）

### 设计思想

**为什么需要两层状态机？** 外层 `phase`（shape/build/verify/archive）定义了"当前做什么"，但粒度太粗。Build 阶段需要区分"首次实现"和"修复"；Verify 阶段需要区分"等待 Verifier"和"等待用户决策"。内层 `loop.stage` 补足了这层细粒度语义。

核心设计目标：

| 目标 | 实现 |
|---|---|
| **细粒度状态追踪** | 8 种 stage 覆盖所有工作流节点 |
| **非法状态预防** | `assertLifecycle()` 在每次写入时校验 stage × phase 组合 |
| **循环计数** | iteration/attempt 追踪候选轮次，避免无限循环 |
| **停滞检测** | no_progress_count 检测修复是否在缩小失败集 |
| **可恢复性** | status + stage 联合决定 Continuation 的推进策略 |

### 状态转换图

```
                         ┌──────────┐
                         │  shape   │ 初始状态（Shape 阶段）
                         └────┬─────┘
                              │ confirm acceptance
                              ▼
                    ┌───────────────────┐
              ┌─────│    building       │ 首次实现（Build 阶段）
              │     └────────┬──────────┘
              │              │ submit candidate
              │              ▼
              │     ┌───────────────────┐
              │     │  verify-ready     │ 候选已提交，准备验收（Verify 阶段）
              │     └──┬────┬────┬──────┘
              │        │    │    │
              │        │    │    └──────────────────────────┐
              │        │    │                               │
              │        │    │  [verdict: fail]              │
              │        │    │  + 预算内                     │
              │        │    └──────┐                        │
              │        │           ▼                        │
              │        │    ┌──────────────┐                │
              │        │    │  repairing   │ 修复模式（Build 阶段）
              │        │    └──┬────┬──────┘                │
              │        │       │    │                       │
              │        │       │    │ [no_progress ≥ 2]     │
              │        │       │    └──► await-user ──► 可选回到 building
              │        │       │                            │
              │        │       └──────► verify-ready        │
              │        │               (submit candidate)   │
              │        │                                    │
              │        │  [verdict: pass]                   │
              │        └──────────────────┐                 │
              │                           ▼                 │
              │                    ┌──────────────┐         │
              │                    │ archive-ready │ 准备归档（Archive 阶段）
              │                    └──┬────┬───────┘         │
              │                       │    │                │
              │                       │    └──► repairing   │
              │                       │         (return-to-build)
              │                       ▼
              │                    ┌──────┐
              │                    │ done │ 完成
              │                    └──────┘
              │
              │  ┌──────────────┐
              │  │  await-user  │ 等待用户决策（跨阶段）
              │  └──────┬───────┘
              │         │
              ├──◄── revise-implementation → building
              ├──◄── revise-requirements → shape
              ├──◄── resolve-verifier-blocker → verify-ready
              └──◄── accept-result / confirm-degraded → archive-ready
              │
              │  ┌──────────┐
              │  │  blocked  │ 阻塞，需要修复（跨阶段）
              │  └────┬─────┘
              │       │
              └──◄── retry-verifier → verify-ready
```

### 合法组合与状态守卫

phase 和 loop.stage 的合法组合由 `assertLifecycle()` 在每次状态写入时强制执行：

```typescript
// native-portable-state.ts | assertLifecycle()
const stagesByPhase = {
  shape:   new Set(['shape',        'await-user', 'blocked']),
  build:   new Set(['building',     'repairing',  'await-user', 'blocked']),
  verify:  new Set(['verify-ready',               'await-user', 'blocked']),
  archive: new Set(['archive-ready',              'await-user', 'blocked', 'done']),
};
```

守卫规则：

1. **stage × phase 组合**：当前 stage 必须属于当前 phase 的合法集合
2. **status × stage 一致**：`status === 'await-user'` 时 stage 必须也是 `await-user`；`status === 'blocked'` 时 stage 必须是 `blocked`；`status === 'done'` 时 stage 必须是 `done`
3. **active 不能使用终端 stage**：`status === 'active'` 时 stage 不能是 `await-user`/`blocked`/`done`
4. **archived × status 一致**：`archived` 必须与 `status === 'done'` 同步
5. **verification_result === 'pass' 的完整性**：必须有 persisted verification、所有验收项 passed、所有检查 passed

### Loop 状态字段

```typescript
interface NativePortableLoopState {
  stage: 'shape' | 'building' | 'verify-ready' | 'repairing'
       | 'archive-ready' | 'await-user' | 'blocked' | 'done';

  // ---- 循环计数器 ----
  iteration: number;               // Builder 候选轮次（从 1 开始，逐轮递增）
  attempt: number;                 // 同一候选对 Verifier 的尝试次数
  retry_epoch: number;             // Verifier 基础设施重试纪元
  goal_cycle: number;              // 目标周期（回到 Shape 重新确认时递增）

  // ---- 预算与停滞 ----
  failed_iteration_count: number;  // 连续验证失败次数，超出 maxVerifyFailures 时停止
  no_progress_count: number;       // 连续无进展次数，≥3 时停滞停止
  stop_reason?: 'budget' | 'stalled';  // 停止原因

  // ---- 执行状态 ----
  execution_failure_count: number; // Verifier 执行失败次数，≥3 时 blocked
  previous_unresolved_ids: string[];  // 上一轮未通过的验收项 ID
  next_action: string | null;      // 下一步动作标识
}
```

### 循环计数器机制

**iteration 与 attempt 的关系**：

```
iteration 1, attempt 1  ──►  Verifier fail  ──►  iteration 2, attempt 0  (回到 Build)
iteration 2, attempt 1  ──►  Verifier error  ──►  iteration 2, attempt 2  (重试同一候选)
iteration 2, attempt 2  ──►  Verifier pass  ──►  archive-ready
```

- `iteration` 在每次提交新候选（Build → Verify）时 +1
- `attempt` 在同一候选内重新派发 Verifier 时 +1，提交新候选时重置为 0
- `retry_epoch` 在 Verifier 基础设施重试时 +1（执行错误、blocked 后恢复）

### 停滞检测算法

```typescript
// native-loop-runtime.ts | progressCounters()
function progressCounters(state: NativePortableState, unresolvedIds: string[]): number {
  const previous = state.loop.previous_unresolved_ids;
  if (previous.length === 0) return 0;               // 首轮不检测停滞

  const previousSet = new Set(previous);
  const currentSet = new Set(unresolvedIds);
  const strictSubset =
    currentSet.size < previousSet.size &&
    [...currentSet].every((id) => previousSet.has(id));

  return strictSubset ? 0 : state.loop.no_progress_count + 1;
}
```

逻辑：如果本轮未通过的验收项集合**不是**上一轮的严格子集，说明修复没有缩小失败范围，`no_progress_count` +1。

### Loop History

每次循环迭代结束后，将一条不可变的历史记录追加到 `history` 数组：

```typescript
interface NativePortableHistoryEntry {
  iteration: number;
  attempt: number;
  outcome: 'pass' | 'fail' | 'blocked' | 'execution-error' | 'recovery';
  unresolved_ids: string[];
  summary: { text: string; truncated: boolean };
  completed_at: string;
}
```

- 历史有界：上限 50 条（`NATIVE_PORTABLE_HISTORY_LIMIT`）
- 溢出时最早记录被丢弃，统计信息合并到 `history_overflow` 计数器
- 每条记录包含 `outcome`，用于区分 pass（正常通过）、fail（验证失败）、blocked（语义阻塞）、execution-error（执行异常）、recovery（修复后通过）

### 实现技术总结

| 技术 | 代码位置 | 作用 |
|---|---|---|
| **合法组合守卫** | `native-portable-state.ts | assertLifecycle()` | 在每次 CAS 写入时校验 stage × phase × status 一致性 |
| **CAS 乐观锁** | `native-portable-state.ts | compareAndSwapNativePortableState()` | 通过 `state_version` 递增防止并发冲突 |
| **停滞检测** | `native-loop-runtime.ts | progressCounters()` | 检测修复是否在缩小失败集，避免循环空转 |
| **双重预算** | `failed_iteration_count` + `no_progress_count` | 失败次数超限或停滞时暂停，等待用户决策 |
| **有界历史** | `appendNativePortableHistory()` | 50 条上限 + 溢出合并，保持状态文件体积可控 |
| **next_action 驱动** | `loop.next_action` | 状态机推进的显式指令，Continuation 据此生成下一步命令 |

---

## 十、Continuation（延续）模式

### 设计思想

**Runtime 是大脑，Agent 是手**。这是 Continuation 模式最核心的设计哲学。

传统 Agent 工作流中，Agent 既负责理解状态（"我现在在哪"），又负责决定下一步（"我要做什么"），还要负责执行（"运行命令"）。这种"三位一体"模式的问题在于：

| 问题 | 表现 |
|------|------|
| **状态理解偏差** | Agent 需要从状态文件、聊天记忆、历史输出拼凑出当前进度，不同模型/会话的理解可能不一致 |
| **决策漂移** | 面对同一个状态，不同 Agent 可能做出不同的下一步决策 |
| **恢复困难** | 会话中断后，新 Agent 没有聊天记忆，难以从中间状态恢复 |
| **不可审计** | Agent 的决策过程是黑盒，无法验证"为什么选择做这个而不是那个" |

Continuation 模式将这三个职责解耦：

```
传统模式：
  Agent（理解状态 + 决定下一步 + 执行命令）

Continuation 模式：
  Runtime（读取状态文件 → 计算下一步 → 输出 Continuation）
       ↓
  Agent（解读 Continuation → 执行命令 → 填充输入）
       ↓
  Runtime（验证输入 → 写入状态 → 输出下一个 Continuation）
```

**Runtime 拥有"状态→决策"的映射逻辑**，Agent 只负责执行和收集输入。这从根本上解决了上述问题：状态理解是代码化的（`nativePortableContinuation()` 函数），决策是确定性的（给定相同状态永远输出相同 Continuation），恢复是天然的（读取状态文件就能生成 Continuation）。

### 与 Handoff 的本质区别

**Handoff 是"证据"，Continuation 是"指令"。**

| 维度 | Continuation | Handoff |
|------|-------------|---------|
| 本质 | **控制指令**——"下一步做什么" | **数据记录**——"刚才做了什么" |
| 方向 | Runtime → Agent | Builder → Verifier |
| 生命周期 | 每次命令后实时计算，不持久化 | 持久化到 `comet-state.yaml`，跨会话保留 |
| 消费者 | Agent（执行者） | Verifier（验收者） |
| 生成方式 | `nativePortableContinuation()` 纯函数 | `submitNativeBuilderCandidate()` 状态写入 |
| 确定性 | 同一状态 100% 相同的 Continuation | 同一提交可能不同（不同候选） |

两者的共同点是都存在于 **Build → Verify 的边界**：Handoff 是 Builder 提交的"我要被验证的证据"，Continuation 是 Runtime 返回的"去执行验证的指令"。但它们服务于不同的角色和目的。

### Continuation 的四层控制模型

每个 Continuation 包含四个层次的控制信息，从抽象到具体：

```
第1层：disposition（处置类别）
  └── 整体状态：continue / await-user / blocked / done

第2层：action（动作类型）
  └── 具体动作：confirm-shape / builder-handoff / dispatch-verifier / archive / ...

第3层：commandArgs（CLI 命令模板）
  └── 可执行命令：["comet", "native", "next", "<change>", "--runner-input", "<file>"]

第4层：inputOptions（输入模板）
  └── 输入规范：{ name: "summary", flag: "--summary", valueKind: "text", ... }
```

**第1层：disposition——整体状态信号**

```
'continue'    → 一切正常，Agent 继续执行 commandArgs
'await-user'  → 需要用户决策，Agent 展示 userCommunication 并等待
'blocked'     → 被阻塞，需要修复或重试
'done'        → 工作流结束，commandArgs 为 null
```

disposition 是 Agent 的最高决策依据。Agent 不需要理解状态文件的细节，只需要看 disposition 就知道整体情况。

**第2层：action——具体动作语义**

action 有 12 种取值，覆盖整个工作流的所有可能动作：

| action | 触发条件 | 说明 |
|--------|---------|------|
| `confirm-shape` | Shape 阶段，等待确认 | 用户确认需求范围、验收项、关键决定 |
| `builder-handoff` | Build 阶段，候选完成 | 提交 Builder Handoff，进入 Verify |
| `dispatch-verifier` | Verify 阶段，检查已就绪 | 派发独立的 Verifier subagent |
| `await-verifier` | Verify 阶段，等待结果 | 等待已派发的 Verifier 返回结果 |
| `repair` | Build 阶段，修复模式 | 根据 Verifier 失败反馈修复实现 |
| `retry-verifier` | blocked 状态，执行失败 | 重试 Verifier（因为执行错误） |
| `confirm-skill-coordinated-pass` | await-user，Skill-Coordinated 通过 | 用户确认接受 Skill-Coordinated 验证结果 |
| `confirm-verifier-unavailable` | await-user，Verifier 不可用 | 用户确认接受降级结果 |
| `resolve-verifier-blocker` | await-user，Verifier 语义阻塞 | 用户补充信息解决 Verifier 阻塞 |
| `resolve-loop-stop` | await-user，预算耗尽 | 用户选择继续修复或调整需求 |
| `archive` | Archive 阶段 | 执行归档操作 |
| `none` | done 或其他终端状态 | 无操作 |

**第3层：commandArgs——可执行的 CLI 命令模板**

`commandArgs` 是 Agent 可以直接执行的命令数组。它包含 `<placeholder>` 占位符，Agent 需要填充实际值：

```typescript
// Build → Verify 提交 Handoff
commandArgs: [
  "comet", "native", "next", "<change-name>",
  "--runner-input", "<temporary-json-file>"
]

// Shape → Build 确认
commandArgs: [
  "comet", "native", "next", "<change-name>",
  "--summary", "<summary>",
  "--confirmed",
  "--expected-state-version", "5",
  "--expected-action", "confirm-shape"
]
```

`commandArgs === null` 表示当前没有可执行的命令，Agent 需要等待用户决策或处理阻塞原因。

**第4层：inputOptions——输入模板与校验**

`inputOptions` 定义了 Agent 需要填充的输入规范：

```typescript
interface NativePortableContinuationInputOption {
  name: string;           // 输入名称，如 "summary"
  flag: string;           // CLI flag，如 "--summary"
  valueKind: 'text' | 'confirmation' | 'choice' | 'json-file';
  required: boolean;      // 是否必须
  template: unknown | null;  // JSON 模板（用于 json-file 类型）
  choices?: string[];     // 可选值（用于 choice 类型）
}
```

四种 valueKind 对应四种输入类型：

| 类型 | 说明 | 示例 |
|------|------|------|
| `text` | 自由文本输入 | `--summary "实现了登录功能"` |
| `confirmation` | 确认标志 | `--confirmed` |
| `choice` | 从枚举中选择 | `--coordination-mode multi-session` |
| `json-file` | 临时 JSON 文件 | `--runner-input /tmp/handoff.json` |

`json-file` 类型是 Skill-Coordinated 模式的核心交互方式：Agent 将结构化数据写入临时 JSON 文件，Runtime 通过 `readNativeRunnerInput()` 读取并验证。

### 纯函数式 Continuation 生成

`nativePortableContinuation()` 是一个**纯函数**——输入相同的 `(state, children, options)`，永远输出相同的 Continuation：

```typescript
export function nativePortableContinuation(
  state: NativePortableState,
  children?: NativeChildrenInspection | null,
  options: NativePortableContinuationOptions = {},
): NativePortableContinuation {
```

**纯函数性质**：

| 性质 | 表现 | 意义 |
|------|------|------|
| **确定性** | 相同输入 → 相同输出 | 任何设备、任何时间都能生成一致的 Continuation |
| **无副作用** | 不修改状态、不写文件、不调用外部命令 | 可安全地多次调用，不会意外改变状态 |
| **可测试** | 输入输出可直接验证 | 单元测试覆盖所有状态组合 |

**状态驱动的决策树**：函数内部是一个大型决策树，按 `status → phase → loop.stage → loop.next_action` 的顺序逐层缩窄：

```
status === 'done'          → action: 'none'
status === 'await-user'    → 按 phase + next_action 分发到 5 种 await-user 子类型
status === 'blocked'       → 按 blocker 类型分发到 retry-verifier / none
status === 'active'
  ├── phase === 'shape'    → action: 'confirm-shape'
  ├── phase === 'build'    → 按 children + loop.stage 分发到 builder-handoff / repair / advance-children
  ├── phase === 'verify'   → 按 next_action 分发到 dispatch-verifier / await-verifier
  └── phase === 'archive'  → 按 archiveMode + workspace.finish 分发到 archive
```

这种决策树结构确保了**每个状态都有唯一的、确定的下一步**，不存在"状态匹配不到"的缺口。

### userCommunication——Agent 与用户的沟通协议

`userCommunication` 是 Continuation 中一个独特的设计：它**不是给 Agent 的指令，而是给 Agent 用来与用户沟通的指令**。

```typescript
interface NativePortableUserCommunication {
  required: boolean;          // 是否需要用户交互
  message: string | null;     // 给用户的消息（已本地化）
  suggestedReply: string | null;  // 建议回复
  agentInstruction: string;   // 给 Agent 的沟通指令
}
```

**设计意图**：Runtime 无法直接与用户对话（Runtime 是无界面的 CLI 进程），但 Runtime 知道"在什么状态下应该对用户说什么"。userCommunication 将沟通内容也纳入状态机的控制范畴：

```
Runtime 决定"说什么"和"怎么说" → Agent 负责转述 → 用户做出选择
```

**示例：Verifier 执行失败时的沟通**

```typescript
// Runtime 检测到 Verifier 连续执行失败
userCommunication = {
  required: true,
  message: "由于独立验收任务连续几次没有正常返回结果，本次验收已暂停。回复「继续」即可重新尝试。",
  suggestedReply: "继续",
  agentInstruction: "只向用户转述 message 和 suggestedReply，并等待用户回复。不要展示内部轮次、计数、路径或恢复步骤。"
}
```

注意 `agentInstruction` 中的约束：**"不要展示内部轮次、计数、路径或恢复步骤"**。这是 Continuation 设计的重要原则——**Agent 是 Runtime 与用户之间的信息过滤器**，Runtime 控制什么信息应该展示、什么信息应该隐藏。`userCommunication.required === false` 时 Agent 直接执行 `commandArgs`，无需与用户交互。

### commandAlternatives——用户选择的多路径支持

当 Agent 需要用户选择时，Continuation 提供 `commandAlternatives` 数组，每个选项包含完整的命令模板，例如"继续修复"或"调整需求"：

```typescript
commandAlternatives: [
  {
    name: "revise-implementation",
    commandArgs: ["comet", "native", "next", "my-change",
      "--summary", "<summary>", "--revise-implementation",
      "--expected-state-version", "7", "--expected-action", "revise-implementation"],
    requiredInputs: ["summary", "user-decision"],
    inputOptions: [
      { name: "summary", flag: "--summary", valueKind: "text", ... },
      { name: "revise-implementation", flag: "--revise-implementation", valueKind: "confirmation", ... }
    ]
  },
  { name: "revise-requirements", ... }  // 结构同上，action 不同
]
```

**关键设计**：每个 `commandAlternative` 都包含 `--expected-state-version` 和 `--expected-action`。这是 CAS 乐观锁在 Continuation 层的延伸——**即使 Agent 在执行前状态已经变化，Runtime 也能通过 expected 参数检测到版本冲突，而不是盲目执行**。

### runnerAction——Runtime 的异步动作

`runnerAction` 是 Continuation 中专门给 Runtime 看的字段，Agent 不直接处理：

```typescript
interface NativePortableRunnerAction {
  kind: 'builder-handoff' | 'dispatch-verifier' | 'await-verifier' | 'retry-verifier' | 'none';
  candidateId: string | null;  // 当前候选 ID
  iteration: number;           // 当前迭代号
  attempt: number;             // 当前尝试次数
}
```

**设计意图**：Runtime 在 Agent 执行命令的同时，可能需要执行一些异步动作（如派发 Verifier 任务、记录运行状态）。`runnerAction` 将这些动作的语义编码到 Continuation 中，让 Runtime 知道"Agent 在做什么的同时，我应该做什么"。

```
Agent 执行 CLI 命令          Runtime 执行 runnerAction
─────────────────────       ─────────────────────
提交 Builder Handoff    →   记录 Builder 执行身份
派发 Verifier          →   创建 Verifier 执行记录
等待 Verifier 结果     →   轮询 Verifier 任务状态
重试 Verifier          →   重置执行失败计数
```

### 契约模式：expectedStateVersion + expectedAction

在 `commandArgs` 和 `commandAlternatives` 中，每个命令都包含两个契约参数：

```bash
comet native next my-change \
  --expected-state-version 7 \
  --expected-action confirm-shape
```

`nativeNextCommand()` 的入口处验证这两个参数：

```typescript
const expectedContinuation = expectedContinuationOption(args);
// 验证 stateVersion 是正整数
// 验证 action 是已知的 EXPECTED_CONTINUATION_ACTIONS 之一
```

**设计意图**：这是 CAS 乐观锁在命令层的延伸。当 Agent 执行命令时，Runtime 验证：

1. **stateVersion 匹配**：当前状态文件的 `state_version` 是否等于预期值？不匹配说明状态已被其他进程修改
2. **action 匹配**：当前状态是否仍然期望这个 action？状态变化可能导致预期的 action 不再有效

这种双重验证确保 Agent 的"意图"与 Runtime 的"状态"始终保持一致，防止因并发或状态变化导致的错误执行。

### 确定性恢复机制

Continuation 模式最强大的能力是**确定性恢复**：

```
会话中断 → 新会话启动
  → Agent 读取 comet-state.yaml
  → Runtime 调用 nativePortableContinuation(state)
  → 得到与中断前完全相同的 Continuation
  → 从断点继续执行
```

**恢复的四种场景**：

| 场景 | 恢复方式 | 示例 |
|------|---------|------|
| 进程中断 | 重新读取状态 → Continuation | 中断在 Build 阶段，恢复后继续 builder-handoff |
| 设备切换 | 新设备读取状态 → Continuation | 从笔记本切换到桌面，状态不变，Continuation 不变 |
| 并发恢复 | 状态版本检测 → 拒绝陈旧操作 | 两个 Agent 同时推进，版本号低的失败 |
| 状态损坏 | Recovery 流程 → 修复状态 → Continuation | 文件损坏后 `recoverNativePortableChange()` 修复 |

---

## 十一、Blocker 系统

`blockers` 数组是结构化的阻塞管理机制：

```typescript
interface NativePortableBlockerState {
  owner: 'builder' | 'runtime' | 'verifier' | 'user' | 'external';
  reason: { text: string; truncated: boolean };
  acceptance_ids: string[];          // 相关的验收项
  resolution_action: 'return-build' | 'retry-verifier'
                   | 'resolve-verifier-blocker'
                   | 'confirm-verifier-unavailable'
                   | 'await-user' | 'wait-external';
}
```

### Blocker 生命周期

| 阶段 | 创建者 | 原因示例 | 解析方式 |
|---|---|---|---|
| Build | builder | 修复无进展（≥2 次） | `return-build` |
| Verify | runtime | Verifier 连续执行失败 | `retry-verifier` |
| Verify | user | Verifier 语义阻塞 | `resolve-verifier-blocker` |
| Verify | user | 平台无 subagent 能力 | `confirm-verifier-unavailable` |
| Archive | user | 需要确认归档 | `await-user` |

---

## 十二、设计哲学总结

| 设计决策 | 解决的问题 | 实现方式 |
|---|---|---|
| **单文件状态** | 状态分散难以恢复 | 所有状态收敛到 `comet-state.yaml` |
| **CAS 乐观锁** | 多 Agent/会话并发冲突 | `state_version` 递增 + Compare-And-Swap |
| **内层循环状态机** | 外层阶段粒度太粗 | `loop.stage` 管理 8 种细粒度状态 |
| **Builder Handoff** | Builder→Verifier 解耦 | 结构化交接包，含独立 review 签名 |
| **Verifier Envelope** | 验收结果不可抵赖 | 签名绑定验证（candidateId, iteration, attempt） |
| **有界修复循环** | 防止无限修复循环 | `failed_iteration_count` + `no_progress_count` 双重预算 |
| **停滞检测** | 检测修复无进展 | `no_progress_count` 连续 3 次未缩小失败集 |
| **Continuation** | 跨设备/会话恢复 | 状态驱动，Runtime 计算下一步命令 |
| **Blocker 系统** | 阻塞原因结构化 | owner + reason + acceptance_ids + resolution_action |
| **Loop History** | 循环过程可追溯 | 50 条有界历史 + 溢出计数器 |
| **独立只读 Verifier** | 防止 Builder 自检自验 | 新 Agent 会话，只读检查，不可修改代码 |

### 核心思想

**把工作流变为可验证、可恢复、可审计的状态机数据流**。每个阶段不是"让 Agent 去做事"，而是"让 Agent 提交证据，让 Runtime 做判断，让状态机记录结果"。`comet-state.yaml` 是唯一的真相来源，Continuation 是唯一的推进指令——两者结合，任何 Agent、任何设备、任何时刻都能准确恢复工作流。

---

## 附录：v4 状态机核心源代码索引

| 文件 | 功能 |
|---|---|
| `domains/comet-native/native-portable-types.ts` | v4 状态类型定义 |
| `domains/comet-native/native-portable-state.ts` | 状态读写、解析、验证、CAS 写入 |
| `domains/comet-native/native-loop-runtime.ts` | 内层循环状态机：确认验收、提交候选、Verifier 结果处理、修复、返回 |
| `domains/comet-native/native-portable-runtime.ts` | 外层 Runtime：创建 change、确认 Shape、提交 Builder Handoff、恢复 |
| `domains/comet-native/native-portable-continuation.ts` | Continuation 生成逻辑，包含所有命令模板和 userCommunication |
| `domains/comet-native/native-portable-archive.ts` | 归档实现：冻结 Spec、事务处理、Spec 写入 |
| `domains/comet-native/native-next-command.ts` | `next` 命令处理：解析所有 flag 并分发到对应函数 |
| `domains/comet-native/native-archive-command.ts` | `archive` 命令处理：dry-run、confirmed、finish |
| `domains/comet-native/native-runner-input.ts` | Runner 输入类型定义（builder-handoff、dispatch-verifier、verifier-response 等） |
| `domains/comet-native/native-cli-shared.ts` | CLI 共享工具：`takeFlag`、`takeOption`、`requiredPositional` |
| `domains/comet-native/native-verifier-protocol.ts` | Verifier 协议：`NativeVerifierResponse` 验证 |
| `domains/comet-native/native-runner-protocol.ts` | Runner 协议：`NativeTrustedExecutionIdentity`、`NativeTrustedVerifierEnvelope` |