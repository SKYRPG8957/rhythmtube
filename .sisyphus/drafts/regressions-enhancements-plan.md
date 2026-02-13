# Draft: User-Reported Regressions and Enhancements

## Requirements (confirmed)
- Create an exact implementation plan (no code edits) for reported regressions/enhancements in existing TypeScript codebase.
- Plan must include a parallel task graph with dependencies.
- Plan must include target files/functions, success criteria, and verification steps.
- Scope includes:
  - Floor graphic is partial/fixed/too wide; make full running-path floor with motion.
  - Game start sequence countdown from 3 then GO.
  - On GO, song starts at low volume and ramps to full in 0.3s.
  - Optimize map generation and audio analysis.
  - Reduce intro false positives where calm sections are misclassified as intro.
- Required tools: read/search only in this repository.
- Must include concrete patch points and risk mitigation.
- Must not perform file edits to source files.

## Technical Decisions
- Planning-only mode: gather context from repo, then produce execution plan.
- Use repository inspection plus external best-practice research to tighten risk controls.

## Research Findings
- Pending: codebase exploration agent
- Pending: external documentation/best-practices agent

## Open Questions
- Pending clarification after codebase inspection.

## Scope Boundaries
- INCLUDE: exact implementation planning, dependency graph, parallelization, file/function patch points, verification strategy.
- EXCLUDE: any source code modification or system/config changes.
