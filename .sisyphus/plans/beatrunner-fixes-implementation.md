# BeatRunner Fix Plan (Flicker + Grid + Melody Detection + Camera)

## TL;DR

> **Quick Summary**: Stabilize render/compositing order to remove sky-blue flicker, bind floor-grid motion to the same world-time model as character/note motion, upgrade melody-sensitive onset-to-note mapping without new dependencies, and expand camera choreography with deterministic section-driven variation while preserving damping stability.
>
> **Deliverables**:
> - Flicker-free gameplay background/video compositing in play/pause/resume/interlude transitions.
> - Floor grid movement visually synchronized with world/note/character motion.
> - Improved lyric/melody-sensitive map detection from existing onset/spectral pipeline.
> - More varied camera behavior with bounded motion and no video/canvas desync.
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: Task 0 -> Task 1 -> Task 5 -> Task 6

---

## Context

### Original Request
Produce a precise implementation plan for these four BeatRunner fixes (no scope reduction):
1) remove sky-blue background flicker,
2) align floor grid with character/world,
3) improve lyric/melody-sensitive note detection,
4) diversify camera work.

Required output: parallel waves/dependencies, concrete file-level edits, verification checklist with commands, and risk notes.

### Interview/Research Summary
- Code evidence confirms high-impact touchpoints in `src/core/Renderer.ts`, `src/main.ts`, `src/core/Engine.ts`, `src/styles/index.css`, `src/game/Character.ts`, `src/game/NoteManager.ts`, `src/map/MapGenerator.ts`, `src/map/BeatMapper.ts`, `src/audio/OnsetDetector.ts`, `src/audio/SpectralAnalyzer.ts`.
- `src/core/Engine.ts` and `src/main.ts` both clear canvas each frame (`clearRect`), creating a compositing-order risk for flicker.
- Floor grid currently advances from parallax layer offset (`drawFloorGrid(...updatedLayers[3].offset)`), while note/character movement is time/speed-driven via different paths.
- Lyric parser does not exist in current codebase; melody sensitivity must come from existing multi-band onset + spectral features.
- `alignSmoothMelodyFlow` exists in `src/map/MapGenerator.ts` but is not invoked, indicating recoverable melody-flow logic.
- Camera stack is centralized and already sophisticated (`triggerCameraBeat`, `updateBeatPulse`, `getCameraDriveAt`, `syncVideoCameraTransform`), so diversification should extend this system rather than rewrite it.

### Metis Review Applied
- Added Wave 0 baseline/invariants before any fix stream.
- Locked scope guardrails to prevent expansion (no lyric/NLP subsystem, no renderer rewrite, no new deps/files unless unavoidable).
- Added edge-case coverage: pause/resume, interlude transitions, frame hitches, no-video mode.
- Forced camera stream to depend on compositing/grid stabilization outputs.

### Defaults Applied (Override if needed)
- Validation matrix default: desktop Chrome-class browser at 60Hz, plus frame-hitch simulation (artificial dt spike).
- Scoring invariance default: on deterministic demo-flow input, final accuracy delta <= 2.0 percentage points and max-combo delta <= 5% vs baseline.
- Camera scope default: render-only camera changes (no gameplay-affecting transforms).

---

## Work Objectives

### Core Objective
Deliver all four requested fixes with minimal churn by modifying existing renderer/map/camera pipelines and proving improvements with command-driven, agent-executable verification.

### Concrete Deliverables
- Deterministic render order and video-background synchronization updates in existing render stack files.
- World-synchronized floor grid phase shared with character/world timing path.
- Enhanced melody-aware onset scoring/snap/selection and note placement from current audio feature pipeline.
- Expanded section/phrase-aware camera variation with strict amplitude/damping clamps.
- Verification artifacts (terminal output + screenshots in `.sisyphus/evidence/`) for each fix stream.

### Definition of Done
- [ ] `npm run build` succeeds after each wave and at final integration.
- [ ] No sky-blue flicker observed in automated demo-track flow during play/pause/resume/interlude transitions.
- [ ] Grid/world alignment checks pass (grid phase progression remains consistent with note-speed/time progression).
- [ ] Melody-sensitive map generation yields higher mid/tonal alignment without density spikes beyond thresholds.
- [ ] Camera variation metrics show increased pattern diversity while staying within clamp bounds.

