
## Repository-owned fallback when Entire graph is unavailable

This repository-owned section takes precedence over the managed block above and
`.entire/graph-agent.md`. Keep it outside generated blocks during regeneration.
A generated statement that the graph is installed is not evidence of availability,
compatibility, or permission in the current environment. The graph is optional;
its absence must not block otherwise permitted focused source inspection.

### Before any CLI or plugin execution

Use existing trusted installation and review records to establish that the CLI
and plugin are already available, permitted in this environment, and approved
and compatible for this task. If any of those conditions is unknown or false,
do not execute the CLI or plugin, even for `--version`, capabilities, or a trial
search. Continue with `rg --files`, `rg`, and focused source reads, subject to the
same environment permissions. Do not install, upgrade, or enable a tool to make
this prerequisite appear satisfied.

Only when those conditions are established may the prescribed graph search be
attempted once, within the environment's existing execution limits. A failed,
empty, or insufficient search is not a blocker: use focused source inspection
and verify the relevant behavior. The guide's exact-known-file exception still
applies; an unnecessary search is not required.

| Observed condition | Graph execution | Next step |
| --- | --- | --- |
| CLI or plugin absent | None | Focused source inspection |
| Execution forbidden | None, including version/capability probes | Permitted focused source inspection |
| Approval or compatibility unknown | None, including a trial search | Focused source inspection; record the missing prerequisite |
| Tool unapproved or incompatible | None | Focused source inspection |
| Approved, permitted, compatible search fails | One bounded attempt already made; no automatic retry | Focused source inspection; retain the failure |
| Approved, permitted, compatible search is empty or insufficient | One bounded attempt already made; no automatic retry | Focused source inspection; record the limitation |
| Approved, permitted, compatible search is useful | Use the bounded result | Inspect the relevant source and verify; do not treat graph output as an oracle |

Record whether execution was not attempted or failed, the non-sensitive reason,
and the fallback used. Never describe an unattempted search as an executed test.
No fallback may install the CLI or plugin, enable checkpoint publishing, or
upload repository content. Do not read secrets or private transcripts to
establish tool availability or approval.

The existing repository workflow gate remains unchanged: installation and
execution stay disabled until a compatible source, release, immutable digest,
and generated-file contract are independently reviewed. This guidance supplies
none of that approval and does not activate checkpoint publishing; see
[the session-capture policy](.entire/README.md).
