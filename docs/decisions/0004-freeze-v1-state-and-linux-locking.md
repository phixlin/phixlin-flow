# 0004 冻结 v1 状态协议与 Linux advisory locking

## 背景

M0 needs machine-readable contracts before the reducer and store are implemented. The main state
must reject ambiguous YAML, invalid outer/inner combinations, stale candidate evidence, and Skill
records that do not match the selected Workflow snapshot. Concurrent state writers also need a
lock whose ownership ends with the process and whose identity is not changed by deleting and
recreating a lock file.

Codex structured output accepts a smaller JSON Schema subset than the full state validator. The M0
probe rejected root `allOf`, `uniqueItems`, and `const` or `enum` declarations without an explicit
`type`. The current nested container also prevents Codex's `workspace-write` sandbox from starting,
although read-only structured calls work and the control directory write is denied.

## 决策

Freeze `phixlin.flow.v1` as JSON Schema 2020-12 plus explicit cross-field invariants in ordinary
TypeScript. Parse persisted YAML with `yaml`, reject duplicate keys, and validate external data with
Ajv. Preserve the originating `position` in `stage-ready`; `decide` yields `advance` for that action,
and the root reducer applies the corresponding approval or stage guard. Keep four lifecycle fixtures
and machine-readable reducer vectors as the M1 implementation contract. Keep Codex execution
results in a separate response-format-compatible Schema and enforce conditional and uniqueness
rules after collection.

Use Linux `flock` through `fs-ext` for the first state Store. Keep `mutation.lock` and
`executor.lock` as fixed files and never delete them during unlock or stale-process handling. Use a
bounded non-blocking acquisition loop. Commit state by writing and syncing a unique same-directory
temporary file, atomically renaming it, then syncing the parent directory. Preserve the
reserve/dispatch/collect/commit boundary and reconcile unknown external operations before retry.

Treat `workspace-write` support as a required Runtime preflight. A host failure must block before
Build; the Harness cannot silently switch to `danger-full-access`. The broader mode was used only
to isolate and verify explicit Skill/resource loading in this M0 probe.

## 后果

M1 can implement reducer and Store behavior against executable fixtures without inventing protocol
details. Linux is the only supported Store platform until another locking decision is recorded.
Installation needs a native build toolchain for `fs-ext`. The response validator has two layers,
and their tests must prevent the Codex-compatible Schema from weakening Harness invariants.

M0 is not fully released on this host because `workspace-write` remains blocked by sandbox setup.
Authentication, JSONL, structured output, answer continuation, Skill relative resources, and
missing-resource failure are verified. The repository now includes a repeatable
`pnpm probe:codex-workspace-write` probe and a recorded explicit `danger-full-access` control run;
the latter is evidence of an explicitly authorized broader runtime mode, not a workspace-write
substitute. The Harness accepts it only when the caller selects `danger-full-access` deliberately;
there is no automatic fallback. A compatible host must still rerun the workspace-write and control
isolation probe before claiming the narrower sandbox gate.