### Must Have
- Exactly the four requested fix areas.
- Parallel wave execution with explicit dependencies.
- Concrete file-level edit plan and command-level verification.
- No new dependencies/files unless unavoidable.

### Must NOT Have (Guardrails)
- No new library dependency or test framework setup in this scope.
- No new lyric parsing/NLP subsystem.
- No map format contract change in `src/map/MapData.ts`.
- No full renderer or camera architecture rewrite.
- No unrelated refactors outside listed files.

---

## Verification Strategy (MANDATORY)

### Test Decision
- **Infrastructure exists**: NO (`package.json` has no `test` script/framework).
- **User wants tests**: Not explicitly requested.
- **Framework**: none.
- **Chosen QA mode**: Automated verification only, using existing scripts + browser automation + runtime assertions.

### Automated Verification Only (No user intervention)

Global commands used in all waves:

```bash
node -e "const p=require('./package.json'); console.log(Object.keys(p.scripts).join(','))"
npm run build
```

Runtime verification session:

```bash
npm run dev
```

Browser automation (Playwright skill) for deterministic flow:
1. Open `http://localhost:5173`.
2. Enter song select and click `#btn-demo`.
3. Wait for gameplay render start.
4. Trigger pause/resume and interlude transitions.
5. Capture screenshots and evaluate runtime values via `page.evaluate(...)`.

Evidence path:
- `.sisyphus/evidence/task-1-flicker.png`
- `.sisyphus/evidence/task-2-grid-sync.png`
- `.sisyphus/evidence/task-5-camera-variation.png`

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (Start Immediately)
└── Task 0: Baseline metrics + invariants + command harness

Wave 1 (After Wave 0)
├── Task 1: Remove sky-blue flicker (render/compositing stabilization)
├── Task 2: Align floor grid with character/world timing model
└── Task 3: Improve lyric/melody-sensitive detection pipeline

Wave 2 (After Wave 1)
├── Task 4: Tune note-judgement coupling for melody-aware outputs (bounded)
└── Task 5: Diversify camera choreography with bounded stability

Wave 3 (After Wave 2)
└── Task 6: Cross-fix regression verification + risk sweep + final signoff

Critical Path: 0 -> 1 -> 5 -> 6
Parallel Speedup: ~35-45% vs sequential
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|----------------------|
| 0 | None | 1,2,3 | None |
| 1 | 0 | 5,6 | 2,3 |
| 2 | 0 | 5,6 | 1,3 |
| 3 | 0 | 4,6 | 1,2 |
| 4 | 3 | 6 | 5 |
| 5 | 1,2 | 6 | 4 |
| 6 | 1,2,4,5 | None | None |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 0 | 0 | `delegate_task(category="quick", load_skills=["frontend-ui-ux"], run_in_background=false)` |
| 1 | 1,2,3 | Run three parallel agents (`unspecified-high` for 1/3, `quick` for 2) |
| 2 | 4,5 | Parallel; 5 uses `visual-engineering`, 4 uses `unspecified-high` |
| 3 | 6 | Single integration/regression agent (`unspecified-high`) |

---

## TODOs

- [ ] 0. Establish baseline metrics and invariants

  **What to do**:
  - Record current behavior baseline for flicker/compositing, grid motion, note density/judgement profile, and camera amplitude.
  - Confirm script inventory and lock command set (`npm run build`, `npm run dev`).
  - Capture initial evidence screenshots and console diagnostics from demo track flow.

  **Must NOT do**:
  - Do not modify gameplay logic in this task.
  - Do not add any dependency/file for diagnostics.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: instrumentation/setup and reproducibility checks only.
  - **Skills**: `frontend-ui-ux`
    - `frontend-ui-ux`: useful for deterministic UI flow capture and screenshot consistency.
  - **Skills Evaluated but Omitted**:
    - `git-master`: no git-history/commit operation required for this task.

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 0
  - **Blocks**: 1, 2, 3
  - **Blocked By**: None

  **References**:
  - `package.json:6` - script inventory source (`dev`, `dev:client`, `dev:server`, `build`).
  - `src/ui/SongSelect.ts:88` - deterministic demo-track trigger (`#btn-demo`) for reproducible runs.
  - `src/main.ts:430` - demo-track generation/start path used for baseline reproducibility.

  **Acceptance Criteria**:
  - [ ] `node -e "const p=require('./package.json'); console.log(Object.keys(p.scripts).join(','))"` runs and output is recorded.
  - [ ] `npm run build` exits 0.
  - [ ] `npm run dev` serves app and Playwright can trigger `#btn-demo` flow.
  - [ ] Baseline screenshots saved under `.sisyphus/evidence/`.

  **Commit**: NO

