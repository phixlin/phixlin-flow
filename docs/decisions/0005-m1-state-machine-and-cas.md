# M1 状态机与文件 CAS

## 背景

M0 froze the v1 state shape, reducer vectors, and Linux locking protocol, but the package had no executable state transitions or persistence boundary.

## 决策

Implement a pure root reducer for the frozen events and a file-backed `StateMutationStore`. The store serializes read/validate/reduce/replace under a fixed-inode advisory lock, deduplicates committed action IDs, and uses fsync plus atomic rename for state replacement. A Stage Runner owns reserve/dispatch/collect/evaluate sequencing, while a deterministic Fake Runtime supplies test outcomes without coupling M1 to Codex.

## 后果

M1 provides deterministic transitions, durable single-file commits, and an executable inner loop without running external work while locked. Unknown external outcomes stop at the reducer's reconciling state rather than being redispatched. Real Skill resolution, candidate artifact construction, and Codex execution remain M2/M3 concerns.
