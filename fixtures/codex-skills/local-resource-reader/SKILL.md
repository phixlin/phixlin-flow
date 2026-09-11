---
name: local-resource-reader
description: M0 capability fixture for reading a resource relative to a self-authored Skill.
---

When the host explicitly dispatches this Skill, read `references/token.txt` relative to this
`SKILL.md`. Report the exact token. Fail if the file is absent or unreadable; do not infer it.
