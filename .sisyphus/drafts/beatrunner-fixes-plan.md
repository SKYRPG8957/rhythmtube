# Draft: BeatRunner Requested Fixes

## Requirements (confirmed)
- Produce a precise implementation plan (planning/reasoning only).
- Cover exactly these requests with no scope reduction:
  - Remove sky-blue background flicker.
  - Align floor grid with character/world.
  - Improve lyric/melody-sensitive note detection.
  - Diversify camera work.
- Plan output must include:
  - Parallel task graph (waves + dependencies).
  - Concrete file-level edits.
  - Verification checklist with commands.
  - Risk notes.
- Avoid vague steps.
- Do not introduce new dependencies/files unless absolutely unavoidable.
- Existing code had recent renderer/effect updates.
- Background analysis tasks are running for code evidence; plan should anticipate integrating findings.

## Technical Decisions
- Mode: planning only (no implementation changes).
- Approach: evidence-backed planning with explicit dependencies and command-level verification.

## Research Findings
- Repository evidence map completed from `bg_2abd914a`.
  - Flicker/compositing touchpoints: `src/core/Renderer.ts`, `src/main.ts`, `src/core/Engine.ts`, `src/styles/index.css`, `index.html`.
  - Grid/world sync touchpoints: `src/core/Renderer.ts` (`drawFloorGrid`), `src/game/Character.ts`, `src/game/NoteManager.ts`, `src/main.ts` camera/motion feed.
  - Melody-sensitive detection touchpoints: `src/audio/OnsetDetector.ts`, `src/audio/SpectralAnalyzer.ts`, `src/map/BeatMapper.ts`, `src/map/MapGenerator.ts`, `src/map/MapGeneratorClient.ts`, `src/map/MapWorker.ts`, `src/game/NoteManager.ts`.
  - Camera diversification touchpoints: `src/core/Renderer.ts` (`triggerCameraBeat`, `updateBeatPulse`, camera state), `src/main.ts` (`getCameraDriveAt`, `syncVideoCameraTransform`).
- External best-practice research completed from `bg_64956246`.
  - Prefer one authoritative song clock + bounded resync threshold.
  - Keep transform conversion path unified across world/grid/character/note space.
  - Keep timing windows explicit and layer lyric/melody weighting as modifiers.
  - Separate camera event layer from stabilization/damping layer.

## Metis Gap Review (applied)
- Add Wave 0 baseline capture before edits.
- Explicitly lock guardrails to prevent scope creep (no new dependency, no renderer rewrite, no lyric/NLP subsystem).
- Add edge-case verification for pause/resume, frame hitching, no-video mode, and high refresh rates.
- Add metric-style acceptance criteria and baseline-vs-post thresholds.
- Ensure camera stream depends on flicker/grid stabilization outputs.

## Test Strategy Decision
- Infrastructure exists: **NO** (no test script/framework in `package.json`).
- User wants tests: **not explicitly requested**.
- Plan default: **automated verification without adding dependencies/files**.
- QA approach: `npm run build` + deterministic demo-track flow via browser automation steps + command-level diagnostics.

## Open Questions
- None blocking for plan generation.
- Defaults to disclose in summary:
  - Use `npm` scripts as canonical runtime.
  - Do not add test framework/dependencies in this scope.

## Scope Boundaries
- INCLUDE: only the four requested fix areas.
- EXCLUDE: feature additions beyond those four areas, dependency expansion unless unavoidable.