---

- [ ] 1. Remove sky-blue background flicker (render/compositing stabilization)

  **What to do**:
  - Consolidate clear/compositing order so canvas is cleared exactly once in authoritative location.
  - Stabilize video background visibility/transform transitions to prevent transient fallback flashes.
  - Ensure theme-specific background branch does not momentarily expose meadow sky during video/bg state transitions.
  - Keep behavior consistent across play, pause, resume, and interlude entry/exit.

  **Concrete file-level edits**:
  - `src/core/Engine.ts`
    - Normalize frame clear responsibility (remove duplicate clear interaction with `main.ts`).
  - `src/main.ts`
    - Update `setVideoPausedVisual` and `syncVideoCameraTransform` transition rules to avoid abrupt visibility state flips.
    - Keep video iframe lifecycle and transform updates ordered relative to gameplay state changes.
  - `src/core/Renderer.ts`
    - Harden `renderBackground` video-theme branch and overlay alpha behavior to avoid transient sky-tone exposure.
  - `src/styles/index.css`
    - Refine `#video-background`/iframe compositing properties for stable transform/opacity behavior.

  **Must NOT do**:
  - No new overlay files/canvases.
  - No broad CSS redesign.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: multi-file render/compositing ordering with regression risk.
  - **Skills**: `frontend-ui-ux`
    - `frontend-ui-ux`: required for visual-layer compositing correctness and deterministic scene transitions.
  - **Skills Evaluated but Omitted**:
    - `playwright`: execution verification uses it later, but this task itself is code-side stabilization.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with 2, 3)
  - **Blocks**: 5, 6
  - **Blocked By**: 0

  **References**:
  - `src/core/Engine.ts:98` - engine-level `clearRect` in loop.
  - `src/main.ts:1002` - callback-level `clearRect` and transform reset.
  - `src/main.ts:92` - pause visibility toggle currently uses `visibility`.
  - `src/main.ts:98` - per-frame video transform sync.
  - `src/main.ts:664` - video iframe lifecycle init.
  - `src/core/Renderer.ts:89` - video background rendering branch.
  - `src/core/Renderer.ts:525` - meadow sky draw path (sky-blue tone source).
  - `src/styles/index.css:50` - video background transform/opacity/filter defaults.

  **Acceptance Criteria**:
  - [ ] `npm run build` exits 0.
  - [ ] Playwright flow: start demo -> pause -> resume -> wait 10s; transition screenshots contain no frame where sky-blue dominant pixels exceed 12% of frame area.
  - [ ] Video transform updates remain continuous (no rapid reset jitter across pause/resume).
  - [ ] No regression in no-video mode (`currentYoutubeUrl` absent) rendering.

  **Commit**: YES
  - Message: `fix(renderer): stabilize background compositing to eliminate flicker`
  - Files: `src/core/Engine.ts`, `src/main.ts`, `src/core/Renderer.ts`, `src/styles/index.css`
  - Pre-commit: `npm run build`

---

