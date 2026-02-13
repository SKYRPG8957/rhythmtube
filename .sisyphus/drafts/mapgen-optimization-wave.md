# Draft: Mapgen Optimization Wave

## Requirements (confirmed)
- Provide a concrete next-step implementation plan for one more optimization wave in the mapgen pipeline.
- Expected output is an ordered patch list with exact target functions and verification steps.
- Use read/search only during planning.
- Prioritize minimal behavior change and compile-safe edits.
- Do not edit source files.
- Current focus functions: `rebalanceSectionDensityByDifficulty`, `trimDensePlayableSections`, `rebalanceSlideTapMix`, `ensureMinimumDensity`.

## Technical Decisions
- Planning mode only (no implementation in this session).
- Optimization proposals should emphasize low-risk, localized changes first.

## Research Findings
- Pending: codebase exploration and external best-practice synthesis.

## Open Questions
- Exact acceptance threshold for performance gain per function (if any).
- Preferred verification depth (fast smoke vs deeper regression pass).

## Scope Boundaries
- INCLUDE: next optimization wave plan for listed bottleneck functions.
- EXCLUDE: direct code edits, refactors outside targeted functions, broad behavior changes.
