# 0007 M2 Harness orchestration and durable evidence

## Context

M1's runner stopped at generic stage-ready results. Its Fake Runtime retained results only in memory, and verification could enter repair through result-continue without collecting host checks. Candidate and review events added during M2 had no runtime caller. Passing the old reducer tests did not establish a functioning delivery workflow.

The selected M2 scope is Harness orchestration with a deterministic Fake Runtime and real evidence files. Codex processes, executing repository commands, and collecting a live worktree manifest remain M3 adapter responsibilities. The frozen flow-state v1 format must remain readable.

## Decision

StageRunner requires a FileEvidenceStore and FileSkillResolver. It reads frozen Skill instructions and resources, supplies the full direct predecessor output, prior execution references, brief/specification content and the supplied candidate diff, and reserves the digest of that exact input before dispatch. Completed instructions remain in later stage input. A content-addressed operation envelope binds persisted output to the entire reserved operation. Evaluation reads that envelope from disk, not from Fake Runtime memory.

Shape publication and candidate capture consume collected output atomically. Shape approval binds the proposed specification digest without changing the brief digest. The Harness owns candidate IDs, specification/iteration binding and execution identities; candidate_digest is the SHA-256 of the supplied immutable manifest bytes. The Fake Runtime supplies manifest/diff and host-check records through the same boundary a real adapter will implement. This does not claim that a live worktree was inspected or a real shell command was run in M2.

Review, host checks and verification are separate reserved operations. Verifier results cannot replace host checks. Each new candidate starts full verification with pending acceptance results. Failed verification enters a new Build visit within the repair budget; failure-set cardinality is compared with the previous persisted verification record. Success waits for explicit result approval. Changed candidate evidence returns to Build; a specification proposal returns to Shape. Candidate history and verification summaries remain immutable artifacts.

Remove the unused Codex preflight TypeScript wrappers, Fake Runtime result cache/enqueue/default outcome, unused runner configuration, and the result-continue verification bypass. Replace the old in-memory runner smoke tests and repair bypass test with file-backed orchestration tests. Keep the CLI probes, frozen state/Schema tests and CAS tests: they still exercise supported boundaries. No old persistent state Schema is rewritten. State serialization disables YAML aliases to match the existing public reader contract.

## Consequences

M2 can be exercised without Codex authorization, using checked-in outline/summarize Skills. Tests re-read state and artifacts, cover committed-result restart, completed-Skill restart, retries, contextual failures, review identity/binding, corrupt artifacts, full verification regressions and repair exhaustion. Unknown running calls are not automatically redispatched.

Evidence is local and immutable by content hash. Missing or invalid results fail before completion; full reconciliation after an uncollected external call and process supervision remain M4 work. The M2 publishing boundary is result approval; real Codex execution and final archive completion remain M3. General discovery of arbitrary natural-language resource dependencies is not promised by the resolver.