- [ ] 2. Align floor grid with character/world timing model

  **What to do**:
  - Replace purely parallax-driven floor-grid phase with world-time/speed-driven phase derived from gameplay timing.
  - Ensure floor details and grid perspective share the same phase source.
  - Keep character/world perception synchronized during interlude pauses and motion-guide transitions.

  **Concrete file-level edits**:
  - `src/core/Renderer.ts`
    - Introduce explicit world/grid phase state fed by gameplay time.
    - Update `drawFloorGrid` and meadow ground detail calls to consume world phase instead of raw layer offset.
  - `src/main.ts`
    - Feed renderer with world timing inputs each update tick (same timeline as note motion).
  - `src/game/Character.ts`
    - Apply minimal phase-aware run/footfall sync so character cadence visually matches grid drift.

  **Must NOT do**:
  - Do not alter lane positions or judge line constants.
  - Do not rewrite full character animation state machine.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: tightly scoped synchronization updates in existing symbols.
  - **Skills**: `frontend-ui-ux`
    - `frontend-ui-ux`: visual rhythm alignment and animation coherence.
  - **Skills Evaluated but Omitted**:
    - `ultrabrain`: not needed; no deep architecture change.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with 1, 3)
  - **Blocks**: 5, 6
  - **Blocked By**: 0

  **References**:
  - `src/core/Renderer.ts:198` - floor grid currently driven from layer offset.
  - `src/core/Renderer.ts:342` - floor-grid draw implementation.
  - `src/core/Renderer.ts:617` - meadow ground detail phase input.
  - `src/main.ts:955` - note update timing source.
  - `src/main.ts:966` - character motion-guide timing feed.
  - `src/game/NoteManager.ts:243` - note world speed source (`NOTE_SPEED_BASE * noteSpeed`).
  - `src/game/Character.ts:377` - motion guide handling used for sync.

  **Acceptance Criteria**:
  - [ ] `npm run build` exits 0.
  - [ ] During 20s demo-track run, grid drift direction/phase remains consistent with note travel direction and character run cadence.
  - [ ] Pause/interlude freezes and resumes preserve grid/world phase continuity (no jump backwards/forwards).

  **Commit**: YES
  - Message: `fix(world): synchronize floor grid phase with gameplay timing`
  - Files: `src/core/Renderer.ts`, `src/main.ts`, `src/game/Character.ts`
  - Pre-commit: `npm run build`

---

- [ ] 3. Improve lyric/melody-sensitive note detection in generation pipeline

  **What to do**:
  - Strengthen mid-band/tonal selection in onset scoring while preserving percussive clarity in drop/chorus sections.
  - Activate currently unused smooth-melody alignment logic where applicable.
  - Tighten snap-window behavior based on section energy and difficulty to reduce false positives in dense passages.
  - Keep total map density within bounded range (no runaway note inflation).

  **Concrete file-level edits**:
  - `src/audio/OnsetDetector.ts`
    - Adjust multi-band peak extraction sensitivity/windowing to improve vocal/melody event capture reliability.
  - `src/audio/SpectralAnalyzer.ts`
    - Refine tonal/transient feature usage consistency consumed downstream.
  - `src/map/BeatMapper.ts`
    - Rebalance `getSectionBandWeights` and `findNearbyOnset` scoring blend for melody-sensitive sections.
  - `src/map/MapGenerator.ts`
    - Integrate `alignSmoothMelodyFlow` into final note assembly path (currently defined but not called).
    - Apply bounded acceptance thresholds in `buildEnhancedMusicalOnsetTimeline` scoring/snap gates.
  - `src/map/SectionDetector.ts`
    - Keep section typing stable but tighten energy threshold usage if needed for melody gating consistency.
  - `src/map/MapGeneratorClient.ts` and `src/map/MapWorker.ts`
    - Preserve worker pipeline compatibility if generation signatures/options change.

  **Must NOT do**:
  - No explicit lyric parser/NLP addition.
  - No new map schema fields in `MapData`.
  - No difficulty rebalance outside melody-detection scope.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: cross-module audio-feature and mapping calibration with quality-risk coupling.
  - **Skills**: `frontend-ui-ux`
    - `frontend-ui-ux`: helps preserve player-facing rhythm readability while tuning detection.
  - **Skills Evaluated but Omitted**:
    - `artistry`: creative generation not needed; this is constrained algorithm tuning.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with 1, 2)
  - **Blocks**: 4, 6
  - **Blocked By**: 0

  **References**:
  - `src/audio/OnsetDetector.ts:99` - `detectOnsetsFromFlux` sensitivity split by band.
  - `src/audio/OnsetDetector.ts:251` - adaptive `findPeaks` implementation.
  - `src/audio/SpectralAnalyzer.ts` - tonal/percussive/transient profile generation.
  - `src/map/BeatMapper.ts:54` - section band-weight policy.
  - `src/map/BeatMapper.ts:185` - nearby onset scoring function.
  - `src/map/MapGenerator.ts:1579` - enhanced onset timeline builder.
  - `src/map/MapGenerator.ts:5161` - unused `alignSmoothMelodyFlow` to integrate.
  - `src/map/MapGeneratorClient.ts:125` - worker/client generation boundary.
  - `src/map/MapWorker.ts:48` - worker generation call contract.

  **Acceptance Criteria**:
  - [ ] `npm run build` exits 0.
  - [ ] Demo-track + one vocal-heavy input generate maps without error in worker and fallback paths.
  - [ ] Melody-sensitive sections show improved mid/tonal lane utilization without >15% total note-count inflation from baseline.
  - [ ] No intro/interlude overpopulation regressions.

  **Commit**: YES
  - Message: `fix(mapgen): improve melody-sensitive onset selection and smoothing`
  - Files: `src/audio/OnsetDetector.ts`, `src/audio/SpectralAnalyzer.ts`, `src/map/BeatMapper.ts`, `src/map/MapGenerator.ts`, `src/map/SectionDetector.ts`, `src/map/MapGeneratorClient.ts`, `src/map/MapWorker.ts`
  - Pre-commit: `npm run build`

