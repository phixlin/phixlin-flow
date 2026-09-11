# State Protocol v1

`phixlin.flow.v1` is the only state schema supported by the first implementation. The normative
machine contract is [`schemas/flow-state-v1.schema.json`](../../schemas/flow-state-v1.schema.json),
with cross-field invariants enforced by `validateChangeState`. YAML is only the storage syntax;
duplicate keys, aliases that exceed the parser boundary, unknown properties, unknown schemas, and
invalid field combinations fail at load time.

## Files and trust boundaries

```text
<repository>/.phixlin/workflows/<name>.yaml       project configuration
<repository>/.phixlin/changes/<change-id>/       user-authored change data
  brief.md
  specs/
  artifacts/                                     immutable evidence
  events.jsonl                                   diagnostics only
  knowledge.md

<control-root>/<repository-id>/<change-id>/       outside Agent writable roots
  flow-state.yaml                                only recovery control plane
  mutation.lock                                  fixed inode advisory lock
  executor.lock                                  fixed inode advisory lock
  operations/                                    adapter input/result staging
```

The control root is supplied by the Harness and cannot be located under the Agent's writable
workspace. Artifact paths in state are normalized paths below the change `artifacts/` directory;
absolute paths, backslashes, and `..` traversal are invalid. Workflow Skill resources use paths
relative to their `SKILL.md` and are validated while creating the Workflow snapshot.

## Field dictionary

| Field | Contract |
|---|---|
| `schema` | Literal `phixlin.flow.v1`; unknown versions stop execution. |
| `change_id` | Stable user-facing identifier across Shape, repairs, restarts, and completion. |
| `state_version` | Starts at 0 and increases by exactly one for each committed mutation. |
| `workspace` | Absolute repository root, repository identity, baseline evidence, and confirmed writable scope. |
| `workflow` | Immutable Profile name/version/runtime/digest plus ordered, resolved Skill and resource snapshots. |
| `outer` | Delivery `phase`, scheduling `status`, monotonic `stage_visit`, and candidate `iteration`. |
| `inner` | The only current lifecycle position and the only in-flight `operation`, when one exists. |
| `budget` | Current visit turns, infrastructure failures, repairs, and no-progress counters with limits. |
| `skills` | All planned records for the current visit plus observed or reported contextual records. |
| `stage_context` | Current revision binding, planned completion order, execution IDs, and stage evidence. |
| `brief` | Current brief revision, digest, immutable copy, and human confirmation. |
| `shape` | Frozen spec revision, acceptance IDs, check argv arrays, and human approval. |
| `candidate` | Builder Handoff bound to spec, iteration, workspace digest, evidence, builder, and reviewer. |
| `verification` | Machine checks and Verifier results bound to the current candidate and full acceptance list. |
| `interaction` | Awaited question or approval, current binding, answers, and exact resume position. |
| `blocker` | Error code, reason, allowed recovery actions, and exact resume position. |
| `finalization` | Pending, prepared, or completed archive bound to the approved candidate. |
| `history` | Ordered mutation receipts; action IDs are unique and version ranges are contiguous. |

The full structural types are exported from `src/contracts/types.ts`. Four normative examples live
under `fixtures/state/`: `initial.yaml`, `build.yaml`, `verify.yaml`, and `completed.yaml`.

## Legal combinations

| Outer status | Required inner state | Required side record |
|---|---|---|
| `active` | `ready`, `executing`, `reconciling`, `evaluating`, or `stage-ready` | no interaction or blocker |
| `await-user` | `waiting-user` | matching `interaction` |
| `paused` | any resumable or in-flight position allowed by the current phase | records preserved |
| `blocked` | `blocked` | matching `blocker` |
| `done` | `idle` in `completed` only | no interaction or blocker |

Actions are phase-specific. Shape permits `skill` and `agent-work`; Build additionally permits
`capture-candidate` and `review-candidate`; Verify permits `skill`, `run-checks`,
`verify-candidate`, and `finalize`. `decide(state)` derives the sole next controller command from a
validated state. `stage-ready` retains the position that produced it, so `advance` can apply the
correct approval, capture, review, verification, or finalization guard. Agent output can request
readiness, but only the root reducer may change the outer phase.

## Binding invariants

- `stage_context.binding` matches change ID, visit, Workflow digest, brief/spec revisions, and the
  current candidate when Build has already captured one or Verify is consuming one.
- An operation or interaction carries the same binding as `stage_context`.
- Every planned Skill record matches the current phase snapshot by array index, name, and digest;
  it must be host-observed. Contextual records cannot carry a planned index.
- Build and later phases require confirmed Shape evidence. A candidate matches the current spec;
  its reviewer has a separate host execution and reviews the same candidate digest.
- Verification covers every frozen acceptance ID exactly once and matches the current candidate.
  `pass` requires every machine check and acceptance result to pass.
- Human Shape and result approvals bind to their subject digest. Agent execution results contain no
  approval field. Completion requires an approved passing verification and completed archive.

## External records

`schemas/execution-result-v1.schema.json` is the structured result passed to Codex. It deliberately
uses the smaller response-format JSON Schema subset observed in M0; the Harness checks conditional
and uniqueness constraints after collection. `needs-user` is the only result allowed to contain
questions. `schemas/event-v1.schema.json` defines append-only diagnostics, which never override
`flow-state.yaml`. `schemas/reducer-vectors-v1.schema.json` and `fixtures/reducer/v1.yaml` freeze
the event behavior M1 must implement.