---

- [ ] 4. Bound judgement coupling to melody-sensitive outputs

  **What to do**:
  - Keep explicit judgement windows stable, but apply bounded assist/timing scaling only where new melody-detected patterns would otherwise feel unfair.
  - Ensure changes remain difficulty-consistent and do not alter scoring model semantics.

  **Concrete file-level edits**:
  - `src/game/NoteManager.ts`
    - Calibrate long-start/burst/assist timing interactions against updated map output characteristics.
  - `src/utils/Constants.ts`
    - Adjust only if required for bounded timing tolerance consistency.

  **Must NOT do**:
  - No scoring formula rewrite.
  - No rank threshold changes in `ScoreManager`.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: high gameplay-feel sensitivity with potential scoring side effects.
  - **Skills**: `frontend-ui-ux`
    - `frontend-ui-ux`: ensures perceived fairness/readability while adjusting timing behavior.
  - **Skills Evaluated but Omitted**:
    - `git-master`: not relevant to implementation logic.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with 5)
  - **Blocks**: 6
  - **Blocked By**: 3

  **References**:
  - `src/game/NoteManager.ts:56` - long note/judgement timing constants.
  - `src/game/NoteManager.ts:159` - difficulty assist scaling.
  - `src/game/NoteManager.ts:691` - `tryJudge` candidate selection path.
  - `src/utils/Constants.ts:25` - judgement windows (`JUDGE_*`).

  **Acceptance Criteria**:
  - [ ] `npm run build` exits 0.
  - [ ] Deterministic run comparison (same scripted input): accuracy delta <= 2.0pp vs baseline.
  - [ ] Deterministic run comparison: max-combo delta <= 5% vs baseline.
  - [ ] Melody-focused section miss-count increase <= 3 vs baseline.

  **Commit**: YES
  - Message: `fix(judge): keep melody-focused timing fair within existing window model`
  - Files: `src/game/NoteManager.ts`, `src/utils/Constants.ts` (only if needed)
  - Pre-commit: `npm run build`

---

- [ ] 5. Diversify camera work with bounded stability

  **What to do**:
  - Add deterministic section/phrase variation modes to current camera motion synthesis (not random per-frame noise).
  - Preserve damping/clamps and recover-to-baseline behavior.
  - Keep video-background transform coupling aligned with camera variation outputs.

  **Concrete file-level edits**:
  - `src/core/Renderer.ts`
    - Extend camera synthesis in `updateBeatPulse` with additional section-aware variation terms and bounded mix rules.
    - Keep hard clamps for `cameraX/Y/Zoom/Tilt` and impulse decay.
  - `src/main.ts`
    - Extend `getCameraDriveAt` outputs for richer mode cues and pass through `setMusicDrive` path.
    - Update `syncVideoCameraTransform` scaling/translation mapping to track expanded camera space without mismatch.

  **Must NOT do**:
  - No camera timeline editor.
  - No gameplay-affecting transform changes.

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: camera choreography + stability is visual-system heavy.
  - **Skills**: `frontend-ui-ux`
    - `frontend-ui-ux`: choreographic variation with readability constraints.
  - **Skills Evaluated but Omitted**:
    - `artistry`: unconstrained creativity is not desired; bounded deterministic behavior is required.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with 4)
  - **Blocks**: 6
  - **Blocked By**: 1, 2

  **References**:
  - `src/core/Renderer.ts:900` - `triggerCameraBeat` impulse path.
  - `src/core/Renderer.ts:925` - `setMusicDrive` inputs.
  - `src/core/Renderer.ts:947` - camera synthesis and damping.
  - `src/main.ts:264` - section-based camera drive computation.
  - `src/main.ts:98` - video transform sync coupling.

  **Acceptance Criteria**:
  - [ ] `npm run build` exits 0.
  - [ ] Automated run shows >=3 distinct camera motion patterns across sections (intro/verse/drop/chorus where present).
  - [ ] Camera values stay within renderer clamp bounds and decay toward baseline within 1.2s after major hit clusters.
  - [ ] Video background remains visually coupled (no transform lag/pop against canvas camera movement).

  **Commit**: YES
  - Message: `feat(camera): add section-aware camera variation with stable damping`
  - Files: `src/core/Renderer.ts`, `src/main.ts`
  - Pre-commit: `npm run build`

---

- [ ] 6. Cross-fix regression sweep and final signoff

  **What to do**:
  - Run full command checklist and browser-automation suite.
  - Compare baseline vs final metrics and classify residual risk.
  - Confirm no new dependencies/files and no scope leakage.

  **Must NOT do**:
  - No additional feature edits in this task.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: final integration quality gate across all fix streams.
  - **Skills**: `frontend-ui-ux`
    - `frontend-ui-ux`: visual verification consistency for flicker/grid/camera checks.
  - **Skills Evaluated but Omitted**:
    - `dev-browser`: optional; not required if playwright skill already used in executor flow.

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: None
  - **Blocked By**: 1, 2, 4, 5

  **References**:
  - `src/main.ts:998` - render-path integration point.
  - `src/core/Renderer.ts:69` - background + camera + grid integration point.
  - `src/map/MapGenerator.ts:26` - map generation top-level output behavior.
  - `package.json:6` - final command inventory.

  **Acceptance Criteria**:
  - [ ] `npm run build` exits 0.
  - [ ] No dependency delta (`package.json`/`package-lock.json` unchanged unless explicitly justified).
  - [ ] Evidence package saved in `.sisyphus/evidence/` for all four requested fixes.
  - [ ] Risk log updated with residual items and mitigations.

  **Commit**: YES
  - Message: `chore(qa): finalize beatrunner fixpack verification`
  - Files: touched implementation files only
  - Pre-commit: `npm run build`

---

## Verification Checklist (Commands)

```bash
# 0) Script inventory and baseline
node -e "const p=require('./package.json'); console.log(Object.keys(p.scripts).join(','))"

# 1) Compile/build gate
npm run build

# 2) Runtime server for automation
npm run dev

# 3) (during automation) demo flow trigger element
# Use Playwright skill to click: #btn-demo

# 4) Optional safety check: ensure no new dependency added
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); console.log(Object.keys(p.dependencies||{}).length, Object.keys(p.devDependencies||{}).length)"
```

Playwright automation assertions (agent-executable):
1. Navigate to app, start demo track, wait for gameplay.
2. Trigger pause/resume, capture before/after screenshots.
3. Validate no full-frame sky-blue flash appears during transitions.
4. Capture grid/character frames and verify phase continuity through pause/interlude.
5. Observe camera value stability and pattern diversity during section progression.

---

## Risk Notes

1. **Render-order regression risk**
   - Risk: Fixing flicker could break layer compositing in non-video or non-meadow paths.
   - Mitigation: Verify both video and no-video flows in Wave 3 with screenshot evidence.

2. **Timing-model coupling risk**
   - Risk: Grid synchronization changes may alter perceived gameplay rhythm.
   - Mitigation: Tie grid phase to existing note timing model and keep lane/judge constants unchanged.

3. **Map density inflation risk**
   - Risk: Melody-sensitive boosts may over-generate notes.
   - Mitigation: Enforce bounded note-count delta threshold and section-aware gating.

4. **Camera-video desync risk**
   - Risk: More camera variation can desync iframe transform from canvas movement.
   - Mitigation: Keep single camera source of truth and clamp transform mapping in `syncVideoCameraTransform`.

5. **Performance risk on low-tier devices**
   - Risk: Added camera/detection complexity can increase frame variability.
   - Mitigation: Preserve existing damping/clamp constraints and avoid additional dependency/runtime layers.

---

## Success Criteria

### Final Checklist
- [ ] All four requested fix streams implemented (no scope reduction).
- [ ] No new dependency or file introduced unless explicitly justified.
- [ ] Build passes and automated runtime checks complete.
- [ ] Evidence captured for flicker, grid alignment, melody detection quality, and camera diversity.
- [ ] Residual risks documented with mitigation notes.
