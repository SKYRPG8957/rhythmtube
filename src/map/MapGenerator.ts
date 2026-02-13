/* === 맵 제너레이터 - 전체 파이프라인 오케스트레이터 === */
import type { MapData, ProgressCallback, NoteData, VisualTheme } from './MapData';
import type { Difficulty } from '../utils/Constants';
import { MIN_HOLD_DURATION_SEC, MIN_SLIDE_DURATION_SEC } from '../utils/Constants';
import { detectBPM, generateBeatPositions } from '../audio/BPMDetector';
import type { OnsetResult, OnsetFluxProfile } from '../audio/OnsetDetector';
import { computeOnsetFlux, detectOnsetsFromFlux, quantizeOnsets } from '../audio/OnsetDetector';
import { analyzeSpectralProfiles } from '../audio/SpectralAnalyzer';
import type { SpectralProfile } from '../audio/SpectralAnalyzer';
import { detectSections } from './SectionDetector';
import { mapBeatsToNotes } from './BeatMapper';
import type { BeatMapSongFeatures } from './BeatMapper';
import { scaleDifficulty } from './DifficultyScaler';
import { lerp } from '../utils/MathUtils';

const MAPGEN_DEBUG = false;
const MAPGEN_MAX_ANALYSIS = true;
const mapgenLog = (...args: unknown[]): void => {
    if (!MAPGEN_DEBUG) return;
    console.log(...args);
};

/**
 * 오디오 버퍼 → 완성 맵 데이터 생성
 */
export const generateMap = async (
    buffer: AudioBuffer,
    difficulty: Difficulty,
    onProgress?: ProgressCallback
): Promise<MapData> => {
    const duration = buffer.duration;
    let resolvedBpm = 120;
    const stageDurations: Record<string, number> = {};
    let stageClock = performance.now();
    const markStage = (name: string): void => {
        const now = performance.now();
        stageDurations[name] = (stageDurations[name] ?? 0) + (now - stageClock);
        stageClock = now;
    };
    const perf = getRuntimePerfProfile();
    const qualityFirst = MAPGEN_MAX_ANALYSIS
        ? perf.tier !== 'low' && duration <= 1200
        : (perf.tier === 'high' || perf.qualityBias >= 0.68) && duration <= 660;
    const qualityAggressive = MAPGEN_MAX_ANALYSIS
        ? (perf.tier !== 'low' || perf.cores >= 6) && duration <= 1500
        : perf.qualityBias >= 0.44 && duration <= 900;
    const perfBoost = clamp01(
        Math.max(0, (perf.cores - 4) / 8) * 0.52
        + Math.max(0, (perf.memoryGb - 4) / 12) * 0.33
        + perf.qualityBias * 0.15
    );

    // 1. BPM 감지 + 첫 비트 오프셋
    onProgress?.('BPM 분석 중...', 0.1);
    const bpmResult = detectBPM(buffer);
    resolvedBpm = bpmResult.bpm;
    await yieldToMain();
    markStage('bpm');

    // 2. Beat 위치 생성 (오프셋 적용!)
    onProgress?.('비트 그리드 생성 중...', 0.2);
    let beatPositions = generateBeatPositions(
        resolvedBpm,
        duration,
        bpmResult.firstBeatOffset
    );
    await yieldToMain();
    markStage('beatGrid');

    // 3. Onset 감지 (실제 FFT 기반 스펙트럼 플럭스)
    onProgress?.('음파 분석 중... (Onset Detection)', 0.3);
    await yieldToMain();
    let onsetResult: OnsetResult;
    let onsetFluxProfile: OnsetFluxProfile | null = null;
    try {
        const adaptive = detectOnsetsAdaptive(buffer, difficulty, (subProgress) => {
            const p = 0.3 + Math.max(0, Math.min(1, subProgress)) * 0.08;
            onProgress?.('음파 분석 중... (Onset Detection)', p);
        });
        onsetResult = adaptive.result;
        onsetFluxProfile = adaptive.fullFlux;
    } catch {
        // onset 감지 실패 시 빈 결과
        onsetResult = {
            onsets: [], strengths: [],
            lowOnsets: [], lowStrengths: [],
            midOnsets: [], midStrengths: [],
            highOnsets: [], highStrengths: []
        };
        onsetFluxProfile = null;
    }
    await yieldToMain();
    markStage('onset');

    // 3.5 BPM 오프셋 재보정 (onset 기반)
    const tempoRefined = selectBestTempoGrid(
        resolvedBpm,
        bpmResult.firstBeatOffset,
        onsetResult.onsets,
        onsetResult.strengths
    );
    resolvedBpm = tempoRefined.bpm;
    const refinedOffsetRaw = refineBeatOffset(
        tempoRefined.offset,
        resolvedBpm,
        onsetResult.onsets,
        onsetResult.strengths
    );
    const refinedOffset = alignOffsetToDownbeats(
        refinedOffsetRaw,
        resolvedBpm,
        onsetResult.lowOnsets.length >= 8 ? onsetResult.lowOnsets : onsetResult.onsets,
        onsetResult.lowStrengths.length >= 8 ? onsetResult.lowStrengths : onsetResult.strengths
    );
    const tempoSegments = buildAdaptiveTempoSegments(
        onsetResult.onsets,
        onsetResult.strengths,
        resolvedBpm,
        duration
    );
    const adaptiveBeats = generateAdaptiveBeatPositions(
        tempoSegments,
        duration,
        refinedOffset
    );
    beatPositions = adaptiveBeats.length >= 12
        ? adaptiveBeats
        : generateBeatPositions(resolvedBpm, duration, refinedOffset);
    if (tempoSegments.length > 0) {
        const meanTempo = avg(tempoSegments.map(s => s.bpm), resolvedBpm);
        if (Number.isFinite(meanTempo) && meanTempo > 0) {
            resolvedBpm = Math.max(60, Math.min(200, meanTempo));
        }
    }

    // 비트가 없으면 폴백 (120 BPM 기본 그리드)
    const safeBeatPositions = beatPositions.length > 0
        ? beatPositions
        : generateBeatPositions(120, duration, 0);

    // 정밀 분석용 8분음표 그리드
    const analysisGrid = beatPositions.length > 0
        ? buildHalfBeatGrid(beatPositions, resolvedBpm, duration)
        : generateBeatPositions(120, duration, 0, 2);

    // 4. Onset 퀀타이즈 (8분음표 그리드에 스냅 - 정밀도 향상)
    onProgress?.('비트 정렬 중...', 0.4);
    const quantized = onsetResult.onsets.length > 0
        // safeBeatPositions 대신 analysisGrid 사용
        ? quantizeOnsets(onsetResult.onsets, analysisGrid)
        : [];
    await yieldToMain();

    // 5. 스펙트럼 프로파일 (8분음표 단위로 정밀 분석)
    onProgress?.('주파수 분석 중...', 0.5);
    await yieldToMain();
    // 긴 곡은 샘플링 간격을 늘려 계산 시간을 줄인다.
    const baseStride = qualityFirst
        ? 1
        : duration >= 360
            ? 4
            : duration >= 240
                ? 3
                : duration >= 160
                    ? 2
                    : 1;
    const detailStrideAdjust = perf.tier === 'high'
        ? -Math.round(perfBoost * 2)
        : perf.tier === 'low'
            ? 1
            : 0;
    const spectralStride = Math.max(
        1,
        baseStride
        + (qualityFirst ? 0 : perf.tier === 'low' ? 2 : perf.tier === 'mid' ? 1 : 0)
        + detailStrideAdjust
        - (qualityAggressive ? 1 : 0)
    );
    const rawSamplePoints = spectralStride === 1
        ? analysisGrid
        : analysisGrid.filter((_, idx) => idx % spectralStride === 0);
    const spectralCapBase = qualityFirst ? 6000 : perf.tier === 'low' ? 800 : perf.tier === 'mid' ? 2000 : 3600;
    const spectralCap = Math.max(
        480,
        Math.round(
            spectralCapBase
            * (
                1
                + perfBoost * (
                    qualityFirst
                        ? 0.85
                        : perf.tier === 'high'
                            ? 0.58
                            : 0.28
                )
            )
        )
    ) + Math.round(perf.qualityBias * (qualityFirst ? 520 : 260))
        + (qualityAggressive ? 420 : 0);
    const capStep = Math.max(1, Math.ceil(rawSamplePoints.length / spectralCap));
    const samplePoints = capStep === 1
        ? rawSamplePoints
        : rawSamplePoints.filter((_, idx) => idx % capStep === 0);
    let spectralProfiles: ReturnType<typeof analyzeSpectralProfiles>;
    try {
        const forceTrueSpectral = (perf.tier === 'high' && duration <= 1080)
            || (qualityAggressive && duration <= 780);
        const useFluxDerivedSpectral = !!onsetFluxProfile
            && onsetFluxProfile.lowEnergy.length > 0
            && onsetFluxProfile.midEnergy.length > 0
            && onsetFluxProfile.highEnergy.length > 0
            && !qualityFirst
            && !MAPGEN_MAX_ANALYSIS
            && !forceTrueSpectral
            && !qualityAggressive
            && (
                perf.tier === 'low'
                || (duration >= 900 && perf.qualityBias < 0.5)
            );
        if (useFluxDerivedSpectral && onsetFluxProfile) {
            spectralProfiles = buildSpectralProfilesFromFlux(onsetFluxProfile, samplePoints);
        } else {
            const primaryFftSize = qualityFirst
                ? 8192
                : perf.tier === 'low'
                ? 2048
                : perf.tier === 'mid'
                    ? (qualityAggressive ? 8192 : 4096)
                    : duration >= 420 && !qualityAggressive
                        ? 4096
                        : 8192;
            const primaryProfiles = analyzeSpectralProfiles(buffer, samplePoints, { fftSize: primaryFftSize });
            const shouldDualSpectral = (MAPGEN_MAX_ANALYSIS || qualityAggressive)
                && perf.tier !== 'low'
                && samplePoints.length >= 56;
            if (shouldDualSpectral) {
                const secondaryFftSize = primaryFftSize >= 8192 ? 4096 : primaryFftSize === 4096 ? 2048 : 4096;
                const secondaryProfiles = analyzeSpectralProfiles(buffer, samplePoints, { fftSize: secondaryFftSize });
                const primaryWeight = qualityFirst ? 0.62 : 0.56;
                spectralProfiles = blendSpectralProfiles(primaryProfiles, secondaryProfiles, primaryWeight);
            } else {
                spectralProfiles = primaryProfiles;
            }
        }
    } catch {
        spectralProfiles = [];
    }
    await yieldToMain();
    markStage('spectral');

    // 6. 섹션 감지
    onProgress?.('곡 구조 분석 중...', 0.65);
    await yieldToMain();
    let sections: ReturnType<typeof detectSections>;
    try {
        sections = detectSections(buffer);
    } catch {
        sections = [{ startTime: 0, endTime: duration, type: 'verse', avgEnergy: 0.5 }];
    }
    await yieldToMain();
    markStage('sections');

    // 6. 노트 생성 준비
    onProgress?.('노트 배치 중...', 0.7);
    await yieldToMain();

    // 7. Onset 중심 노트 매핑
    onProgress?.('노트 배치 중... (Instrument Separated)', 0.8);
    await yieldToMain();

    // [DIAGNOSTIC] 파이프라인 각 단계 노트 수 추적
    const totalMultiBandOnsets = onsetResult.lowOnsets.length + onsetResult.midOnsets.length + onsetResult.highOnsets.length;
    mapgenLog(`[MapGen] BPM: ${resolvedBpm}, Duration: ${duration.toFixed(1)}s`);
    mapgenLog(`[MapGen] Onsets - Total: ${onsetResult.onsets.length}, Low: ${onsetResult.lowOnsets.length}, Mid: ${onsetResult.midOnsets.length}, High: ${onsetResult.highOnsets.length}`);
    mapgenLog(`[MapGen] Quantized: ${quantized.length}, BeatPositions: ${safeBeatPositions.length}`);

    // onset이 너무 적으면 비트 기반 폴백
    const useOnsets = totalMultiBandOnsets >= 10 || onsetResult.onsets.length >= 10;
    // BeatMapper 입력은 quantized onset을 우선 사용 (싱크 안정화)
    let onsetTimes = useOnsets
        ? (quantized.length >= Math.max(8, Math.floor(onsetResult.onsets.length * 0.4))
            ? [...quantized]
            : [...onsetResult.onsets])
        : [...safeBeatPositions];
    let onsetStrengths = useOnsets
        ? mapStrengthsToTimes(onsetTimes, onsetResult.onsets, onsetResult.strengths)
        : safeBeatPositions.map(() => 0.5);

    // [FIX] onset이 너무 적으면 멀티밴드 데이터도 비워서 BeatMapper가 Fallback 경로를 타도록
    const safeLow = useOnsets ? onsetResult.lowOnsets : [];
    const safeMid = useOnsets ? onsetResult.midOnsets : [];
    const safeHigh = useOnsets ? onsetResult.highOnsets : [];
    const safeLowStrengths = useOnsets ? onsetResult.lowStrengths : [];
    const safeMidStrengths = useOnsets ? onsetResult.midStrengths : [];
    const safeHighStrengths = useOnsets ? onsetResult.highStrengths : [];
    const songFeatures = summarizeSongFeatures(
        onsetResult,
        spectralProfiles,
        sections,
        resolvedBpm
    );
    const enhancedOnsets = buildEnhancedMusicalOnsetTimeline(
        onsetResult,
        onsetTimes,
        onsetStrengths,
        safeBeatPositions,
        sections,
        spectralProfiles,
        resolvedBpm,
        difficulty,
        songFeatures,
        perf
    );
    if (enhancedOnsets.times.length >= Math.max(12, Math.floor(onsetTimes.length * 0.42))) {
        onsetTimes = enhancedOnsets.times;
        onsetStrengths = enhancedOnsets.strengths;
    }
    mapgenLog(`[MapGen] useOnsets: ${useOnsets} (멀티밴드: ${totalMultiBandOnsets}, quantized: ${quantized.length})`);
    mapgenLog(`[MapGen] songFeatures drive:${songFeatures.driveScore.toFixed(2)} perc:${songFeatures.percussiveFocus.toFixed(2)} melodic:${songFeatures.melodicFocus.toFixed(2)} bass:${songFeatures.bassWeight.toFixed(2)} sustain:${songFeatures.sustainedFocus.toFixed(2)} calm:${songFeatures.calmConfidence.toFixed(2)} introQuiet:${songFeatures.introQuietness.toFixed(2)}`);

    const rawNotes = mapBeatsToNotes(
        safeBeatPositions,
        sections,
        spectralProfiles,
        onsetTimes, // Legacy (또는 BeatPositions 기반)
        onsetStrengths,
        safeLow,   // [FIX] 조건부 멀티밴드
        safeMid,
        safeHigh,
        safeLowStrengths,
        safeMidStrengths,
        safeHighStrengths,
        resolvedBpm,
        songFeatures
    );
    mapgenLog(`[MapGen] rawNotes: ${rawNotes.length}`);
    await yieldToMain();

    // 8. 난이도 스케일링
    onProgress?.('난이도 조정 중...', 0.9);
    const scaledNotes = scaleDifficulty(rawNotes, difficulty, resolvedBpm);

    const onsetReliability = clamp01(
        onsetTimes.length / Math.max(20, duration * (difficulty === 'easy' ? 1.4 : difficulty === 'normal' ? 1.8 : difficulty === 'hard' ? 2.1 : 2.4))
    );
    const multiBandDensity = clamp01(
        (safeLow.length + safeMid.length + safeHigh.length)
        / Math.max(18, duration * 2.2)
    );
    const allowEnrichedCandidate = difficulty === 'expert'
        ? (onsetReliability >= 0.12 || multiBandDensity >= 0.22 || onsetTimes.length >= 8)
        : (onsetReliability >= 0.22 || multiBandDensity >= 0.34);

    const finalizeCandidate = (seedNotes: readonly NoteData[]): NoteData[] => {
        const synced = alignNotesToMusicGrid(
            seedNotes,
            onsetTimes,
            safeBeatPositions,
            resolvedBpm,
            difficulty
        );
        const playable = enforcePhysicalPlayability(
            synced,
            safeBeatPositions,
            resolvedBpm,
            difficulty
        );
        const collisionResolved = resolveLongNoteCollisions(playable, resolvedBpm);
        const visualClean = resolveVisualNoteOverlaps(collisionResolved, resolvedBpm, difficulty);
        const rhythmSynced = polishRhythmSyncByStrongOnsets(
            visualClean,
            onsetTimes,
            onsetStrengths,
            resolvedBpm,
            difficulty
        );
        const qualityStable = stabilizeGenerationQuality(
            rhythmSynced,
            onsetTimes,
            onsetStrengths,
            safeBeatPositions,
            sections,
            resolvedBpm,
            difficulty,
            songFeatures
        );
        const audioAnchored = enforceFinalMusicAnchoring(
            qualityStable,
            onsetTimes,
            onsetStrengths,
            safeBeatPositions,
            sections,
            resolvedBpm,
            difficulty,
            songFeatures
        );
        const burstInjected = injectBurstBreakerNotes(
            audioAnchored,
            sections,
            spectralProfiles,
            onsetTimes,
            onsetStrengths,
            resolvedBpm,
            difficulty,
            songFeatures
        );
        const burstSafe = enforceBurstNonOverlap(burstInjected, resolvedBpm);
        const sanitized = sanitizeFinalLongNotes(burstSafe, resolvedBpm);
        // 최종 롱노트 겹침/시각 충돌 정리 (이전 단계에서 재도입된 겹침 해소)
        const finalCollisionResolved = resolveLongNoteCollisions(sanitized, resolvedBpm);
        const finalVisualClean = resolveVisualNoteOverlaps(finalCollisionResolved, resolvedBpm, difficulty);
        const finalNested = pruneImpossibleNestedNotes(finalVisualClean, resolvedBpm);
        const strictLongClean = enforceStrictLongBodyExclusion(finalNested, resolvedBpm, difficulty);
        return dedupeNotes(strictLongClean, 0.034);
    };

    // Candidate A: 보수형 (싱크 안정)
    const conservativeFinal = finalizeCandidate(scaledNotes);

    // Candidate B: 섹션/온셋 강조형 (신뢰도 충분할 때만)
    let enrichedFinal = conservativeFinal;
    if (allowEnrichedCandidate) {
        const sectionSelected = applySectionRhythmSourceSelection(
            scaledNotes,
            sections,
            safeBeatPositions,
            onsetTimes,
            onsetStrengths,
            safeLow,
            safeLowStrengths,
            safeMid,
            safeMidStrengths,
            safeHigh,
            safeHighStrengths,
            resolvedBpm,
            difficulty,
            songFeatures
        );
        const anchored = injectMusicAnchoredAccents(
            sectionSelected,
            onsetTimes,
            onsetStrengths,
            safeBeatPositions,
            sections,
            resolvedBpm,
            difficulty
        );
        const detailedMusicalSeed = applyDetailedMusicalPointMapping(
            anchored,
            sections,
            safeBeatPositions,
            spectralProfiles,
            onsetTimes,
            onsetStrengths,
            safeLow,
            safeLowStrengths,
            safeMid,
            safeMidStrengths,
            safeHigh,
            safeHighStrengths,
            resolvedBpm,
            difficulty,
            songFeatures
        );
        enrichedFinal = finalizeCandidate(detailedMusicalSeed);
    }

    const conservativeScore = evaluateMapCandidateQuality(
        conservativeFinal,
        onsetTimes,
        onsetStrengths,
        sections,
        resolvedBpm,
        difficulty,
        songFeatures
    );
    const enrichedScore = allowEnrichedCandidate
        ? evaluateMapCandidateQuality(
            enrichedFinal,
            onsetTimes,
            onsetStrengths,
            sections,
            resolvedBpm,
            difficulty,
            songFeatures
        )
        : -Infinity;

    const energeticThemeBias = songFeatures.driveScore >= 0.58
        || songFeatures.percussiveFocus >= 0.6
        || songFeatures.bassWeight >= 0.58;
    const preferEnrichedForEnergy = allowEnrichedCandidate
        && energeticThemeBias
        && enrichedFinal.length >= conservativeFinal.length * 0.82
        && enrichedScore >= conservativeScore - 0.12;
    const useEnriched = preferEnrichedForEnergy || (allowEnrichedCandidate
        && (
            enrichedScore >= conservativeScore - 0.045
            || (enrichedFinal.length > conservativeFinal.length * 0.92 && enrichedScore >= conservativeScore - 0.06)
        ));
    let finalizedNotes = useEnriched ? enrichedFinal : conservativeFinal;
    finalizedNotes = applyEnergeticAccentPass(
        finalizedNotes,
        onsetTimes,
        onsetStrengths,
        safeBeatPositions,
        sections,
        resolvedBpm,
        difficulty,
        songFeatures
    );
    finalizedNotes = enforceSectionEnergyFlow(
        finalizedNotes,
        onsetTimes,
        onsetStrengths,
        safeBeatPositions,
        sections,
        resolvedBpm,
        difficulty,
        songFeatures
    );
    finalizedNotes = runHolisticBalanceLoop(
        finalizedNotes,
        onsetTimes,
        onsetStrengths,
        safeBeatPositions,
        sections,
        resolvedBpm,
        difficulty,
        songFeatures
    );
    // 최종 밀도 보정: 홀리스틱 루프 이후에도 구간 체감이 비면 난이도 목표까지 한 번 더 보강.
    finalizedNotes = ensureMinimumDensity(
        finalizedNotes,
        safeBeatPositions,
        sections,
        resolvedBpm,
        difficulty,
        songFeatures
    );
    finalizedNotes = pruneImpossibleNestedNotes(resolveLongNoteCollisions(finalizedNotes, resolvedBpm), resolvedBpm);
    let finalQualityScore = evaluateMapCandidateQuality(
        finalizedNotes,
        onsetTimes,
        onsetStrengths,
        sections,
        resolvedBpm,
        difficulty,
        songFeatures
    );
    const qualityFloorByDiff: Record<Difficulty, number> = {
        easy: 0.46,
        normal: 0.5,
        hard: 0.53,
        expert: 0.55,
    };
    const qualityLift = clamp01(
        songFeatures.driveScore * 0.42
        + songFeatures.dynamicRange * 0.3
        + songFeatures.percussiveFocus * 0.2
        - songFeatures.calmConfidence * 0.16
    );
    const qualityFloor = qualityFloorByDiff[difficulty] + qualityLift * 0.07;
    if (finalQualityScore < qualityFloor) {
        const rescueSeed = buildEmergencyMusicalNotes(
            duration,
            resolvedBpm,
            difficulty,
            safeBeatPositions,
            sections,
            onsetTimes,
            onsetStrengths,
            songFeatures,
            Math.max(10, Math.floor(duration * (difficulty === 'easy' ? 0.07 : difficulty === 'normal' ? 0.09 : difficulty === 'hard' ? 0.11 : 0.13)))
        );
        const rescueAnchored = injectMusicAnchoredAccents(
            rescueSeed,
            onsetTimes,
            onsetStrengths,
            safeBeatPositions,
            sections,
            resolvedBpm,
            difficulty
        );
        const rescueDetailed = applyDetailedMusicalPointMapping(
            rescueAnchored,
            sections,
            safeBeatPositions,
            spectralProfiles,
            onsetTimes,
            onsetStrengths,
            safeLow,
            safeLowStrengths,
            safeMid,
            safeMidStrengths,
            safeHigh,
            safeHighStrengths,
            resolvedBpm,
            difficulty,
            songFeatures
        );
        const rescueFinal = finalizeCandidate(rescueDetailed);
        const rescueQualityScore = evaluateMapCandidateQuality(
            rescueFinal,
            onsetTimes,
            onsetStrengths,
            sections,
            resolvedBpm,
            difficulty,
            songFeatures
        );
        if (
            rescueQualityScore >= finalQualityScore + 0.03
            || (rescueFinal.length > finalizedNotes.length * 1.18 && rescueQualityScore >= finalQualityScore - 0.02)
        ) {
            finalizedNotes = enforceSectionEnergyFlow(
                rescueFinal,
                onsetTimes,
                onsetStrengths,
                safeBeatPositions,
                sections,
                resolvedBpm,
                difficulty,
                songFeatures
            );
            finalizedNotes = ensureMinimumDensity(
                finalizedNotes,
                safeBeatPositions,
                sections,
                resolvedBpm,
                difficulty,
                songFeatures
            );
            finalizedNotes = pruneImpossibleNestedNotes(resolveLongNoteCollisions(finalizedNotes, resolvedBpm), resolvedBpm);
            finalQualityScore = evaluateMapCandidateQuality(
                finalizedNotes,
                onsetTimes,
                onsetStrengths,
                sections,
                resolvedBpm,
                difficulty,
                songFeatures
            );
        }
    }
    mapgenLog(`[MapGen] candidateScore conservative:${conservativeScore.toFixed(3)} enriched:${isFinite(enrichedScore) ? enrichedScore.toFixed(3) : 'n/a'} final:${finalQualityScore.toFixed(3)} floor:${qualityFloor.toFixed(3)} selected:${useEnriched ? 'enriched' : 'conservative'} onsetReliability:${onsetReliability.toFixed(2)}`);

    finalizedNotes = enforceDifficultyNoteCountBand(
        finalizedNotes,
        duration,
        resolvedBpm,
        difficulty,
        safeBeatPositions,
        sections,
        onsetTimes,
        onsetStrengths,
        songFeatures
    );

    let visualTheme = selectVisualTheme(
        resolvedBpm,
        sections,
        spectralProfiles,
        songFeatures
    );
    visualTheme = enforceVisualThemeConsistency(
        visualTheme,
        finalizedNotes,
        duration,
        resolvedBpm,
        sections,
        songFeatures
    );
    const slideCount = finalizedNotes.filter(n => n.type === 'slide').length;
    const straightSlideCount = finalizedNotes.filter(n => n.type === 'slide' && resolveSlideTargetLane(n) === n.lane).length;
    const diagonalSlideCount = Math.max(0, slideCount - straightSlideCount);
    const holdCount = finalizedNotes.filter(n => n.type === 'hold').length;
    const burstCount = finalizedNotes.filter(n => n.type === 'burst').length;
    mapgenLog(`[MapGen] raw: ${rawNotes.length}, scaled: ${scaledNotes.length}, final: ${finalizedNotes.length} (slides:${slideCount}, straight:${straightSlideCount}, diagonal:${diagonalSlideCount}, holds:${holdCount}, bursts:${burstCount}) diff:${difficulty}`);
    markStage('compose');
    // 10. [CRITICAL] EMERGENCY RESCUE
    // 만약 여기까지 왔는데도 노트가 너무 적으면, 강제로 생성한다.
    const emergencyFloorByDiff: Record<Difficulty, number> = {
        easy: Math.max(10, Math.floor(duration * 0.09)),
        normal: Math.max(14, Math.floor(duration * 0.125)),
        hard: Math.max(18, Math.floor(duration * 0.16)),
        expert: Math.max(22, Math.floor(duration * 0.2)),
    };
    const emergencyFloor = emergencyFloorByDiff[difficulty];
    if (finalizedNotes.length < emergencyFloor) {
        console.warn(">> EMERGENCY MAP GENERATION ACTIVATED <<");
        const emergencyNotes = buildEmergencyMusicalNotes(
            duration,
            resolvedBpm,
            difficulty,
            safeBeatPositions,
            sections,
            onsetTimes,
            onsetStrengths,
            songFeatures,
            emergencyFloor
        );
        if (emergencyNotes.length === 0) {
            const beatInterval = 60 / resolvedBpm;
            const fallbackStart = Math.max(0.35, Math.min(duration * 0.2, 1.2));
            for (let i = 0; i < 8; i++) {
                const tt = fallbackStart + i * beatInterval;
                if (tt >= duration) break;
                emergencyNotes.push({
                    time: tt,
                    lane: i % 2 === 0 ? 1 : 0,
                    type: 'tap',
                    strength: 0.72,
                });
            }
        }
        mapgenLog('[MapGen][timing-ms]', Object.fromEntries(Object.entries(stageDurations).map(([k, v]) => [k, Math.round(v)])));
        // const로 선언된 finalNotes를 재할당할 수 없으므로 새로운 변수를 리턴에 사용하거나
        // finalNotes를 let으로 변경해야 함. 여기서는 리턴 객체에서 덮어쓰기.
        return {
            bpm: resolvedBpm,
            duration,
            difficulty,
            visualTheme,
            notes: emergencyNotes,
            sections,
            beatPositions: safeBeatPositions,
            totalNotes: emergencyNotes.length,
        };
    }

    await yieldToMain();

    onProgress?.('맵 생성 완료!', 1.0);
    mapgenLog('[MapGen][timing-ms]', Object.fromEntries(Object.entries(stageDurations).map(([k, v]) => [k, Math.round(v)])));

    return {
        bpm: resolvedBpm,
        duration,
        difficulty,
        visualTheme,
        notes: finalizedNotes,
        sections,
        beatPositions: safeBeatPositions,
        totalNotes: finalizedNotes.length,
    };
};

const buildSpectralProfilesFromFlux = (
    fluxProfile: OnsetFluxProfile,
    samplePoints: readonly number[]
): SpectralProfile[] => {
    if (samplePoints.length === 0) return [];
    const frameCount = Math.min(
        fluxProfile.lowFlux.length,
        fluxProfile.midFlux.length,
        fluxProfile.highFlux.length,
        fluxProfile.lowEnergy.length,
        fluxProfile.midEnergy.length,
        fluxProfile.highEnergy.length
    );
    if (frameCount <= 0 || fluxProfile.framerate <= 0) return [];

    let fluxMax = 0;
    let fluxMean = 0;
    for (let i = 0; i < frameCount; i++) {
        const f = fluxProfile.lowFlux[i] + fluxProfile.midFlux[i] + fluxProfile.highFlux[i];
        fluxMean += f;
        if (f > fluxMax) fluxMax = f;
    }
    fluxMean /= frameCount;
    const fluxScale = 1 / Math.max(1e-6, Math.max(fluxMax * 0.42, fluxMean * 2.2));

    const out: SpectralProfile[] = [];
    let prevEnergy = 0;
    for (const tRaw of samplePoints) {
        const t = Math.max(0, tRaw);
        const idxRaw = Math.round((t - fluxProfile.startTimeSec) * fluxProfile.framerate);
        const idx = Math.max(0, Math.min(frameCount - 1, idxRaw));
        const prevIdx = Math.max(0, idx - 1);

        const low = Math.max(1e-7, fluxProfile.lowEnergy[idx]);
        const mid = Math.max(1e-7, fluxProfile.midEnergy[idx]);
        const high = Math.max(1e-7, fluxProfile.highEnergy[idx]);
        const total = low + mid + high;

        const lowRatio = low / total;
        const midRatio = mid / total;
        const highRatio = high / total;
        const fluxNow = (fluxProfile.lowFlux[idx] + fluxProfile.midFlux[idx] + fluxProfile.highFlux[idx]) * fluxScale;

        const energy = total;
        const energyRise = Math.max(0, energy - prevEnergy);
        const bandRise = Math.max(
            0,
            (fluxProfile.highEnergy[idx] - fluxProfile.highEnergy[prevIdx]) * 0.72
            + (fluxProfile.midEnergy[idx] - fluxProfile.midEnergy[prevIdx]) * 0.38
            + (fluxProfile.lowEnergy[idx] - fluxProfile.lowEnergy[prevIdx]) * 0.16
        );
        const transient = clamp01(
            ((energyRise * 1.35 + bandRise * 0.62) / (energy * 1.04 + 1e-5)) * 0.72
            + fluxNow * 0.45
        );
        const tonal = clamp01(
            midRatio * 0.62
            + (1 - Math.abs(midRatio - lowRatio)) * 0.18
            + (1 - Math.abs(midRatio - highRatio)) * 0.2
        );
        const percussive = clamp01(highRatio * 0.56 + transient * 0.44);
        const brightness = clamp01((mid * 0.3 + high * 0.7) / total);

        out.push({
            time: t,
            low,
            mid,
            high,
            energy,
            brightness,
            transient,
            tonal,
            percussive,
        });
        prevEnergy = energy;
    }

    return out;
};

const blendSpectralProfiles = (
    primary: readonly SpectralProfile[],
    secondary: readonly SpectralProfile[],
    primaryWeight = 0.58
): SpectralProfile[] => {
    if (primary.length === 0) return [...secondary];
    if (secondary.length === 0) return [...primary];
    const w0 = clamp01(primaryWeight);
    const w1 = 1 - w0;
    const out: SpectralProfile[] = [];
    let secIdx = 0;
    for (let i = 0; i < primary.length; i++) {
        const p = primary[i];
        while (secIdx + 1 < secondary.length && secondary[secIdx + 1].time <= p.time) {
            secIdx++;
        }
        let s = secondary[secIdx];
        if (secIdx + 1 < secondary.length) {
            const next = secondary[secIdx + 1];
            if (Math.abs(next.time - p.time) < Math.abs(s.time - p.time)) {
                s = next;
            }
        }
        if (!s || Math.abs(s.time - p.time) > 0.2) {
            out.push({ ...p });
            continue;
        }
        out.push({
            time: p.time,
            low: p.low * w0 + s.low * w1,
            mid: p.mid * w0 + s.mid * w1,
            high: p.high * w0 + s.high * w1,
            energy: p.energy * w0 + s.energy * w1,
            brightness: clamp01(p.brightness * w0 + s.brightness * w1),
            transient: clamp01(p.transient * w0 + s.transient * w1),
            tonal: clamp01(p.tonal * w0 + s.tonal * w1),
            percussive: clamp01(p.percussive * w0 + s.percussive * w1),
        });
    }
    return out;
};

const detectOnsetsAdaptive = (
    buffer: AudioBuffer,
    difficulty: Difficulty,
    onSubProgress?: (progress: number) => void
): { result: OnsetResult; fullFlux: OnsetFluxProfile } => {
    const duration = Math.max(1, buffer.duration);
    const perf = getRuntimePerfProfile();
    const qualityFirst = MAPGEN_MAX_ANALYSIS
        ? perf.tier !== 'low' && duration <= 1400
        : (perf.tier === 'high' || perf.qualityBias >= 0.68) && duration <= 780;
    const analysisBoost = MAPGEN_MAX_ANALYSIS
        ? (perf.tier !== 'low' || perf.cores >= 6)
        : qualityFirst
            || perf.qualityBias >= 0.56
            || (perf.tier === 'mid' && duration <= 420);
    const qualityBoost = clamp01(
        Math.max(0, (perf.cores - 4) / 8) * 0.5
        + Math.max(0, (perf.memoryGb - 4) / 12) * 0.32
        + perf.qualityBias * 0.18
    );
    const highDetailPass = analysisBoost
        && qualityBoost >= 0.12
        && duration <= 1020;
    const maxExtraFluxPasses = duration >= 600
        ? (MAPGEN_MAX_ANALYSIS ? 2 : 1)
        : duration >= 360
            ? (MAPGEN_MAX_ANALYSIS ? 3 : 2)
            : (MAPGEN_MAX_ANALYSIS ? 4 : 3);
    let extraFluxPasses = 0;
    const ultraFast = !MAPGEN_MAX_ANALYSIS && perf.tier === 'low' && duration >= 900;
    // 하드웨어가 충분하면 최고 품질 경로 활성화
    const ultraQuality = MAPGEN_MAX_ANALYSIS && perf.tier === 'high' && duration <= 600;
    const baseSensitivities = ultraQuality
        ? [0.72, 0.80, 0.88, 0.96, 1.04, 1.12, 1.20, 1.30, 1.42, 1.56, 1.72]
        : (qualityFirst || highDetailPass)
        ? [0.8, 0.88, 0.96, 1.04, 1.14, 1.24, 1.36, 1.5, 1.64]
        : ultraFast
        ? [0.98, 1.22]
        : duration >= 260
            ? [0.84, 0.96, 1.08, 1.20, 1.34]
            : [0.86, 0.96, 1.08, 1.20, 1.34, 1.48];
    const detailSensitivities = ultraQuality
        ? [0.68, 0.76, 0.84, 0.92, 1.0, 1.08, 1.16, 1.24, 1.34, 1.46, 1.58, 1.72]
        : highDetailPass
        ? [0.76, 0.84, 0.92, 1.0, 1.08, 1.16, 1.26, 1.36, 1.48, 1.6, 1.72]
        : baseSensitivities;
    const sensitivities = perf.tier === 'mid' && !ultraFast && !qualityFirst && !highDetailPass
        ? baseSensitivities.filter((_, idx) => idx % 2 === 0 || idx === baseSensitivities.length - 1)
        : detailSensitivities;
    const targetPerSec: Record<Difficulty, number> = {
        easy: 2.3,
        normal: 4.4,
        hard: 6.6,
        expert: 8.8,
    };
    const baseTarget = targetPerSec[difficulty];

    const previewSeconds = MAPGEN_MAX_ANALYSIS
        ? Math.min(duration, duration >= 420 ? 56 : duration >= 220 ? 46 : 36)
        : ultraFast
        ? Math.min(duration, 20)
        : highDetailPass
            ? (duration >= 420 ? 44 : duration >= 220 ? 38 : 32)
            : duration >= 260
                ? 32
                : duration >= 140
                    ? 26
                    : Math.min(duration, 20);
    const tunedPreviewSeconds = perf.tier === 'low'
        ? Math.min(previewSeconds, 18)
        : perf.tier === 'mid'
            ? Math.min(previewSeconds, 24)
            : previewSeconds;
    const previewDuration = Math.max(1, Math.min(duration, tunedPreviewSeconds));
    const tuneHop = (hop: number, minHop: number): number => {
        const tighten = highDetailPass
            ? Math.max(0.58, 0.82 - qualityBoost * 0.2)
            : qualityFirst
                ? 0.78
                : 1;
        const relaxed = perf.tier === 'low' ? 1.08 : 1;
        return Math.max(minHop, Math.floor(hop * tighten * relaxed));
    };
    const previewBase = ultraQuality
        ? { fftSize: 4096, hopSize: duration >= 320 ? 512 : 384 }
        : highDetailPass
        ? { fftSize: 4096, hopSize: duration >= 320 ? 640 : 512 }
        : qualityFirst
        ? { fftSize: 2048, hopSize: duration >= 260 ? 640 : 512 }
        : ultraFast
        ? { fftSize: 1024, hopSize: 1536 }
        : duration >= 220
            ? { fftSize: 2048, hopSize: 1024 }
            : duration >= 120
                ? { fftSize: 2048, hopSize: 768 }
                : { fftSize: 2048, hopSize: 640 };
    const previewOptions = {
        fftSize: previewBase.fftSize,
        hopSize: tuneHop(previewBase.hopSize, previewBase.fftSize >= 4096 ? 256 : previewBase.fftSize === 2048 ? 384 : 640),
    };
    onSubProgress?.(0.06);
    const previewFlux = computeOnsetFlux(buffer, {
        ...previewOptions,
        startTimeSec: 0,
        durationSec: previewDuration,
    });
    onSubProgress?.(0.16);
    const previewProfile = summarizeFluxDynamics(previewFlux, previewDuration);
    const target = adjustOnsetDensityTarget(baseTarget, previewProfile, difficulty);

    let best: OnsetResult | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestSensitivity = sensitivities[0] ?? 1.2;
    const introWindow = Math.min(12, Math.max(3, previewDuration * 0.18));
    const introTarget = computeIntroDensityTarget(target, previewProfile, introWindow);

    for (let si = 0; si < sensitivities.length; si++) {
        const s = sensitivities[si];
        const candidate = detectOnsetsFromFlux(previewFlux, s);
        onSubProgress?.(0.16 + (si + 1) / Math.max(1, sensitivities.length + 1) * 0.44);
        const quality = evaluateOnsetResultQuality(
            candidate,
            previewDuration,
            target,
            introWindow,
            introTarget
        );
        const score = quality.score;
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
            bestSensitivity = s;
        }
        const densityTolerance = (perf.tier === 'low' ? target * 0.2 : target * 0.13)
            + target * previewProfile.complexity * 0.04;
        const goodDensity = Math.abs(quality.density - target) <= densityTolerance;
        const goodIntro = quality.introOverflow <= Math.max(
            0.16,
            introTarget * (0.16 + previewProfile.calm * 0.1)
        );
        if (goodDensity && goodIntro && score <= 0.58) {
            break;
        }
    }

    // 전체 곡은 1회만 정밀 분석
    const fullBase = ultraQuality
        ? {
            fftSize: 4096,
            hopSize: duration >= 300 ? 512 : 384,
        }
        : qualityFirst
        ? {
            fftSize: 4096,
            hopSize: duration >= 300 ? 640 : 512,
        }
        : ultraFast
        ? { fftSize: 1024, hopSize: 1536 }
        : highDetailPass
            ? { fftSize: 4096, hopSize: duration >= 420 ? 768 : 640 }
        : duration >= 300
            ? { fftSize: 2048, hopSize: 1024 }
            : duration >= 180
                ? { fftSize: 2048, hopSize: 768 }
                : duration >= 120
                    ? { fftSize: 2048, hopSize: 640 }
                    : { fftSize: 2048, hopSize: 512 };
    const fullOptions = {
        fftSize: fullBase.fftSize,
        hopSize: tuneHop(fullBase.hopSize, fullBase.fftSize >= 4096 ? 256 : fullBase.fftSize === 2048 ? 384 : 640),
    };
    const tunedFullOptions = perf.tier === 'low'
        ? {
            fftSize: fullOptions?.fftSize ?? 1024,
            hopSize: Math.max(1408, Math.floor((fullOptions?.hopSize ?? 768) * 1.6)),
        }
        : fullOptions;
    onSubProgress?.(0.68);
    const fullFlux = computeOnsetFlux(buffer, tunedFullOptions);
    onSubProgress?.(0.76);
    const fullProfile = summarizeFluxDynamics(fullFlux, duration);
    const fullTarget = adjustOnsetDensityTarget(baseTarget, fullProfile, difficulty);
    const fullIntroWindow = Math.min(14, Math.max(4, duration * 0.16));
    const fullIntroTarget = computeIntroDensityTarget(fullTarget, fullProfile, fullIntroWindow);

    interface CandidateQuality {
        readonly score: number;
        readonly density: number;
        readonly introDensity: number;
        readonly introOverflow: number;
        readonly introSparse: number;
    }
    interface OnsetCandidatePack {
        readonly result: OnsetResult;
        readonly flux: OnsetFluxProfile;
        readonly quality: CandidateQuality;
        readonly sensitivity: number;
    }
    const assessQuality = (candidate: OnsetResult): CandidateQuality =>
        evaluateOnsetResultQuality(
            candidate,
            duration,
            fullTarget,
            fullIntroWindow,
            fullIntroTarget
        );
    let selectedSensitivity = best ? bestSensitivity : 1.5;
    let result = detectOnsetsFromFlux(fullFlux, selectedSensitivity);
    let selectedFlux = fullFlux;
    let selectedQuality = assessQuality(result);
    const precisionGoodEnough = (
        selectedQuality.score <= 0.78
        && selectedQuality.density >= fullTarget * 0.84
        && selectedQuality.density <= fullTarget * 1.52
        && selectedQuality.introOverflow <= Math.max(0.14, fullIntroTarget * 0.22)
    );

    const candidates: OnsetCandidatePack[] = [
        {
            result,
            flux: fullFlux,
            quality: selectedQuality,
            sensitivity: selectedSensitivity,
        },
    ];

    if (!precisionGoodEnough && analysisBoost && duration <= (MAPGEN_MAX_ANALYSIS ? 1800 : 1400)) {
        const configCandidates: Array<{ fftSize: number; hopSize: number }> = [
            {
                fftSize: 2048,
                hopSize: Math.max(384, Math.floor((tunedFullOptions?.hopSize ?? 640) * 0.72)),
            },
            {
                fftSize: 4096,
                hopSize: Math.max(384, Math.floor((tunedFullOptions?.hopSize ?? 640) * 0.84)),
            },
        ];
        if (highDetailPass || qualityFirst || ultraQuality) {
            configCandidates.push({
                fftSize: 8192,
                hopSize: Math.max(256, Math.floor((tunedFullOptions?.hopSize ?? 640) * 0.94)),
            });
        }
        const uniqueConfigs: Array<{ fftSize: number; hopSize: number }> = [];
        const cfgSeen = new Set<string>();
        for (const cfg of configCandidates) {
            const key = `${cfg.fftSize}:${cfg.hopSize}`;
            if (cfgSeen.has(key)) continue;
            cfgSeen.add(key);
            uniqueConfigs.push(cfg);
        }

        for (let ci = 0; ci < uniqueConfigs.length; ci++) {
            if (extraFluxPasses >= maxExtraFluxPasses) break;
            const cfg = uniqueConfigs[ci];
            const flux = computeOnsetFlux(buffer, cfg);
            extraFluxPasses++;
            const trialSensitivities = Array.from(new Set([
                Math.max(0.72, selectedSensitivity * 0.9),
                Math.max(0.76, selectedSensitivity * 0.96),
                selectedSensitivity,
                Math.min(1.9, selectedSensitivity * 1.06),
            ].map(v => Number(v.toFixed(3)))));
            let localBestResult = detectOnsetsFromFlux(flux, trialSensitivities[0] ?? selectedSensitivity);
            let localBestQuality = assessQuality(localBestResult);
            let localBestSensitivity = trialSensitivities[0] ?? selectedSensitivity;
            for (let si = 1; si < trialSensitivities.length; si++) {
                const s = trialSensitivities[si];
                const cand = detectOnsetsFromFlux(flux, s);
                const candQuality = assessQuality(cand);
                if (candQuality.score < localBestQuality.score) {
                    localBestResult = cand;
                    localBestQuality = candQuality;
                    localBestSensitivity = s;
                }
            }
            candidates.push({
                result: localBestResult,
                flux,
                quality: localBestQuality,
                sensitivity: localBestSensitivity,
            });
            onSubProgress?.(0.78 + ((ci + 1) / Math.max(1, uniqueConfigs.length)) * 0.08);
        }

        const ranked = [...candidates].sort((a, b) => a.quality.score - b.quality.score);
        const bestCandidate = ranked[0];
        result = bestCandidate.result;
        selectedFlux = bestCandidate.flux;
        selectedQuality = bestCandidate.quality;
        selectedSensitivity = bestCandidate.sensitivity;

        if (ranked.length >= 2) {
            const mergePool = ranked
                .slice(0, Math.min(3, ranked.length))
                .map(c => c.result);
            const mergedResult = mergeOnsetResults(mergePool);
            const mergedQuality = assessQuality(mergedResult);
            const bestQuality = ranked[0].quality;
            const mergeAccepted = mergedQuality.score <= bestQuality.score + 0.05
                && mergedQuality.introOverflow <= bestQuality.introOverflow * 1.2 + 0.06
                && mergedQuality.density <= fullTarget * 2.45;
            if (mergeAccepted) {
                result = mergedResult;
                selectedQuality = mergedQuality;
                const bestFluxByRate = ranked
                    .slice(0, Math.min(3, ranked.length))
                    .sort((a, b) => b.flux.framerate - a.flux.framerate)[0];
                selectedFlux = bestFluxByRate?.flux ?? selectedFlux;
            }
        }
    }

    const retryBudget = MAPGEN_MAX_ANALYSIS
        || analysisBoost
        || qualityFirst
        || highDetailPass
        || perf.qualityBias >= 0.56
        || duration <= 260
        || (perf.tier === 'high' && duration <= 760);
    const needPrecisionRetry = !precisionGoodEnough
        && retryBudget
        && (
            selectedQuality.score > 1.16
            || selectedQuality.density < fullTarget * 0.66
            || (
                selectedQuality.density < fullTarget * 0.9
                && selectedQuality.introSparse > fullIntroTarget * 0.34
            )
            || (qualityFirst && selectedQuality.score > 0.82)
            || (highDetailPass && selectedQuality.score > 0.74)
        );

    if (needPrecisionRetry) {
        onSubProgress?.(0.92);
        const refineBaseHop = Math.max(480, Math.floor((tunedFullOptions?.hopSize ?? 896) * 0.68));
        const refineConfigs: Array<{ fftSize: number; hopSize: number }> = [
            {
                fftSize: highDetailPass || qualityFirst ? 2048 : 1024,
                hopSize: Math.max(512, refineBaseHop),
            },
            {
                fftSize: 1024,
                hopSize: Math.max(448, Math.floor(refineBaseHop * 0.84)),
            },
        ];
        if (highDetailPass) {
            refineConfigs.push({
                fftSize: 4096,
                hopSize: Math.max(640, Math.floor(refineBaseHop * 1.08)),
            });
        }
        let refinedResult = result;
        let refinedFlux = selectedFlux;
        let refinedQuality = selectedQuality;

        for (let ri = 0; ri < refineConfigs.length; ri++) {
            if (extraFluxPasses >= maxExtraFluxPasses) break;
            const cfg = refineConfigs[ri];
            const flux = computeOnsetFlux(buffer, cfg);
            extraFluxPasses++;
            const trialSensitivities = Array.from(new Set([
                Math.max(0.74, selectedSensitivity * 0.9),
                Math.max(0.78, selectedSensitivity * 0.96),
                Math.max(0.82, selectedSensitivity),
                Math.min(1.9, selectedSensitivity * 1.05),
            ].map(v => Number(v.toFixed(3)))));

            let localBest = detectOnsetsFromFlux(flux, trialSensitivities[0] ?? selectedSensitivity);
            let localBestQuality = assessQuality(localBest);
            for (let si = 1; si < trialSensitivities.length; si++) {
                const s = trialSensitivities[si];
                const cand = detectOnsetsFromFlux(flux, s);
                const candQuality = assessQuality(cand);
                if (candQuality.score < localBestQuality.score) {
                    localBest = cand;
                    localBestQuality = candQuality;
                }
            }

            const merged = mergeOnsetResults([refinedResult, localBest]);
            const mergedQuality = assessQuality(merged);
            const localNotOverDense = localBestQuality.density <= fullTarget * 2.55;
            const mergedNotOverDense = mergedQuality.density <= fullTarget * 2.55;
            const betterLocal = localNotOverDense
                && localBestQuality.score + 0.06 < refinedQuality.score
                && localBestQuality.introOverflow <= refinedQuality.introOverflow * 1.22 + 0.08;
            const betterMerged = mergedNotOverDense
                && mergedQuality.score + 0.04 < refinedQuality.score
                && mergedQuality.introOverflow <= refinedQuality.introOverflow * 1.18 + 0.08;

            if (betterMerged) {
                refinedResult = merged;
                refinedFlux = flux.framerate >= refinedFlux.framerate ? flux : refinedFlux;
                refinedQuality = mergedQuality;
            } else if (betterLocal) {
                refinedResult = localBest;
                refinedFlux = flux;
                refinedQuality = localBestQuality;
            }
            onSubProgress?.(0.92 + ((ri + 1) / Math.max(1, refineConfigs.length)) * 0.07);
        }

        if (refinedQuality.score + 0.03 < selectedQuality.score) {
            result = refinedResult;
            selectedFlux = refinedFlux;
            selectedQuality = refinedQuality;
        }
    }

    onSubProgress?.(1);
    return { result, fullFlux: selectedFlux };
};

const mergeOnsetSeries = (
    series: readonly { times: readonly number[]; strengths: readonly number[] }[],
    mergeWindow = 0.032
): { times: number[]; strengths: number[] } => {
    const events: Array<{ time: number; strength: number }> = [];
    for (let si = 0; si < series.length; si++) {
        const s = series[si];
        for (let i = 0; i < s.times.length; i++) {
            const time = s.times[i];
            if (!Number.isFinite(time) || time < 0) continue;
            const strength = clamp01(s.strengths[i] ?? 0.5);
            events.push({ time, strength });
        }
    }
    if (events.length === 0) {
        return { times: [], strengths: [] };
    }
    events.sort((a, b) => a.time - b.time);

    const outTimes: number[] = [];
    const outStrengths: number[] = [];
    let cluster: Array<{ time: number; strength: number }> = [events[0]];
    const flushCluster = (): void => {
        if (cluster.length === 0) return;
        let weightSum = 0;
        let weightedTime = 0;
        let maxStrength = 0;
        for (let i = 0; i < cluster.length; i++) {
            const e = cluster[i];
            const w = 0.18 + e.strength * 0.82;
            weightSum += w;
            weightedTime += e.time * w;
            if (e.strength > maxStrength) maxStrength = e.strength;
        }
        const mergedTime = weightSum > 0 ? weightedTime / weightSum : cluster[0].time;
        const mergedStrength = clamp01(maxStrength + Math.min(0.14, (cluster.length - 1) * 0.04));
        outTimes.push(mergedTime);
        outStrengths.push(mergedStrength);
        cluster = [];
    };

    for (let i = 1; i < events.length; i++) {
        const e = events[i];
        const prev = cluster[cluster.length - 1];
        if (e.time - prev.time <= mergeWindow) {
            cluster.push(e);
        } else {
            flushCluster();
            cluster = [e];
        }
    }
    flushCluster();
    return { times: outTimes, strengths: outStrengths };
};

const mergeOnsetResults = (results: readonly OnsetResult[]): OnsetResult => {
    if (results.length === 0) {
        return {
            onsets: [],
            strengths: [],
            lowOnsets: [],
            lowStrengths: [],
            midOnsets: [],
            midStrengths: [],
            highOnsets: [],
            highStrengths: [],
        };
    }
    if (results.length === 1) {
        return results[0];
    }

    const low = mergeOnsetSeries(results.map(r => ({ times: r.lowOnsets, strengths: r.lowStrengths })), 0.03);
    const mid = mergeOnsetSeries(results.map(r => ({ times: r.midOnsets, strengths: r.midStrengths })), 0.03);
    const high = mergeOnsetSeries(results.map(r => ({ times: r.highOnsets, strengths: r.highStrengths })), 0.028);
    const combined = mergeOnsetSeries(results.map(r => ({ times: r.onsets, strengths: r.strengths })), 0.03);
    const fromBands = mergeOnsetSeries([
        { times: low.times, strengths: low.strengths },
        { times: mid.times, strengths: mid.strengths },
        { times: high.times, strengths: high.strengths },
    ], 0.028);
    const finalCombined = mergeOnsetSeries([
        { times: combined.times, strengths: combined.strengths },
        { times: fromBands.times, strengths: fromBands.strengths },
    ], 0.03);

    return {
        onsets: finalCombined.times,
        strengths: finalCombined.strengths,
        lowOnsets: low.times,
        lowStrengths: low.strengths,
        midOnsets: mid.times,
        midStrengths: mid.strengths,
        highOnsets: high.times,
        highStrengths: high.strengths,
    };
};

interface FluxDynamicsProfile {
    readonly drive: number;
    readonly calm: number;
    readonly introQuiet: number;
    readonly complexity: number;
}

const summarizeFluxDynamics = (
    flux: OnsetFluxProfile,
    analysisDuration: number
): FluxDynamicsProfile => {
    const frameCount = Math.min(
        flux.lowEnergy.length,
        flux.midEnergy.length,
        flux.highEnergy.length,
        flux.lowFlux.length,
        flux.midFlux.length,
        flux.highFlux.length
    );
    if (frameCount < 4) {
        return {
            drive: 0.5,
            calm: 0.5,
            introQuiet: 0.5,
            complexity: 0.5,
        };
    }

    const energyTrace = new Float32Array(frameCount);
    let energyMin = Number.POSITIVE_INFINITY;
    let energyMax = 0;
    for (let i = 0; i < frameCount; i++) {
        const energy = flux.lowEnergy[i] * 0.44 + flux.midEnergy[i] * 0.34 + flux.highEnergy[i] * 0.22;
        energyTrace[i] = energy;
        if (energy < energyMin) energyMin = energy;
        if (energy > energyMax) energyMax = energy;
    }
    const energyRange = Math.max(1e-6, energyMax - energyMin);
    let normEnergySum = 0;
    let normDeltaSum = 0;
    let totalFluxSum = 0;
    let totalFluxDelta = 0;
    let prevNormEnergy = 0;
    let prevFlux = 0;

    for (let i = 0; i < frameCount; i++) {
        const normEnergy = clamp01((energyTrace[i] - energyMin) / energyRange);
        normEnergySum += normEnergy;
        const totalFlux = flux.lowFlux[i] * 0.28 + flux.midFlux[i] * 0.34 + flux.highFlux[i] * 0.38;
        totalFluxSum += totalFlux;
        if (i > 0) {
            normDeltaSum += Math.abs(normEnergy - prevNormEnergy);
            totalFluxDelta += Math.abs(totalFlux - prevFlux);
        }
        prevNormEnergy = normEnergy;
        prevFlux = totalFlux;
    }

    const energyAvg = normEnergySum / frameCount;
    const fluxAvg = totalFluxSum / frameCount;
    const fluxDeltaNorm = clamp01(totalFluxDelta / Math.max(1, frameCount - 1) / (fluxAvg + 1e-6));
    const energyDeltaNorm = clamp01(normDeltaSum / Math.max(1, frameCount - 1) * 3.2);
    const dynamicNorm = clamp01(energyRange / (energyMax + 1e-6));
    const fluxNorm = clamp01(fluxAvg / (fluxAvg + 0.03));

    const introSeconds = Math.min(14, Math.max(4, analysisDuration * 0.16));
    const introFrames = Math.max(1, Math.min(frameCount, Math.round(introSeconds * Math.max(1, flux.framerate))));
    let introEnergySum = 0;
    let introFluxSum = 0;
    for (let i = 0; i < introFrames; i++) {
        introEnergySum += clamp01((energyTrace[i] - energyMin) / energyRange);
        introFluxSum += flux.lowFlux[i] * 0.28 + flux.midFlux[i] * 0.34 + flux.highFlux[i] * 0.38;
    }
    const introEnergyAvg = introEnergySum / introFrames;
    const introFluxAvg = introFluxSum / introFrames;
    const introFluxNorm = clamp01(introFluxAvg / (fluxAvg + 1e-6));
    const introQuiet = clamp01(1 - (introEnergyAvg * 0.62 + introFluxNorm * 0.38));

    const drive = clamp01(
        energyAvg * 0.38
        + dynamicNorm * 0.24
        + fluxNorm * 0.24
        + fluxDeltaNorm * 0.14
    );
    const calm = clamp01(
        (1 - drive) * 0.46
        + introQuiet * 0.34
        + (1 - dynamicNorm) * 0.2
    );
    const complexity = clamp01(
        energyDeltaNorm * 0.48
        + fluxDeltaNorm * 0.32
        + dynamicNorm * 0.2
    );

    return { drive, calm, introQuiet, complexity };
};

const adjustOnsetDensityTarget = (
    baseTarget: number,
    profile: FluxDynamicsProfile,
    difficulty: Difficulty
): number => {
    const difficultyBias = difficulty === 'easy'
        ? -0.06
        : difficulty === 'normal'
            ? 0
            : difficulty === 'hard'
                ? 0.04
                : 0.08;
    const factor = 0.82
        + profile.drive * 0.24
        + profile.complexity * 0.12
        - profile.calm * 0.2
        - profile.introQuiet * 0.08
        + difficultyBias;
    const lower = baseTarget * (difficulty === 'expert' ? 0.72 : 0.62);
    const upper = baseTarget * (difficulty === 'easy' ? 1.08 : difficulty === 'normal' ? 1.2 : 1.32);
    return Math.max(lower, Math.min(upper, baseTarget * factor));
};

const computeIntroDensityTarget = (
    targetDensity: number,
    profile: FluxDynamicsProfile,
    introWindowSec: number
): number => {
    const introFactor = 0.22
        + profile.drive * 0.2
        + profile.complexity * 0.12
        - profile.introQuiet * 0.14
        - profile.calm * 0.08;
    const raw = targetDensity * introFactor;
    const lower = Math.max(0.18, 0.28 - Math.min(0.08, introWindowSec * 0.006));
    const upper = Math.max(lower + 0.1, targetDensity * 0.9);
    return Math.max(lower, Math.min(upper, raw));
};

const evaluateOnsetResultQuality = (
    candidate: OnsetResult,
    analysisDuration: number,
    targetDensity: number,
    introWindow: number,
    introTarget: number
): { score: number; density: number; introDensity: number; introOverflow: number; introSparse: number } => {
    const total = candidate.onsets.length;
    const density = total / Math.max(1, analysisDuration);
    let introCount = 0;
    for (let i = 0; i < candidate.onsets.length; i++) {
        if (candidate.onsets[i] <= introWindow) introCount++;
    }
    const introDensity = introCount / Math.max(1, introWindow);
    const lowPenalty = density < targetDensity * 0.45 ? (targetDensity * 0.45 - density) * 3 : 0;
    const highPenalty = density > targetDensity * 2.2 ? (density - targetDensity * 2.2) * 1.5 : 0;
    const introLowFloor = introTarget * 0.32;
    const introSparse = Math.max(0, introLowFloor - introDensity);
    const introExpectedHigh = Math.max(introTarget * 1.18, density * 1.24);
    const introOverflow = Math.max(0, introDensity - introExpectedHigh);
    const introLowPenalty = introSparse * 1.9;
    const introHighPenalty = introOverflow * 2.5;
    const spreadPenalty = Math.abs(candidate.lowOnsets.length - candidate.highOnsets.length) / Math.max(1, total) * 0.25;
    const score = Math.abs(density - targetDensity) + lowPenalty + highPenalty + introLowPenalty + introHighPenalty + spreadPenalty;
    return { score, density, introDensity, introOverflow, introSparse };
};

const refineBeatOffset = (
    initialOffset: number,
    bpm: number,
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[]
): number => {
    if (onsetTimes.length < 12 || bpm <= 0) return Math.max(0, initialOffset);
    const beatInterval = 60 / bpm;
    if (!isFinite(beatInterval) || beatInterval <= 0) return Math.max(0, initialOffset);

    const base = ((initialOffset % beatInterval) + beatInterval) % beatInterval;
    let bestOffset = base;
    let bestScore = Number.POSITIVE_INFINITY;

    const searchSteps = 48;
    for (let i = 0; i <= searchSteps; i++) {
        const delta = ((i / searchSteps) - 0.5) * beatInterval;
        const candidate = ((base + delta) % beatInterval + beatInterval) % beatInterval;
        let score = 0;
        let used = 0;
        for (let j = 0; j < onsetTimes.length; j++) {
            const t = onsetTimes[j];
            if (t < 0.25) continue;
            const strength = onsetStrengths[j] ?? 0.5;
            if (strength < 0.25) continue;
            const beatDist = circularDistanceToGrid(t, candidate, beatInterval);
            const halfDist = circularDistanceToGrid(t, candidate + beatInterval * 0.5, beatInterval);
            const d = Math.min(beatDist, halfDist * 1.15);
            score += d * (0.5 + strength);
            used++;
        }
        if (used >= 8 && score < bestScore) {
            bestScore = score;
            bestOffset = candidate;
        }
    }
    return bestOffset;
};

const circularDistanceToGrid = (
    time: number,
    offset: number,
    interval: number
): number => {
    const phase = ((time - offset) % interval + interval) % interval;
    return Math.min(phase, interval - phase);
};

const mapStrengthsToTimes = (
    snappedTimes: readonly number[],
    rawOnsets: readonly number[],
    rawStrengths: readonly number[]
): number[] => {
    if (rawOnsets.length === 0) return snappedTimes.map(() => 0.5);
    const result: number[] = new Array(snappedTimes.length);
    let i = 0;
    for (let k = 0; k < snappedTimes.length; k++) {
        const t = snappedTimes[k];
        while (i + 1 < rawOnsets.length && rawOnsets[i + 1] <= t) i++;
        let bestIdx = i;
        let bestDist = Math.abs(rawOnsets[i] - t);
        if (i + 1 < rawOnsets.length) {
            const d2 = Math.abs(rawOnsets[i + 1] - t);
            if (d2 < bestDist) {
                bestDist = d2;
                bestIdx = i + 1;
            }
        }
        if (i > 0) {
            const d0 = Math.abs(rawOnsets[i - 1] - t);
            if (d0 < bestDist) {
                bestIdx = i - 1;
            }
        }
        result[k] = rawStrengths[bestIdx] ?? 0.5;
    }
    return result;
};

const buildEnhancedMusicalOnsetTimeline = (
    onsetResult: OnsetResult,
    fallbackTimes: readonly number[],
    fallbackStrengths: readonly number[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    spectralProfiles: readonly SpectralProfile[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures,
    perf: RuntimePerfProfile
): { times: number[]; strengths: number[] } => {
    if (beatPositions.length === 0 || bpm <= 0) {
        return {
            times: [...fallbackTimes],
            strengths: [...fallbackStrengths],
        };
    }

    type BandType = 'low' | 'mid' | 'high' | 'mix';
    interface OnsetCandidate {
        readonly time: number;
        readonly strength: number;
        readonly band: BandType;
    }
    interface ScoredOnset extends OnsetCandidate {
        readonly score: number;
    }

    const percentile = (values: readonly number[], q: number, fallback: number): number => {
        if (values.length === 0) return fallback;
        const sorted = [...values].sort((a, b) => a - b);
        const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sorted[lo];
        return lerp(sorted[lo], sorted[hi], pos - lo);
    };

    const toCandidates = (
        times: readonly number[],
        strengths: readonly number[],
        band: BandType,
        fallbackStrength: number
    ): OnsetCandidate[] => {
        const out: OnsetCandidate[] = [];
        for (let i = 0; i < times.length; i++) {
            const t = times[i];
            if (!Number.isFinite(t) || t < 0) continue;
            out.push({
                time: t,
                strength: clamp01(strengths[i] ?? fallbackStrength),
                band,
            });
        }
        return out;
    };

    const candidates: OnsetCandidate[] = [
        ...toCandidates(onsetResult.lowOnsets, onsetResult.lowStrengths, 'low', 0.66),
        ...toCandidates(onsetResult.midOnsets, onsetResult.midStrengths, 'mid', 0.56),
        ...toCandidates(onsetResult.highOnsets, onsetResult.highStrengths, 'high', 0.62),
        ...toCandidates(fallbackTimes, fallbackStrengths, 'mix', 0.5),
    ];
    if (candidates.length === 0) {
        return {
            times: [...fallbackTimes],
            strengths: [...fallbackStrengths],
        };
    }

    const beatInterval = 60 / Math.max(1, bpm);
    const includeSixteenth = difficulty === 'hard'
        || difficulty === 'expert'
        || (perf.tier === 'high' && perf.cores >= 8);
    const includeTriplet = difficulty !== 'easy'
        || songFeatures.melodicFocus >= 0.58
        || songFeatures.sustainedFocus >= 0.56;

    const gridRaw: number[] = [];
    for (let i = 0; i < beatPositions.length; i++) {
        const b = beatPositions[i];
        const next = beatPositions[i + 1];
        const localBeat = next !== undefined ? Math.max(0.05, next - b) : beatInterval;
        gridRaw.push(b, b + localBeat * 0.5);
        if (includeSixteenth) {
            gridRaw.push(b + localBeat * 0.25, b + localBeat * 0.75);
        }
        if (includeTriplet) {
            gridRaw.push(b + localBeat / 3, b + localBeat * (2 / 3));
        }
    }
    gridRaw.sort((a, b) => a - b);
    const grid: number[] = [];
    let lastGrid = -Infinity;
    for (const t of gridRaw) {
        if (!Number.isFinite(t) || t < 0) continue;
        if (t - lastGrid < 0.008) continue;
        grid.push(t);
        lastGrid = t;
    }
    if (grid.length === 0) {
        return {
            times: [...fallbackTimes],
            strengths: [...fallbackStrengths],
        };
    }

    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    const nearestGrid = (time: number): number => {
        const idx = lowerBound(grid, time);
        let best = grid[Math.max(0, Math.min(grid.length - 1, idx))];
        let bestDist = Math.abs(best - time);
        for (let i = Math.max(0, idx - 2); i <= Math.min(grid.length - 1, idx + 2); i++) {
            const d = Math.abs(grid[i] - time);
            if (d < bestDist) {
                bestDist = d;
                best = grid[i];
            }
        }
        return best;
    };

    const sortedSections = [...sections].sort((a, b) => a.startTime - b.startTime);
    const sectionAt = createSectionLookup(sortedSections);
    const isSilentSection = (type: string): boolean =>
        type === 'intro' || type === 'outro' || type === 'interlude';
    const firstHighlightStart = sortedSections.find(s =>
        s.startTime > 0.4
        && (s.type === 'drop' || s.type === 'chorus' || (s.avgEnergy || 0.5) >= 0.74)
    )?.startTime ?? Number.POSITIVE_INFINITY;
    const totalDuration = Math.max(
        beatPositions[beatPositions.length - 1] ?? 0,
        sortedSections[sortedSections.length - 1]?.endTime ?? 0,
        fallbackTimes[fallbackTimes.length - 1] ?? 0
    );
    const introGuardEnd = Number.isFinite(firstHighlightStart)
        ? Math.max(0.8, Math.min(firstHighlightStart - beatInterval * 0.48, Math.max(3.2, firstHighlightStart * 0.42)))
        : Math.max(3.8, Math.min(7.2, totalDuration * 0.14));

    const strengthValues = candidates.map(c => c.strength);
    const strongGate = Math.max(0.58, percentile(strengthValues, 0.72, 0.62));
    const ultraStrongGate = Math.max(0.72, percentile(strengthValues, 0.88, 0.76));

    const getSectionBandWeight = (sectionType: string, band: BandType): { weight: number; threshold: number } => {
        const melodic = songFeatures.melodicFocus;
        const percussive = songFeatures.percussiveFocus;
        const sustained = songFeatures.sustainedFocus;
        const base = sectionType === 'drop'
            ? { low: 0.94, mid: 0.54, high: 0.76, mix: 0.62, threshold: 0.34 }
            : sectionType === 'chorus'
                ? { low: 0.78, mid: 0.66, high: 0.58, mix: 0.58, threshold: 0.36 }
                : sectionType === 'bridge'
                    ? { low: 0.28, mid: 0.86, high: 0.2, mix: 0.52, threshold: 0.42 }
                    : sectionType === 'verse'
                        ? { low: 0.42, mid: 0.9, high: 0.24, mix: 0.56, threshold: 0.4 }
                        : { low: 0.2, mid: 0.32, high: 0.16, mix: 0.26, threshold: 0.64 };
        const toneBonus = band === 'mid' ? melodic * 0.14 : band === 'high' ? percussive * 0.12 : sustained * 0.06;
        const dynamicBonus = band === 'low' ? songFeatures.bassWeight * 0.12 : 0;
        const weight = Math.max(0.08, (base[band] ?? base.mix) + toneBonus + dynamicBonus);
        return { weight, threshold: base.threshold };
    };

    const scored: ScoredOnset[] = [];
    for (const cand of candidates) {
        const sec = sectionAt(cand.time);
        const secType = sec?.type ?? 'verse';
        const secEnergy = sec?.avgEnergy ?? 0.5;
        if (isSilentSection(secType)) {
            if (cand.time < introGuardEnd && cand.strength < ultraStrongGate) continue;
            if (cand.strength < strongGate) continue;
        }

        const profile = getSpectralProfileAt(spectralProfiles, cand.time);
        const low = profile?.low ?? 0.35;
        const mid = profile?.mid ?? 0.35;
        const high = profile?.high ?? 0.35;
        const total = Math.max(1e-6, low + mid + high);
        const lowRatio = low / total;
        const midRatio = mid / total;
        const highRatio = high / total;
        const percussive = profile?.percussive ?? songFeatures.percussiveFocus;
        const tonal = profile?.tonal ?? songFeatures.melodicFocus;
        const transient = profile?.transient ?? (1 - songFeatures.sustainedFocus);

        const bandAffinity = cand.band === 'low'
            ? clamp01(lowRatio * 0.76 + (1 - percussive) * 0.14 + (1 - transient) * 0.1)
            : cand.band === 'mid'
                ? clamp01(midRatio * 0.68 + tonal * 0.22 + songFeatures.melodicFocus * 0.1)
                : cand.band === 'high'
                    ? clamp01(highRatio * 0.72 + percussive * 0.18 + transient * 0.1)
                    : clamp01(
                        Math.max(lowRatio, midRatio, highRatio) * 0.62
                        + tonal * 0.2
                        + percussive * 0.18
                    );
        const weightCfg = getSectionBandWeight(secType, cand.band);
        const energyLift = clamp01((secEnergy - 0.46) / 0.44);
        const introSuppress = cand.time < introGuardEnd
            ? clamp01(songFeatures.introQuietness * 0.42 + songFeatures.calmConfidence * 0.32)
            : 0;
        const score = cand.strength
            * weightCfg.weight
            * (0.64 + bandAffinity * 0.24 + energyLift * 0.12)
            * (1 - introSuppress * (isSilentSection(secType) ? 0.54 : 0.2));
        if (score < weightCfg.threshold) continue;

        const snapped = nearestGrid(cand.time);
        const dist = Math.abs(snapped - cand.time);
        const snapWindow = difficulty === 'easy'
            ? Math.max(0.052, beatInterval * 0.28)
            : difficulty === 'normal'
                ? Math.max(0.046, beatInterval * 0.24)
                : difficulty === 'hard'
                    ? Math.max(0.04, beatInterval * 0.2)
                    : Math.max(0.035, beatInterval * 0.18);
        if (dist > snapWindow && cand.strength < ultraStrongGate) continue;
        const finalTime = dist <= snapWindow
            ? lerp(cand.time, snapped, 0.84)
            : cand.time;
        scored.push({
            ...cand,
            time: Math.max(0.02, finalTime),
            score,
        });
    }

    if (scored.length === 0) {
        return {
            times: [...fallbackTimes],
            strengths: [...fallbackStrengths],
        };
    }

    const bucketSize = Math.max(0.012, beatInterval * (difficulty === 'easy' ? 0.22 : 0.16));
    const bucketed = new Map<number, ScoredOnset>();
    for (const cand of scored) {
        const key = Math.round(cand.time / bucketSize);
        const prev = bucketed.get(key);
        if (!prev || cand.score > prev.score) {
            bucketed.set(key, cand);
        }
    }
    const onsetPool = [...bucketed.values()].sort((a, b) => a.time - b.time);

    const targetNpsByDiff: Record<Difficulty, number> = {
        easy: 2.3,
        normal: 4.4,
        hard: 6.6,
        expert: 8.8,
    };
    const sectionMultiplier = (type: string): number => {
        if (type === 'drop') return 1.55;
        if (type === 'chorus') return 1.38;
        if (type === 'bridge') return 0.72;
        if (type === 'verse') return 0.88;
        if (type === 'outro') return 0.22;
        if (type === 'interlude') return 0.16;
        if (type === 'intro') return 0.20;
        return 0.84;
    };

    const selected: ScoredOnset[] = [];
    let poolPtr = 0;
    for (const section of sortedSections) {
        const secDur = Math.max(0, section.endTime - section.startTime);
        if (secDur < beatInterval * 1.2) continue;
        while (poolPtr < onsetPool.length && onsetPool[poolPtr].time < section.startTime) {
            poolPtr++;
        }
        const i0 = poolPtr;
        while (poolPtr < onsetPool.length && onsetPool[poolPtr].time < section.endTime) {
            poolPtr++;
        }
        const secCandidates = onsetPool.slice(i0, poolPtr);
        if (secCandidates.length === 0) continue;

        const energyBoost = clamp01(((section.avgEnergy || 0.5) - 0.48) / 0.42);
        let targetNps = targetNpsByDiff[difficulty]
            * sectionMultiplier(section.type)
            * (0.82 + energyBoost * 0.36);
        if (section.startTime < introGuardEnd) {
            const introCalm = clamp01(songFeatures.introQuietness * 0.62 + songFeatures.calmConfidence * 0.38);
            if (introCalm >= 0.42) {
                // 잔잔한 곡의 도입부는 과밀 생성을 강하게 억제한다.
                targetNps *= lerp(0.64, 0.2, introCalm);
            }
        }
        if (isSilentSection(section.type)) {
            targetNps *= 0.56;
        }
        const targetCount = Math.max(1, Math.floor(secDur * Math.max(0.18, targetNps)));
        const betterScore = (a: ScoredOnset, b: ScoredOnset): boolean =>
            a.score > b.score || (a.score === b.score && a.time < b.time);
        const topByScore: ScoredOnset[] = [];
        for (let i = 0; i < secCandidates.length; i++) {
            const cand = secCandidates[i];
            if (topByScore.length < targetCount) {
                topByScore.push(cand);
                for (let j = topByScore.length - 1; j > 0; j--) {
                    if (!betterScore(topByScore[j], topByScore[j - 1])) break;
                    const tmp = topByScore[j - 1];
                    topByScore[j - 1] = topByScore[j];
                    topByScore[j] = tmp;
                }
                continue;
            }
            const lastIdx = topByScore.length - 1;
            if (!betterScore(cand, topByScore[lastIdx])) continue;
            topByScore[lastIdx] = cand;
            for (let j = lastIdx; j > 0; j--) {
                if (!betterScore(topByScore[j], topByScore[j - 1])) break;
                const tmp = topByScore[j - 1];
                topByScore[j - 1] = topByScore[j];
                topByScore[j] = tmp;
            }
        }
        const top = topByScore.sort((a, b) => a.time - b.time);
        selected.push(...top);
    }

    if (selected.length === 0) {
        return {
            times: [...fallbackTimes],
            strengths: [...fallbackStrengths],
        };
    }

    const selectedSorted = selected.sort((a, b) => a.time - b.time);
    const minGap = Math.max(0.016, beatInterval * (difficulty === 'easy' ? 0.24 : 0.16));
    const outTimes: number[] = [];
    const outStrengths: number[] = [];
    let lastTime = -Infinity;
    for (const s of selectedSorted) {
        if (s.time - lastTime < minGap) {
            if (outStrengths.length > 0 && s.score > outStrengths[outStrengths.length - 1]) {
                outTimes[outTimes.length - 1] = s.time;
                outStrengths[outStrengths.length - 1] = clamp01(Math.max(s.strength, s.score));
                lastTime = s.time;
            }
            continue;
        }
        outTimes.push(s.time);
        outStrengths.push(clamp01(Math.max(s.strength, s.score)));
        lastTime = s.time;
    }

    if (outTimes.length < Math.max(10, Math.floor(fallbackTimes.length * 0.28))) {
        return {
            times: [...fallbackTimes],
            strengths: [...fallbackStrengths],
        };
    }

    return {
        times: outTimes,
        strengths: outStrengths,
    };
};

const applySectionRhythmSourceSelection = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    beatPositions: readonly number[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    lowOnsets: readonly number[],
    lowStrengths: readonly number[],
    midOnsets: readonly number[],
    midStrengths: readonly number[],
    highOnsets: readonly number[],
    highStrengths: readonly number[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length === 0 || sections.length === 0 || beatPositions.length === 0 || bpm <= 0) return [...notes];
    const beatInterval = 60 / bpm;
    const sortedBase = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const sortedSections = [...sections].sort((a, b) => a.startTime - b.startTime);
    const playableSection = (type: string): boolean => type !== 'intro' && type !== 'outro' && type !== 'interlude';
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const toPairs = (times: readonly number[], strengths: readonly number[]): Array<{ time: number; strength: number }> =>
        times
            .map((time, i) => ({ time, strength: strengths[i] ?? 0.5 }))
            .filter(p => Number.isFinite(p.time))
            .sort((a, b) => a.time - b.time);
    const lowPairs = toPairs(lowOnsets, lowStrengths);
    const midPairs = toPairs(midOnsets.length > 0 ? midOnsets : onsetTimes, midOnsets.length > 0 ? midStrengths : onsetStrengths);
    const highPairs = toPairs(highOnsets, highStrengths);
    const lowTimes = lowPairs.map(p => p.time);
    const midTimes = midPairs.map(p => p.time);
    const highTimes = highPairs.map(p => p.time);
    const baseTimes = sortedBase.map(n => n.time);

    const npsTargets: Record<Difficulty, { verse: number; chorus: number; drop: number; bridge: number }> = {
        easy: { verse: 1.6, chorus: 2.2, drop: 2.5, bridge: 1.15 },
        normal: { verse: 3.2, chorus: 4.8, drop: 5.6, bridge: 2.4 },
        hard: { verse: 4.8, chorus: 6.8, drop: 8.0, bridge: 3.3 },
        expert: { verse: 6.6, chorus: 9.2, drop: 10.8, bridge: 4.8 },
    };
    const getSourceWeights = (sectionType: string): { low: number; mid: number; high: number; threshold: number } => {
        const melodic = songFeatures.melodicFocus;
        const percussive = songFeatures.percussiveFocus;
        const sustained = songFeatures.sustainedFocus;
        if (sectionType === 'drop') {
            return {
                low: 0.86 + percussive * 0.16,
                mid: 0.54 + melodic * 0.08,
                high: 0.54 + percussive * 0.12,
                threshold: 0.36,
            };
        }
        if (sectionType === 'chorus') {
            return {
                low: 0.74 + percussive * 0.13,
                mid: 0.62 + melodic * 0.11,
                high: 0.42 + percussive * 0.08,
                threshold: 0.39,
            };
        }
        if (sectionType === 'bridge') {
            return {
                low: 0.26 + percussive * 0.06,
                mid: 0.82 + melodic * 0.16 + sustained * 0.06,
                high: 0.18 + percussive * 0.04,
                threshold: 0.45,
            };
        }
        return {
            low: 0.32 + percussive * 0.08,
            mid: 0.9 + melodic * 0.18 + sustained * 0.04,
            high: 0.14 + percussive * 0.04,
            threshold: 0.43,
        };
    };

    const gridSubdiv = difficulty === 'easy'
        ? [0, 0.5]
        : difficulty === 'normal'
            ? [0, 0.5]
            : [0, 0.25, 0.5, 0.75];
    const tripletSubdiv = [0, 1 / 3, 2 / 3];
    const snapToMusicalGrid = (time: number, sectionType: string): number => {
        const idx = lowerBound(beatPositions, time);
        const start = Math.max(0, idx - 2);
        const end = Math.min(beatPositions.length - 1, idx + 2);
        let best = time;
        let bestScore = Number.POSITIVE_INFINITY;
        for (let i = start; i <= end; i++) {
            const beat = beatPositions[i];
            for (const sub of gridSubdiv) {
                const cand = beat + beatInterval * sub;
                const d = Math.abs(cand - time);
                if (d < bestScore) {
                    bestScore = d;
                    best = cand;
                }
            }
            if (sectionType === 'verse' || sectionType === 'bridge') {
                for (const sub of tripletSubdiv) {
                    const cand = beat + beatInterval * sub;
                    const d = Math.abs(cand - time) * 1.04;
                    if (d < bestScore) {
                        bestScore = d;
                        best = cand;
                    }
                }
            }
        }
        return Math.max(0.02, best);
    };

    const occupancyStep = Math.max(0.03, beatInterval * 0.2);
    const occupancyWin = Math.max(0.06, beatInterval * 0.2);
    const occ = new Set<number>();
    const laneOcc: [Set<number>, Set<number>] = [new Set<number>(), new Set<number>()];
    const toBucket = (time: number): number => Math.round(time / occupancyStep);
    const markOcc = (time: number): void => {
        const b = toBucket(time);
        occ.add(b - 1);
        occ.add(b);
        occ.add(b + 1);
    };
    const markLaneOcc = (time: number, lane: number): void => {
        const safeLane = lane === 0 ? 0 : 1;
        const b = toBucket(time);
        laneOcc[safeLane].add(b - 1);
        laneOcc[safeLane].add(b);
        laneOcc[safeLane].add(b + 1);
    };
    const addNotes: NoteData[] = [];
    for (const n of sortedBase) {
        markOcc(n.time);
        markLaneOcc(n.time, n.lane);
    }
    const hasNear = (time: number): boolean => occ.has(toBucket(time));
    const hasLaneNear = (time: number, lane: number): boolean => {
        const safeLane = lane === 0 ? 0 : 1;
        if (laneOcc[safeLane].has(toBucket(time))) return true;
        const compareLane = safeLane;
        for (let i = addNotes.length - 1; i >= 0; i--) {
            const n = addNotes[i];
            if (n.lane !== compareLane) continue;
            if (Math.abs(n.time - time) < occupancyWin) return true;
            if (n.time < time - occupancyWin * 1.7) break;
        }
        return false;
    };
    const getPrevLane = (time: number): number => {
        const baseIdx = lowerBound(baseTimes, time) - 1;
        if (baseIdx >= 0) return sortedBase[baseIdx].lane;
        for (let i = addNotes.length - 1; i >= 0; i--) {
            if (addNotes[i].time <= time) return addNotes[i].lane;
        }
        return 1;
    };

    const maxAdds = Math.max(8, Math.floor(sortedBase.length * (difficulty === 'easy' ? 0.1 : difficulty === 'normal' ? 0.16 : difficulty === 'hard' ? 0.2 : 0.24)));
    let totalAdded = 0;

    const collectSectionCandidates = (
        pairs: readonly { time: number; strength: number }[],
        pairTimes: readonly number[],
        start: number,
        end: number,
        band: 'low' | 'mid' | 'high',
        weight: number,
        threshold: number,
        sectionType: string
    ): NoteData[] => {
        if (pairs.length === 0 || weight <= 0) return [];
        const i0 = lowerBound(pairTimes, start);
        const i1 = lowerBound(pairTimes, end);
        const candidates: NoteData[] = [];
        for (let i = i0; i < i1; i++) {
            const p = pairs[i];
            const score = p.strength * weight;
            if (score < threshold) continue;
            const snapped = snapToMusicalGrid(p.time, sectionType);
            if (hasNear(snapped)) continue;

            let lane = 1;
            if (band === 'low') lane = 1;
            else if (band === 'high') lane = 0;
            else {
                const prev = getPrevLane(snapped);
                const flip = detHash(Math.round(snapped * 1000) + i * 17) % 5 !== 0;
                lane = flip ? (prev === 0 ? 1 : 0) : prev;
            }
            if (hasLaneNear(snapped, lane)) {
                const alt = lane === 0 ? 1 : 0;
                if (hasLaneNear(snapped, alt)) continue;
                lane = alt;
            }

            candidates.push({
                time: snapped,
                lane,
                type: 'tap',
                strength: Math.max(0.4, Math.min(1, score * 0.92)),
            });
        }
        return candidates;
    };

    for (const section of sortedSections) {
        if (!playableSection(section.type)) continue;
        const secDur = Math.max(0.001, section.endTime - section.startTime);
        if (secDur < beatInterval * 2) continue;

        const weightCfg = getSourceWeights(section.type);
        const baseTarget = section.type === 'drop'
            ? npsTargets[difficulty].drop
            : section.type === 'chorus'
                ? npsTargets[difficulty].chorus
                : section.type === 'bridge'
                    ? npsTargets[difficulty].bridge
                    : npsTargets[difficulty].verse;
        const energyBoost = clamp01(((section.avgEnergy || 0.5) - 0.5) / 0.4) * 0.22;
        const targetNps = baseTarget * (1 + energyBoost);
        const existingBase = lowerBound(baseTimes, section.endTime) - lowerBound(baseTimes, section.startTime);
        let existingAdded = 0;
        for (let i = addNotes.length - 1; i >= 0; i--) {
            const t = addNotes[i].time;
            if (t < section.startTime) break;
            if (t < section.endTime) existingAdded++;
        }
        const existing = existingBase + existingAdded;
        const need = Math.max(0, Math.floor(targetNps * secDur) - existing);
        if (need <= 0) continue;

        const candidates = [
            ...collectSectionCandidates(lowPairs, lowTimes, section.startTime, section.endTime, 'low', weightCfg.low, weightCfg.threshold, section.type),
            ...collectSectionCandidates(midPairs, midTimes, section.startTime, section.endTime, 'mid', weightCfg.mid, weightCfg.threshold, section.type),
            ...collectSectionCandidates(highPairs, highTimes, section.startTime, section.endTime, 'high', weightCfg.high, weightCfg.threshold, section.type),
        ]
            .sort((a, b) => (b.strength ?? 0.5) - (a.strength ?? 0.5));

        let localAdded = 0;
        for (const cand of candidates) {
            if (totalAdded >= maxAdds || localAdded >= need) break;
            if (hasNear(cand.time)) continue;
            if (hasLaneNear(cand.time, cand.lane)) continue;
            addNotes.push(cand);
            markOcc(cand.time);
            markLaneOcc(cand.time, cand.lane);
            localAdded++;
            totalAdded++;
        }
        if (totalAdded >= maxAdds) break;
    }

    if (addNotes.length === 0) return sortedBase;
    return dedupeNotes([...sortedBase, ...addNotes], 0.036);
};

const createPreviewBuffer = (
    buffer: AudioBuffer,
    maxSeconds: number
): AudioBuffer => {
    const sampleRate = buffer.sampleRate;
    const maxSamples = Math.max(1, Math.floor(maxSeconds * sampleRate));
    if (maxSamples >= buffer.length) return buffer;

    if (typeof AudioBuffer !== 'undefined') {
        try {
            const preview = new AudioBuffer({
                length: maxSamples,
                numberOfChannels: buffer.numberOfChannels,
                sampleRate,
            });
            for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
                const src = buffer.getChannelData(ch).subarray(0, maxSamples);
                preview.copyToChannel(src, ch, 0);
            }
            return preview;
        } catch {
            // worker/브라우저 환경 차이 폴백
        }
    }

    const channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => {
        const src = buffer.getChannelData(ch).subarray(0, maxSamples);
        const copy = new Float32Array(maxSamples);
        copy.set(src);
        return copy;
    });
    const fallback = {
        sampleRate,
        length: maxSamples,
        duration: maxSamples / sampleRate,
        numberOfChannels: channels.length,
        getChannelData: (index: number) => channels[index],
    };
    return fallback as unknown as AudioBuffer;
};

type SectionLike = { startTime: number; endTime: number; type: string; avgEnergy: number };

const createSectionLookup = <T extends SectionLike>(sections: readonly T[]) => {
    const sorted = [...sections].sort((a, b) => a.startTime - b.startTime);
    let idx = 0;
    return (time: number): T | undefined => {
        if (sorted.length === 0) return undefined;
        if (time <= sorted[0].startTime) return sorted[0];
        while (idx + 1 < sorted.length && time >= sorted[idx].endTime) idx++;
        while (idx > 0 && time < sorted[idx].startTime) idx--;
        return sorted[idx];
    };
};

const applyComposerPass = (
    notes: readonly NoteData[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    difficulty: Difficulty,
    bpm: number
): NoteData[] => {
    if (notes.length === 0 || beatPositions.length === 0) return [...notes];
    const beatInterval = 60 / bpm;
    const byTime = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const out: NoteData[] = [];
    const sectionAt = createSectionLookup(sections);

    const densityByDifficulty: Record<Difficulty, { min: number; max: number }> = {
        easy: { min: 1, max: 4 },
        normal: { min: 2, max: 7 },
        hard: { min: 4, max: 11 },
        expert: { min: 6, max: 16 },
    };

    const findSectionType = (t: number): string => {
        const sec = sectionAt(t);
        return sec?.type ?? 'verse';
    };

    const sectionMultiplier = (type: string): number => {
        if (type === 'intro' || type === 'outro' || type === 'interlude') return 0;
        if (type === 'drop') return 1.6;
        if (type === 'chorus') return 1.42;
        if (type === 'bridge') return 0.82;
        return 1.0;
    };

    let sourcePtr = 0;
    for (let i = 0; i < beatPositions.length; i += 4) {
        const barStart = beatPositions[i];
        if (barStart === undefined) continue;
        const barEnd = beatPositions[i + 4] ?? (barStart + beatInterval * 4);
        const sectionType = findSectionType(barStart);
        const mult = sectionMultiplier(sectionType);
        if (mult <= 0) continue;

        while (sourcePtr < byTime.length && byTime[sourcePtr].time < barStart) {
            sourcePtr++;
        }
        const inBarStart = sourcePtr;
        while (sourcePtr < byTime.length && byTime[sourcePtr].time < barEnd) {
            sourcePtr++;
        }
        const inBar = byTime.slice(inBarStart, sourcePtr);
        if (inBar.length === 0) {
            // 완전 공백 바 방지 (도입 제외)
            if (sectionType !== 'intro' && sectionType !== 'outro' && sectionType !== 'interlude') {
                const lane = (detHash(Math.round(barStart * 1000)) % 2 === 0) ? 1 : 0;
                out.push({ time: barStart + beatInterval * 0.5, lane, type: 'tap', strength: 0.55 });
            }
            continue;
        }

        const minCount = Math.max(1, Math.floor(densityByDifficulty[difficulty].min * mult));
        const maxCount = Math.max(minCount, Math.ceil(densityByDifficulty[difficulty].max * mult));
        const barOut: NoteData[] = [];

        // downbeat 강세 강화
        let hasDownbeat = false;
        for (const n of inBar) {
            if (Math.abs(n.time - barStart) < beatInterval * 0.18) {
                hasDownbeat = true;
                barOut.push({ ...n, strength: Math.max(0.6, n.strength ?? 0.5) });
            } else {
                barOut.push(n);
            }
        }
        if (!hasDownbeat) {
            const ref = inBar[0];
            barOut.push({
                time: barStart,
                lane: ref?.lane ?? 1,
                type: 'tap',
                strength: Math.max(0.62, ref?.strength ?? 0.55),
            });
        }

        // 바 당 과밀도 제어 (약한 오프비트부터 제거)
        let barNotes = [...barOut]
            .sort((a, b) => {
                const aBeat = Math.abs(((a.time - barStart) / beatInterval) % 1);
                const bBeat = Math.abs(((b.time - barStart) / beatInterval) % 1);
                const aOff = Math.min(aBeat, 1 - aBeat);
                const bOff = Math.min(bBeat, 1 - bBeat);
                return (a.strength ?? 0.5) - (b.strength ?? 0.5) + (bOff - aOff) * 0.2;
            });

        while (barNotes.length > maxCount) {
            const victim = barNotes.shift();
            if (!victim) break;
            const idx = barOut.findIndex(n => n.time === victim.time && n.lane === victim.lane && n.type === victim.type);
            if (idx >= 0) barOut.splice(idx, 1);
            barNotes = [...barOut].sort((a, b) => {
                const aBeat = Math.abs(((a.time - barStart) / beatInterval) % 1);
                const bBeat = Math.abs(((b.time - barStart) / beatInterval) % 1);
                const aOff = Math.min(aBeat, 1 - aBeat);
                const bOff = Math.min(bBeat, 1 - bBeat);
                return (a.strength ?? 0.5) - (b.strength ?? 0.5) + (bOff - aOff) * 0.2;
            });
        }

        // 바 당 너무 적으면 2박 또는 3.5박에 보강
        barNotes = barOut;
        if (barNotes.length < minCount) {
            const supportTimes = [barStart + beatInterval * 2, barStart + beatInterval * 3.5];
            for (const t of supportTimes) {
                if (barNotes.length >= minCount) break;
                const near = barNotes.some(n => Math.abs(n.time - t) < beatInterval * 0.2);
                if (near) continue;
                const lastLane = barNotes[barNotes.length - 1]?.lane ?? 1;
                barOut.push({
                    time: t,
                    lane: lastLane === 0 ? 1 : 0,
                    type: 'tap',
                    strength: 0.5,
                });
                barNotes.push(barOut[barOut.length - 1]);
            }
        }
        out.push(...barOut);
    }

    return dedupeNotes(out, 0.045);
};

const alignNotesToMusicGrid = (
    notes: readonly NoteData[],
    onsets: readonly number[],
    beatPositions: readonly number[],
    bpm: number,
    difficulty: Difficulty
): NoteData[] => {
    if (notes.length === 0 || beatPositions.length === 0) return [...notes];
    const beatInterval = 60 / bpm;
    const halfBeat = beatInterval / 2;
    const quarterBeat = beatInterval / 4;
    const includeQuarter = difficulty === 'hard' || difficulty === 'expert';

    const anchors: number[] = [];
    for (const beat of beatPositions) {
        anchors.push(beat, beat + halfBeat);
        if (includeQuarter) anchors.push(beat + quarterBeat, beat + quarterBeat * 3);
    }
    for (const onset of onsets) anchors.push(onset);
    anchors.sort((a, b) => a - b);

    const maxSnap = Math.max(0.02, beatInterval * 0.12);
    const aligned = notes.map(note => {
        let best = note.time;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const anchor of anchors) {
            const d = Math.abs(anchor - note.time);
            if (d < bestDist) {
                bestDist = d;
                best = anchor;
            }
            if (anchor > note.time + maxSnap) break;
        }
        if (bestDist <= maxSnap) {
            return { ...note, time: best };
        }
        return { ...note };
    });

    return dedupeNotes(aligned, 0.04);
};

const ensurePlayableIntro = (
    notes: readonly NoteData[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures?: BeatMapSongFeatures
): NoteData[] => {
    const sorted = [...notes].sort((a, b) => a.time - b.time);
    if (beatPositions.length === 0) return sorted;
    const sectionAt = createSectionLookup(sections);
    const calmTrack = (songFeatures?.calmConfidence ?? 0.5) >= 0.58;
    if (calmTrack) {
        return sorted;
    }
    const beatInterval = 60 / bpm;
    const minStart = difficulty === 'easy' ? 1.8 : difficulty === 'normal' ? 1.4 : 1.0;

    const firstPlayable = sorted.find(n => {
        const sec = sectionAt(n.time);
        const t = sec?.type ?? 'verse';
        return t !== 'intro' && t !== 'outro' && t !== 'interlude';
    });

    if (firstPlayable && firstPlayable.time <= minStart + 0.9) {
        return sorted;
    }

    const introSectionEnd = sections
        .filter(s => s.type === 'intro')
        .reduce((m, s) => Math.max(m, s.endTime), 0);
    const beginTime = Math.max(minStart, Math.min(introSectionEnd + 0.2, minStart + 1.2));
    const endTime = firstPlayable ? Math.min(firstPlayable.time - 0.4, beginTime + beatInterval * 6) : beginTime + beatInterval * 6;
    if (endTime <= beginTime) return sorted;

    const inject: NoteData[] = [];
    let lane = 1;
    for (const beat of beatPositions) {
        if (beat < beginTime || beat > endTime) continue;
        if (detHash(Math.round(beat * 1000)) % 3 === 0) continue; // 너무 빽빽하면 스킵
        inject.push({ time: beat, lane, type: 'tap', strength: 0.55 });
        lane = lane === 0 ? 1 : 0;
    }

    return dedupeNotes([...sorted, ...inject], 0.045);
};

const ensureMinimumDensity = (
    notes: readonly NoteData[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures?: BeatMapSongFeatures
): NoteData[] => {
    const sorted = [...notes].sort((a, b) => a.time - b.time);
    if (beatPositions.length === 0) return sorted;
    const beatInterval = 60 / bpm;
    const maxTime = beatPositions[beatPositions.length - 1];
    const playableDuration = Math.max(1, maxTime - beatPositions[0]);
    const targetNps: Record<Difficulty, number> = {
        easy: 2.2,
        normal: 5.4,
        hard: 7.8,
        expert: 10.2,
    };
    const activeSections = sections.filter(s => s.type !== 'intro' && s.type !== 'outro' && s.type !== 'interlude');
    const avgEnergy = activeSections.length > 0
        ? activeSections.reduce((acc, s) => acc + (s.avgEnergy || 0.5), 0) / activeSections.length
        : 0.5;
    const tempoBoost = Math.max(0, Math.min(0.32, (bpm - 126) / 230));
    const energyBoost = Math.max(0, Math.min(0.26, (avgEnergy - 0.58) * 0.72));
    const calmSuppress = clamp01((songFeatures?.calmConfidence ?? 0.5) * 0.88 - (songFeatures?.driveScore ?? 0.5) * 0.42);
    const introQuiet = songFeatures?.introQuietness ?? 0.5;
    const sustained = songFeatures?.sustainedFocus ?? 0.5;
    const dynamicRange = songFeatures?.dynamicRange ?? 0.5;
    const quietTrack = calmSuppress >= 0.2
        && introQuiet >= 0.5
        && sustained >= 0.5
        && dynamicRange <= 0.64;
    const densityFactor = 1 - calmSuppress * 0.28;
    const quietScale: Record<Difficulty, number> = {
        easy: 0.96,
        normal: 0.95,
        hard: 0.92,
        expert: 0.97,
    };
    const densityFloorByDiff: Record<Difficulty, number> = {
        easy: 0.56,
        normal: 0.62,
        hard: 0.68,
        expert: 0.78,
    };
    const targetCount = Math.floor(
        playableDuration
        * targetNps[difficulty]
        * (1 + tempoBoost + energyBoost)
        * Math.max(densityFloorByDiff[difficulty], densityFactor)
        * (quietTrack ? quietScale[difficulty] : 1)
    );
    const softTarget = Math.floor(
        targetCount
        * (
            difficulty === 'easy'
                ? 0.92
                : difficulty === 'normal'
                    ? 0.95
                    : difficulty === 'hard'
                        ? 0.98
                        : 1.0
        )
    );
    if (sorted.length >= softTarget) return sorted;

    const need = Math.max(0, softTarget - sorted.length);
    const injected: NoteData[] = [];
    let lane = sorted[sorted.length - 1]?.lane ?? 1;
    let added = 0;
    const firstHighlightTime = sections
        .find(s => s.type === 'drop' || s.type === 'chorus' || (s.avgEnergy || 0.5) >= 0.72)
        ?.startTime ?? Infinity;
    const occupancyWindow = Math.max(0.055, beatInterval * 0.22);
    const occupancyStep = Math.max(0.03, occupancyWindow * 0.55);
    const occupiedBuckets = new Set<number>();
    const toBucket = (time: number): number => Math.round(time / occupancyStep);
    const markOccupied = (time: number): void => {
        const b = toBucket(time);
        occupiedBuckets.add(b - 1);
        occupiedBuckets.add(b);
        occupiedBuckets.add(b + 1);
    };
    for (const n of sorted) {
        markOccupied(n.time);
    }
    let sectionPtr = 0;
    const getSection = (time: number): { type: string; avgEnergy: number } => {
        while (sectionPtr + 1 < sections.length && time >= sections[sectionPtr].endTime) sectionPtr++;
        while (sectionPtr > 0 && time < sections[sectionPtr].startTime) sectionPtr--;
        return sections[sectionPtr] ?? { type: 'verse', avgEnergy: 0.5 };
    };
    const sortedOnsets = sorted.map(n => n.time);

    const candidateTimes: number[] = [];
    let candidatesSorted = true;
    let prevCandidate = -Infinity;
    for (const beat of beatPositions) {
        const c0 = beat;
        candidateTimes.push(c0);
        if (c0 < prevCandidate) candidatesSorted = false;
        prevCandidate = c0;
        if (difficulty !== 'easy') {
            const c1 = beat + beatInterval * 0.5;
            candidateTimes.push(c1);
            if (c1 < prevCandidate) candidatesSorted = false;
            prevCandidate = c1;
        }
    }
    if (!candidatesSorted) {
        candidateTimes.sort((a, b) => a - b);
    }

    let onsetPtr = 0;
    for (let i = 0; i < candidateTimes.length && added < need; i++) {
        const t = candidateTimes[i];
        const sec = getSection(t);
        const type = sec?.type ?? 'verse';
        if (type === 'intro' || type === 'outro' || type === 'interlude') continue;
        const preHighlightQuiet = quietTrack
            && t < firstHighlightTime - beatInterval * 0.35
            && type !== 'drop'
            && type !== 'chorus';
        if (preHighlightQuiet) {
            const strictGate = difficulty === 'easy'
                ? 5
                : difficulty === 'normal'
                    ? 4
                    : difficulty === 'hard'
                        ? 3
                        : 2;
            if (detHash(Math.round(t * 1000) + i * 71) % strictGate !== 0) continue;
        }
        if (calmSuppress > 0.22 && type !== 'chorus' && type !== 'drop' && (sec?.avgEnergy ?? 0.5) < 0.58) {
            const quietGate = difficulty === 'easy' ? 3 : difficulty === 'normal' ? 2 : difficulty === 'hard' ? 2 : 1;
            if (detHash(Math.round(t * 1000) + i * 37) % quietGate !== 0) continue;
        }
        const near = occupiedBuckets.has(toBucket(t));
        if (near) continue;
        const skipModulo = difficulty === 'easy'
            ? 9
            : difficulty === 'normal'
                ? 23
                : difficulty === 'hard'
                ? 29
                : 31;
        if (detHash(Math.round(t * 1000) + i * 17) % skipModulo === 0) continue;
        lane = lane === 0 ? 1 : 0;
        while (onsetPtr + 1 < sortedOnsets.length && sortedOnsets[onsetPtr + 1] <= t) {
            onsetPtr++;
        }
        let onsetDist = Number.POSITIVE_INFINITY;
        if (sortedOnsets.length > 0) {
            onsetDist = Math.abs(sortedOnsets[onsetPtr] - t);
            if (onsetPtr + 1 < sortedOnsets.length) {
                onsetDist = Math.min(onsetDist, Math.abs(sortedOnsets[onsetPtr + 1] - t));
            }
            if (onsetPtr > 0) {
                onsetDist = Math.min(onsetDist, Math.abs(sortedOnsets[onsetPtr - 1] - t));
            }
        }
        const onsetProximity = Math.max(0, 1 - (onsetDist / Math.max(0.04, beatInterval * 0.28)));
        const note = {
            time: t,
            lane,
            type: 'tap' as const,
            strength: Math.min(0.68, 0.5 + onsetProximity * 0.16),
        };
        injected.push(note);
        markOccupied(note.time);
        added++;
    }
    return dedupeNotes([...sorted, ...injected], 0.045);
};

const resolveLeadingIntroEnd = (
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[]
): number => {
    if (sections.length === 0) return 0;
    const sorted = [...sections].sort((a, b) => a.startTime - b.startTime);
    let end = 0;
    for (const sec of sorted) {
        if (sec.startTime > end + 0.12) break;
        const introLike = sec.type === 'intro';
        if (!introLike) break;
        end = Math.max(end, sec.endTime);
    }
    return end;
};

const resolveIntroCutoff = (
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    bpm: number,
    difficulty: Difficulty,
    duration: number,
    songFeatures?: BeatMapSongFeatures
): number => {
    const calmConfidence = songFeatures?.calmConfidence ?? 0.5;
    const introQuiet = songFeatures?.introQuietness ?? 0.5;
    const sustained = songFeatures?.sustainedFocus ?? 0.5;
    const calmScore = clamp01(calmConfidence * 0.52 + introQuiet * 0.34 + sustained * 0.14);
    const calmTrack = calmScore >= 0.56;
    const deepCalm = calmScore >= 0.68 && introQuiet >= 0.56;
    const maxIntroByDiff: Record<Difficulty, number> = {
        easy: Math.min(deepCalm ? 16 : calmTrack ? 12 : 9, duration * (deepCalm ? 0.24 : calmTrack ? 0.18 : 0.13)),
        normal: Math.min(deepCalm ? 13 : calmTrack ? 10 : 8, duration * (deepCalm ? 0.2 : calmTrack ? 0.16 : 0.12)),
        hard: Math.min(deepCalm ? 10 : calmTrack ? 8 : 6.5, duration * (deepCalm ? 0.16 : calmTrack ? 0.13 : 0.1)),
        expert: Math.min(deepCalm ? 5.5 : calmTrack ? 4.4 : 3.6, duration * (deepCalm ? 0.1 : calmTrack ? 0.085 : 0.07)),
    };
    const sectionIntroEnd = resolveLeadingIntroEnd(sections);
    const firstPlayableStart = [...sections]
        .sort((a, b) => a.startTime - b.startTime)
        .find(s => s.type !== 'intro' && s.type !== 'interlude' && s.type !== 'outro')
        ?.startTime ?? Infinity;

    let cutoff = 0;
    for (const s of sections) {
        const leading = s.startTime <= cutoff + 0.08;
        if (!leading) break;
        const introLike = s.type === 'intro';
        if (!introLike) break;
        cutoff = Math.max(cutoff, s.endTime);
    }

    // 섹션 기반 컷오프가 약할 때, 초반 onset 밀도 기반으로 도입부를 보강 감지
    const windowSec = Math.min(10, Math.max(5, duration * 0.14));
    let weightedOnset = 0;
    let strongOnset = 0;
    let introOnsetCount = 0;
    for (let i = 0; i < onsetTimes.length; i++) {
        const t = onsetTimes[i];
        if (t < 0 || t > windowSec) continue;
        introOnsetCount++;
        const s = onsetStrengths[i] ?? 0.5;
        const weighted = clamp01((s - 0.34) / 0.66);
        weightedOnset += weighted;
        if (s >= 0.68) strongOnset++;
    }
    const onsetDensity = weightedOnset / Math.max(1, windowSec);
    const strongDensity = strongOnset / Math.max(1, windowSec);
    const beatPerSec = bpm > 0 ? bpm / 60 : 2;
    const sparseIntro = onsetDensity < beatPerSec * (calmTrack ? 0.38 : 0.34)
        && strongDensity < beatPerSec * (calmTrack ? 0.14 : 0.2);
    if (cutoff < 0.8 && sparseIntro) {
        cutoff = Math.min(windowSec * (calmTrack ? 0.62 : 0.56), maxIntroByDiff[difficulty]);
    }

    const firstHighlightStart = sections.find(s =>
        s.startTime > 0.55
        && (s.type === 'drop' || s.type === 'chorus' || (s.avgEnergy || 0.5) >= 0.74)
    )?.startTime ?? Infinity;
    if (calmTrack && Number.isFinite(firstHighlightStart)) {
        const preRoll = Math.max(0.38, Math.min(1.2, (60 / Math.max(1, bpm)) * 1.15));
        const targetCutoff = Math.max(0, firstHighlightStart - preRoll);
        const calmBlend = deepCalm ? 1 : 0.9;
        cutoff = Math.max(cutoff, targetCutoff * calmBlend);
    }

    const strongTimes: number[] = [];
    const strongThreshold = calmTrack ? 0.72 : 0.68;
    for (let i = 0; i < onsetTimes.length; i++) {
        const t = onsetTimes[i];
        if (t < 0 || t > Math.min(duration * 0.42, 28)) continue;
        const s = onsetStrengths[i] ?? 0.5;
        if (s >= strongThreshold) strongTimes.push(t);
    }
    if (strongTimes.length >= 2) {
        let burstStart = -1;
        for (let i = 0; i < strongTimes.length - 1; i++) {
            if (strongTimes[i + 1] - strongTimes[i] <= Math.max(0.6, 60 / Math.max(1, bpm) * 1.4)) {
                burstStart = strongTimes[i];
                break;
            }
        }
        if (burstStart > 0.8) {
            const preRoll = calmTrack ? 0.35 : 0.22;
            cutoff = Math.max(cutoff, burstStart - preRoll);
        }
    }

    if (calmTrack && cutoff > 0.2) {
        const introStrengthAvg = weightedOnset / Math.max(1, introOnsetCount);
        if (introStrengthAvg < 0.44) {
            cutoff = Math.min(maxIntroByDiff[difficulty], cutoff + Math.min(beatPerSec * 0.45, 1.1));
        }
    }

    const introBound = Math.min(
        maxIntroByDiff[difficulty],
        sectionIntroEnd > 0 ? sectionIntroEnd + beatPerSec * 0.75 : maxIntroByDiff[difficulty],
        Number.isFinite(firstPlayableStart) ? Math.max(0, firstPlayableStart - beatPerSec * 0.22) : maxIntroByDiff[difficulty]
    );
    return Math.max(0, Math.min(introBound, cutoff));
};

const pruneIntroNotes = (
    notes: readonly NoteData[],
    introCutoff: number,
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[]
): NoteData[] => {
    if (introCutoff <= 0.25) return [...notes];
    const sectionAt = createSectionLookup(sections);
    const pruned = notes.filter(n => {
        if (n.time >= introCutoff - 0.02) return true;
        const secType = sectionAt(n.time)?.type ?? 'verse';
        return secType !== 'intro';
    });
    return dedupeNotes(pruned, 0.04);
};

const enforceIntroBalance = (
    notes: readonly NoteData[],
    introCutoff: number,
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures?: BeatMapSongFeatures
): NoteData[] => {
    const sorted = [...notes].sort((a, b) => a.time - b.time);
    if (sorted.length === 0) return sorted;
    const sectionIntroEnd = resolveLeadingIntroEnd(sections);
    const beatInterval = 60 / Math.max(1, bpm);
    const introEnd = Math.max(introCutoff, sectionIntroEnd);
    if (introEnd <= 0.25) return sorted;

    const calm = songFeatures?.calmConfidence ?? 0.5;
    const introQuiet = songFeatures?.introQuietness ?? 0.5;
    const sustained = songFeatures?.sustainedFocus ?? 0.5;
    const quietness = clamp01(calm * 0.62 + introQuiet * 0.38);
    const deepCalm = quietness >= 0.66 && sustained >= 0.54;
    const baseCap: Record<Difficulty, number> = {
        easy: 1,
        normal: 2,
        hard: 4,
        expert: 6,
    };
    const cap = Math.max(
        1,
        Math.round(
            baseCap[difficulty]
            * (1 - quietness * 0.62)
            * (deepCalm ? 0.62 : 1)
        )
    );
    const lockUntil = quietness >= 0.56
        ? Math.max(1.65, beatInterval * 3.15)
        : Math.max(0.7, beatInterval * 1.45);
    const introWindowEnd = introEnd + beatInterval * 0.18;

    const introIdx: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].time < introWindowEnd) introIdx.push(i);
        else break;
    }
    if (introIdx.length === 0) return sorted;

    const scored = introIdx.map(idx => {
        const note = sorted[idx];
        const strength = note.strength ?? 0.5;
        const isLong = (note.type === 'slide' || note.type === 'hold') && (note.duration ?? 0) >= beatInterval * 0.75;
        const earlyPenalty = note.time < lockUntil ? (deepCalm ? 0.34 : 0.26) : 0;
        const score = strength * 0.68
            + (isLong ? 0.34 : 0)
            - earlyPenalty
            + (note.type === 'slide' ? 0.12 : 0);
        return { idx, score, isLong };
    }).sort((a, b) => b.score - a.score);

    const keep = new Set<number>();
    const laneLastTime = new Map<number, number>();
    const minGap = Math.max(0.09, beatInterval * (quietness >= 0.56 ? 0.52 : 0.36));
    for (const item of scored) {
        const note = sorted[item.idx];
        const strength = note.strength ?? 0.5;
        if (!item.isLong && keep.size >= cap) continue;
        if (note.time < lockUntil && !item.isLong && strength < (deepCalm ? 0.9 : 0.84)) continue;
        const lane = note.lane;
        const prevLaneTime = laneLastTime.get(lane) ?? -Infinity;
        if (note.time - prevLaneTime < minGap) continue;
        keep.add(item.idx);
        laneLastTime.set(lane, note.time);
    }

    const out: NoteData[] = [];
    for (let i = 0; i < sorted.length; i++) {
        const note = sorted[i];
        if (note.time >= introWindowEnd || keep.has(i)) {
            out.push(note);
        }
    }
    return dedupeNotes(out, 0.04);
};

const applyHumanizedPostProcess = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    beatPositions: readonly number[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length <= 2) return [...notes];
    const beatInterval = 60 / Math.max(1, bpm);
    const barDuration = beatInterval * 4;
    const adjusted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const sectionLookup = createSectionLookup(sections);
    const sectionAt = (time: number): { type: string; avgEnergy: number } =>
        sectionLookup(time) ?? { type: 'verse', avgEnergy: 0.5 };

    if (barDuration > 0.1 && songFeatures.calmConfidence < 0.78) {
        let previousPattern = '';
        let repeatCount = 0;
        const maxTime = adjusted[adjusted.length - 1]?.time ?? 0;
        for (let barStart = 0; barStart <= maxTime; barStart += barDuration) {
            const barEnd = barStart + barDuration;
            const entries: Array<{ idx: number; rel: number; lane: number; type: NoteData['type'] }> = [];
            for (let i = 0; i < adjusted.length; i++) {
                const n = adjusted[i];
                if (n.time >= barStart && n.time < barEnd) {
                    entries.push({
                        idx: i,
                        rel: Math.round(((n.time - barStart) / Math.max(0.001, beatInterval)) * 2) / 2,
                        lane: n.lane,
                        type: n.type,
                    });
                }
            }
            if (entries.length === 0) {
                previousPattern = '';
                repeatCount = 0;
                continue;
            }
            const signature = entries.map(e => `${e.rel}:${e.lane}:${e.type}`).join('|');
            if (signature === previousPattern) repeatCount++;
            else repeatCount = 0;
            previousPattern = signature;
            if (repeatCount < 2) continue;

            for (const entry of entries) {
                const note = adjusted[entry.idx];
                if (note.type !== 'tap') continue;
                const sec = sectionAt(note.time);
                if (sec.type === 'drop' || sec.type === 'chorus') continue;
                const gate = detHash(Math.round(note.time * 1000) + entry.idx * 13);
                if (gate % 3 !== 0) continue;
                const flippedLane = note.lane === 0 ? 1 : 0;
                const conflict = entries.some(other =>
                    other.idx !== entry.idx
                    && adjusted[other.idx].lane === flippedLane
                    && Math.abs(adjusted[other.idx].time - note.time) < beatInterval * 0.12
                );
                if (conflict) continue;
                adjusted[entry.idx] = { ...note, lane: flippedLane };
            }
        }
    }

    const removeSet = new Set<number>();
    const windowBars = difficulty === 'expert' ? 4 : difficulty === 'hard' ? 4 : 5;
    const windowDuration = barDuration * windowBars;
    if (windowDuration > 0.2) {
        const maxTime = adjusted[adjusted.length - 1]?.time ?? 0;
        for (let ws = 0; ws <= maxTime; ws += windowDuration) {
            const we = ws + windowDuration;
            const idxs: number[] = [];
            for (let i = 0; i < adjusted.length; i++) {
                if (removeSet.has(i)) continue;
                const t = adjusted[i].time;
                if (t >= ws && t < we) idxs.push(i);
            }
            if (idxs.length < 7) continue;

            let maxGap = 0;
            let prev = ws;
            for (const idx of idxs) {
                const t = adjusted[idx].time;
                maxGap = Math.max(maxGap, t - prev);
                prev = t;
            }
            maxGap = Math.max(maxGap, we - prev);
            if (maxGap >= beatInterval * 1.02) continue;

            let removeIdx = -1;
            let removeScore = Number.POSITIVE_INFINITY;
            for (const idx of idxs) {
                const note = adjusted[idx];
                if (note.type !== 'tap') continue;
                const sec = sectionAt(note.time);
                if (sec.type === 'drop' || sec.type === 'chorus') continue;
                const score = (note.strength ?? 0.5)
                    + (sec.type === 'verse' ? 0.12 : 0)
                    + (sec.avgEnergy > 0.66 ? 0.08 : 0);
                if (score < removeScore) {
                    removeScore = score;
                    removeIdx = idx;
                }
            }
            if (removeIdx >= 0) removeSet.add(removeIdx);
        }
    }

    const add: NoteData[] = [];
    const highlightSections = sections.filter(s => s.type === 'chorus' || s.type === 'drop');
    for (const sec of highlightSections) {
        const start = sec.startTime;
        const preStart = Math.max(0, start - beatInterval * 1.9);
        const preEnd = Math.max(preStart, start - beatInterval * 0.32);
        const removable = adjusted
            .map((n, i) => ({ n, i }))
            .filter(e =>
                !removeSet.has(e.i)
                && e.n.time >= preStart
                && e.n.time < preEnd
                && e.n.type === 'tap'
                && (e.n.strength ?? 0.5) < 0.82
            )
            .sort((a, b) => (a.n.strength ?? 0.5) - (b.n.strength ?? 0.5));
        const trimCount = difficulty === 'expert' ? 2 : 1;
        for (let i = 0; i < trimCount; i++) {
            const target = removable[i];
            if (!target) break;
            removeSet.add(target.i);
        }

        const hasAnchor = adjusted.some((n, i) =>
            !removeSet.has(i)
            && Math.abs(n.time - start) < beatInterval * 0.16
        ) || add.some(n => Math.abs(n.time - start) < beatInterval * 0.16);
        if (!hasAnchor) {
            let prev: NoteData | undefined;
            for (let i = adjusted.length - 1; i >= 0; i--) {
                if (removeSet.has(i)) continue;
                if (adjusted[i].time < start) {
                    prev = adjusted[i];
                    break;
                }
            }
            const lane = prev ? (prev.lane === 0 ? 1 : 0) : 1;
            add.push({
                time: start,
                lane,
                type: 'tap',
                strength: 0.86,
            });
        }
    }

    const out = adjusted.filter((_, idx) => !removeSet.has(idx));
    return dedupeNotes([...out, ...add], 0.036);
};

const enforceSectionDensityContinuity = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    beatPositions: readonly number[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length <= 2 || sections.length === 0) return [...notes];
    const beatInterval = 60 / Math.max(1, bpm);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const orderedSections = [...sections].sort((a, b) => a.startTime - b.startTime);
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const playable = (type: string): boolean =>
        type !== 'intro' && type !== 'outro' && type !== 'interlude';
    const firstHighlightStart = orderedSections.find(s =>
        s.type === 'drop' || s.type === 'chorus' || (s.avgEnergy || 0.5) >= 0.72
    )?.startTime ?? Infinity;

    const calm = songFeatures.calmConfidence;
    const introQuiet = songFeatures.introQuietness;
    const preHighlightCalm = calm >= 0.54 && introQuiet >= 0.48;
    const preHighlightCapByDiff: Record<Difficulty, number> = {
        easy: 0.5,
        normal: 0.82,
        hard: 1.12,
        expert: 1.42,
    };
    const removeSet = new Set<number>();
    let prevPlayableNps = 0;
    const boost: NoteData[] = [];

    const nearestBeat = (time: number): number => {
        if (beatPositions.length === 0) return time;
        const idx = lowerBound(beatPositions, time);
        const start = Math.max(0, idx - 2);
        const end = Math.min(beatPositions.length - 1, idx + 2);
        let best = beatPositions[Math.max(0, Math.min(beatPositions.length - 1, idx))];
        let bestDist = Math.abs(best - time);
        for (let i = start; i <= end; i++) {
            const b = beatPositions[i];
            const h = b + beatInterval * 0.5;
            const d1 = Math.abs(b - time);
            const d2 = Math.abs(h - time);
            if (d1 < bestDist) {
                bestDist = d1;
                best = b;
            }
            if (d2 < bestDist) {
                bestDist = d2;
                best = h;
            }
        }
        return best;
    };

    const noteTimes = sorted.map(n => n.time);
    for (let si = 0; si < orderedSections.length; si++) {
        const section = orderedSections[si];
        if (!playable(section.type)) continue;
        const secStart = section.startTime;
        const secEnd = section.endTime;
        const secDur = Math.max(0.001, secEnd - secStart);

        const i0 = lowerBound(noteTimes, secStart);
        const i1 = lowerBound(noteTimes, secEnd);
        const sectionIndices: number[] = [];
        for (let i = i0; i < i1; i++) {
            if (!removeSet.has(i)) sectionIndices.push(i);
        }
        if (sectionIndices.length === 0) {
            prevPlayableNps = Math.max(0.001, prevPlayableNps * 0.9);
            continue;
        }

        const nps = sectionIndices.length / secDur;
        const isHighlight = section.type === 'drop'
            || section.type === 'chorus'
            || (section.avgEnergy || 0.5) >= 0.72;

        if (
            preHighlightCalm
            && secStart < firstHighlightStart - beatInterval * 0.25
            && !isHighlight
        ) {
            const cap = preHighlightCapByDiff[difficulty] * (0.86 + (1 - calm) * 0.26);
            if (nps > cap) {
                const keepLong = (idx: number): boolean => {
                    const n = sorted[idx];
                    return (n.type === 'slide' || n.type === 'hold') && (n.duration ?? 0) >= beatInterval * 0.8;
                };
                const removable = sectionIndices
                    .filter(idx => !keepLong(idx))
                    .map(idx => {
                        const n = sorted[idx];
                        const score = (n.strength ?? 0.5)
                            + (n.type === 'tap' ? 0 : 0.16)
                            + Math.max(0, (n.time - secStart) / Math.max(0.001, secDur)) * 0.14;
                        return { idx, score };
                    })
                    .sort((a, b) => a.score - b.score);
                const targetKeep = Math.max(1, Math.floor(cap * secDur));
                let toRemove = Math.max(0, sectionIndices.length - targetKeep);
                for (const r of removable) {
                    if (toRemove <= 0) break;
                    removeSet.add(r.idx);
                    toRemove--;
                }
            }
        }

        let updatedCount = sectionIndices.filter(idx => !removeSet.has(idx)).length;
        let updatedNps = updatedCount / secDur;

        if (!isHighlight && prevPlayableNps > 0.64) {
            const riseCap = difficulty === 'easy'
                ? 1.52
                : difficulty === 'normal'
                    ? 1.68
                    : difficulty === 'hard'
                        ? 1.84
                        : 2.02;
            const allowed = prevPlayableNps * riseCap;
            if (updatedNps > allowed) {
                const removable = sectionIndices
                    .filter(idx => !removeSet.has(idx))
                    .map(idx => {
                        const n = sorted[idx];
                        const secProgress = Math.max(0, Math.min(1, (n.time - secStart) / Math.max(0.001, secDur)));
                        const isLong = n.type === 'slide' || n.type === 'hold';
                        const score = (n.strength ?? 0.5)
                            + (isLong ? 0.3 : 0)
                            + secProgress * 0.08;
                        return { idx, score };
                    })
                    .sort((a, b) => a.score - b.score);
                let toRemove = Math.max(0, Math.floor((updatedNps - allowed) * secDur));
                for (const r of removable) {
                    if (toRemove <= 0) break;
                    removeSet.add(r.idx);
                    toRemove--;
                }
                updatedCount = sectionIndices.filter(idx => !removeSet.has(idx)).length;
                updatedNps = updatedCount / secDur;
            }
        }

        if (isHighlight && prevPlayableNps > 0.5) {
            const minRatio = difficulty === 'easy'
                ? 0.78
                : difficulty === 'normal'
                    ? 0.84
                    : difficulty === 'hard'
                        ? 0.88
                        : 0.9;
            const required = prevPlayableNps * minRatio;
            if (updatedNps < required) {
                const need = Math.max(1, Math.floor((required - updatedNps) * secDur));
                let lane = sectionIndices.length > 0 ? sorted[sectionIndices[sectionIndices.length - 1]].lane : 1;
                let added = 0;
                for (let t = secStart; t < Math.min(secEnd, secStart + beatInterval * 2.5) && added < need; t += beatInterval * 0.5) {
                    const snapped = nearestBeat(t);
                    const nearExisting = sorted.some((n, idx) =>
                        !removeSet.has(idx)
                        && Math.abs(n.time - snapped) < beatInterval * 0.18
                        && n.lane === lane
                    ) || boost.some(n => Math.abs(n.time - snapped) < beatInterval * 0.18 && n.lane === lane);
                    if (nearExisting) continue;
                    lane = lane === 0 ? 1 : 0;
                    boost.push({
                        time: snapped,
                        lane,
                        type: 'tap',
                        strength: 0.62,
                    });
                    added++;
                }
                updatedNps = (updatedCount + added) / secDur;
            }
        }

        if (!isHighlight && prevPlayableNps > 0.96) {
            const fallFloor = difficulty === 'easy'
                ? 0.44
                : difficulty === 'normal'
                    ? 0.48
                    : difficulty === 'hard'
                        ? 0.52
                        : 0.56;
            const required = prevPlayableNps * fallFloor;
            if (updatedNps < required) {
                const need = Math.max(1, Math.floor((required - updatedNps) * secDur));
                let lane = sectionIndices.length > 0 ? sorted[sectionIndices[0]].lane : 1;
                let added = 0;
                for (let t = secStart + beatInterval * 0.5; t < secEnd - beatInterval * 0.2 && added < need; t += beatInterval) {
                    const snapped = nearestBeat(t);
                    const nearExisting = sorted.some((n, idx) =>
                        !removeSet.has(idx)
                        && Math.abs(n.time - snapped) < beatInterval * 0.2
                        && n.lane === lane
                    ) || boost.some(n =>
                        Math.abs(n.time - snapped) < beatInterval * 0.2
                        && n.lane === lane
                    );
                    if (nearExisting) continue;
                    lane = lane === 0 ? 1 : 0;
                    boost.push({
                        time: snapped,
                        lane,
                        type: 'tap',
                        strength: 0.58,
                    });
                    added++;
                }
                updatedNps = (updatedCount + added) / secDur;
            }
        }

        prevPlayableNps = updatedNps;
    }

    const trimmed = sorted.filter((_, idx) => !removeSet.has(idx));
    if (boost.length === 0) return dedupeNotes(trimmed, 0.036);
    return dedupeNotes([...trimmed, ...boost], 0.036);
};

const alignCalmSectionsToStrongGrid = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    beatPositions: readonly number[],
    bpm: number,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length <= 2 || beatPositions.length === 0) return [...notes];
    if (songFeatures.calmConfidence < 0.5 && songFeatures.sustainedFocus < 0.52) {
        return [...notes];
    }

    const beatInterval = 60 / Math.max(1, bpm);
    const calmBias = clamp01(songFeatures.calmConfidence * 0.62 + songFeatures.sustainedFocus * 0.38);
    const maxSnap = Math.max(0.035, beatInterval * (0.16 + calmBias * 0.1));
    const sortedBeats = [...beatPositions].sort((a, b) => a - b);
    const sectionLookup = createSectionLookup(sections);
    const sectionAt = (time: number): { type: string; avgEnergy: number } =>
        sectionLookup(time) ?? { type: 'verse', avgEnergy: 0.5 };
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    const aligned = notes.map(note => {
        const sec = sectionAt(note.time);
        const nonHighlight = sec.type !== 'drop' && sec.type !== 'chorus';
        if (!nonHighlight) return { ...note };
        if (note.type !== 'tap') return { ...note };
        const strength = note.strength ?? 0.5;
        if (strength >= 0.82) return { ...note };

        const idx = lowerBound(sortedBeats, note.time);
        const start = Math.max(0, idx - 2);
        const end = Math.min(sortedBeats.length - 1, idx + 2);
        let best = note.time;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = start; i <= end; i++) {
            const b = sortedBeats[i];
            const candidates = [b, b + beatInterval * 0.5, b + beatInterval / 3, b + beatInterval * (2 / 3)];
            for (const cand of candidates) {
                const d = Math.abs(cand - note.time);
                if (d < bestDist) {
                    bestDist = d;
                    best = cand;
                }
            }
        }
        if (bestDist > maxSnap) return { ...note };
        const moveRatio = Math.max(0.62, 0.9 - strength * 0.3);
        return {
            ...note,
            time: lerp(note.time, best, moveRatio),
        };
    });

    return dedupeNotes(aligned, 0.036);
};

const suppressCalmPreludeDensity = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length <= 6) return [...notes];
    const calmScore = clamp01(
        songFeatures.calmConfidence * 0.52
        + songFeatures.introQuietness * 0.33
        + songFeatures.sustainedFocus * 0.15
    );
    const leadSection = sections.find(s => s.startTime <= 0.25);
    const leadIsQuiet = !!leadSection
        && (
            leadSection.type === 'intro'
            || leadSection.type === 'interlude'
            || (leadSection.avgEnergy || 0.5) <= 0.48
        );
    const softIntroCue = leadIsQuiet
        || (
            songFeatures.introQuietness >= 0.48
            && songFeatures.sustainedFocus >= 0.48
            && songFeatures.percussiveFocus <= 0.62
        );
    if (calmScore < 0.56 && !softIntroCue) return [...notes];

    const beatInterval = 60 / Math.max(1, bpm);
    const firstHighlightStart = sections.find(s =>
        s.startTime > 0.55
        && (s.type === 'drop' || s.type === 'chorus' || (s.avgEnergy || 0.5) >= 0.72)
    )?.startTime ?? Number.POSITIVE_INFINITY;
    let preludeEnd = Number.isFinite(firstHighlightStart)
        ? Math.max(0.8, firstHighlightStart - beatInterval * 0.3)
        : Math.min(16, Math.max(8, notes[notes.length - 1].time * 0.2));
    if (softIntroCue && Number.isFinite(firstHighlightStart)) {
        preludeEnd = Math.max(preludeEnd, Math.max(1.2, firstHighlightStart - beatInterval * 0.22));
    }
    if (preludeEnd <= 1.1) return [...notes];

    const sectionLookup = createSectionLookup(sections);
    const capNps: Record<Difficulty, number> = {
        easy: 0.46,
        normal: 0.72,
        hard: 0.98,
        expert: 1.18,
    };
    const quietBias = softIntroCue ? 0.92 : 1;
    const targetCap = capNps[difficulty] * (0.88 + (1 - calmScore) * 0.26) * quietBias;
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const removeSet = new Set<number>();
    const windowSec = Math.max(1.8, Math.min(3.4, beatInterval * 5.6));
    const hopSec = windowSec * 0.5;

    const noteTimes = sorted.map(n => n.time);
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    for (let ws = 0; ws < preludeEnd; ws += hopSec) {
        const we = Math.min(preludeEnd, ws + windowSec);
        const dur = Math.max(0.001, we - ws);
        const i0 = lowerBound(noteTimes, ws);
        const i1 = lowerBound(noteTimes, we);
        const idxs: number[] = [];
        for (let i = i0; i < i1; i++) {
            if (removeSet.has(i)) continue;
            const n = sorted[i];
            const sec = sectionLookup(n.time);
            const type = sec?.type ?? 'verse';
            if (type === 'drop' || type === 'chorus') continue;
            idxs.push(i);
        }
        if (idxs.length === 0) continue;
        const nps = idxs.length / dur;
        if (nps <= targetCap) continue;

        const windowCenter = ws + dur * 0.5;
        const preludeRatio = Math.max(0, Math.min(1, windowCenter / Math.max(0.001, preludeEnd)));
        const earlyTighten = softIntroCue ? (1.08 - preludeRatio * 0.12) : (1.02 - preludeRatio * 0.08);
        let toRemove = Math.max(1, Math.ceil((nps - targetCap) * dur * earlyTighten));
        const removable = idxs
            .map(idx => {
                const n = sorted[idx];
                const isLong = n.type === 'slide' || n.type === 'hold';
                const sec = sectionLookup(n.time);
                const secEnergy = sec?.avgEnergy ?? 0.5;
                const earlyRatio = 1 - Math.max(0, Math.min(1, n.time / Math.max(0.001, preludeEnd)));
                const weakTapPenalty = n.type === 'tap' ? earlyRatio * (softIntroCue ? 0.3 : 0.18) : 0;
                const score = (n.strength ?? 0.5)
                    + (isLong ? 0.44 : 0)
                    + (secEnergy > 0.66 ? 0.12 : 0)
                    + (n.type === 'burst' ? 0.5 : 0)
                    - weakTapPenalty;
                return { idx, score };
            })
            .sort((a, b) => a.score - b.score);
        for (const cand of removable) {
            if (toRemove <= 0) break;
            removeSet.add(cand.idx);
            toRemove--;
        }
    }

    if (removeSet.size === 0) return sorted;
    const out = sorted.filter((_, idx) => !removeSet.has(idx));
    return dedupeNotes(out, 0.036);
};

const resolveSlideTargetLane = (note: Pick<NoteData, 'lane' | 'targetLane'>): number =>
    note.targetLane ?? (note.lane === 0 ? 1 : 0);

const uniqueLanes = (lanes: readonly number[]): number[] => {
    const out: number[] = [];
    for (const lane of lanes) {
        if (!out.includes(lane)) out.push(lane);
    }
    return out;
};

const getNoteLanes = (note: Pick<NoteData, 'type' | 'lane' | 'targetLane'>): number[] => {
    if (note.type === 'slide') {
        return uniqueLanes([note.lane, resolveSlideTargetLane(note)]);
    }
    return [note.lane];
};

const getOccupiedControlLanes = (note: Pick<NoteData, 'type' | 'lane' | 'targetLane'>): number[] => {
    if (note.type === 'slide') {
        const toLane = resolveSlideTargetLane(note);
        // 대각선 슬라이드는 경로상 양 레인을 모두 점유로 처리해
        // 중간 물리 불가능 탭이 끼어드는 것을 방지한다.
        if (toLane !== note.lane) {
            return uniqueLanes([note.lane, toLane]);
        }
        return [note.lane];
    }
    return [note.lane];
};

const lanesOverlap = (a: readonly number[], b: readonly number[]): boolean =>
    a.some(lane => b.includes(lane));

const reducePresetLikeLaneLoops = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length < 8 || bpm <= 0) return [...notes];
    const beatInterval = 60 / bpm;
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const sectionAt = createSectionLookup(sections);
    const mutableTap = (idx: number): boolean => {
        const note = sorted[idx];
        if (!note || note.type !== 'tap') return false;
        const sec = sectionAt(note.time);
        const type = sec?.type ?? 'verse';
        return type !== 'intro' && type !== 'outro' && type !== 'interlude';
    };

    const canFlipLane = (idx: number): boolean => {
        const note = sorted[idx];
        if (!note) return false;
        const targetLane = note.lane === 0 ? 1 : 0;
        const win = Math.max(0.04, beatInterval * 0.13);
        const start = Math.max(0, idx - 8);
        const end = Math.min(sorted.length - 1, idx + 8);
        for (let i = start; i <= end; i++) {
            if (i === idx) continue;
            const other = sorted[i];
            if (!other) continue;
            if (Math.abs(other.time - note.time) >= win) continue;
            const otherLanes = getNoteLanes(other);
            if (otherLanes.includes(targetLane)) return false;
        }
        return true;
    };

    const tapIndices = sorted
        .map((n, idx) => ({ n, idx }))
        .filter(entry => entry.n.type === 'tap')
        .map(entry => entry.idx);

    if (tapIndices.length >= 12) {
        let prevSig = '';
        let streak = 0;
        for (let k = 0; k + 3 < tapIndices.length; k++) {
            const idxs = [tapIndices[k], tapIndices[k + 1], tapIndices[k + 2], tapIndices[k + 3]];
            if (!idxs.every(mutableTap)) {
                prevSig = '';
                streak = 0;
                continue;
            }
            const t0 = sorted[idxs[0]].time;
            const t3 = sorted[idxs[3]].time;
            if (t3 - t0 > beatInterval * 3.45) {
                prevSig = '';
                streak = 0;
                continue;
            }

            let wideGap = false;
            const deltas: string[] = [];
            for (let i = 1; i < idxs.length; i++) {
                const dtBeat = (sorted[idxs[i]].time - sorted[idxs[i - 1]].time) / Math.max(0.001, beatInterval);
                if (dtBeat > 1.5) {
                    wideGap = true;
                    break;
                }
                deltas.push(String(Math.round(dtBeat * 4) / 4));
            }
            if (wideGap) {
                prevSig = '';
                streak = 0;
                continue;
            }

            const laneSig = idxs.map(idx => sorted[idx].lane).join('');
            const signature = `${laneSig}|${deltas.join(',')}`;
            if (signature === prevSig) streak++;
            else streak = 0;
            prevSig = signature;
            if (streak < 1) continue;

            const lane0Count = idxs.reduce((acc, idx) => acc + (sorted[idx].lane === 0 ? 1 : 0), 0);
            const dominantLane = lane0Count >= 3 ? 0 : lane0Count <= 1 ? 1 : -1;
            const candidates = dominantLane >= 0
                ? [
                    ...idxs.filter(idx => sorted[idx].lane === dominantLane),
                    ...idxs.filter(idx => sorted[idx].lane !== dominantLane),
                ]
                : [idxs[1], idxs[2], idxs[0], idxs[3]];
            let flipped = false;
            for (const idx of candidates) {
                if (!mutableTap(idx)) continue;
                if (!canFlipLane(idx)) continue;
                sorted[idx] = {
                    ...sorted[idx],
                    lane: sorted[idx].lane === 0 ? 1 : 0,
                    strength: Math.max(0.45, (sorted[idx].strength ?? 0.5) * 0.98),
                };
                flipped = true;
                break;
            }
            if (flipped) {
                prevSig = '';
                streak = 0;
            }
        }
    }

    // 한 레인 과점(8노트 중 6노트 이상)을 완화해 "3하단+1상단" 류 루프를 줄인다.
    const dominanceWindow = 8;
    const allowBassBias = songFeatures.bassWeight >= 0.72 && songFeatures.percussiveFocus < 0.56;
    if (tapIndices.length >= dominanceWindow) {
        for (let k = 0; k + dominanceWindow <= tapIndices.length; k++) {
            const idxs = tapIndices.slice(k, k + dominanceWindow);
            const first = sorted[idxs[0]].time;
            const last = sorted[idxs[idxs.length - 1]].time;
            if (last - first > beatInterval * 8.1) continue;

            let lane0 = 0;
            for (const idx of idxs) lane0 += sorted[idx].lane === 0 ? 1 : 0;
            const lane1 = idxs.length - lane0;
            const dominantLane = lane0 >= 6 ? 0 : lane1 >= 6 ? 1 : -1;
            if (dominantLane < 0) continue;
            if (allowBassBias && dominantLane === 1) continue;

            const pickOrder = [3, 4, 2, 5, 1, 6, 0, 7];
            for (const orderIdx of pickOrder) {
                const idx = idxs[orderIdx];
                if (idx === undefined) continue;
                if (sorted[idx].lane !== dominantLane) continue;
                if (!mutableTap(idx)) continue;
                if (!canFlipLane(idx)) continue;
                sorted[idx] = {
                    ...sorted[idx],
                    lane: dominantLane === 0 ? 1 : 0,
                    strength: Math.max(0.44, (sorted[idx].strength ?? 0.5) * 0.97),
                };
                break;
            }
        }
    }

    return dedupeNotes(sorted, 0.034);
};

const enhancePercussiveDriveMaps = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    beatPositions: readonly number[],
    spectralProfiles: readonly SpectralProfile[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length === 0 || bpm <= 0) return [...notes].sort((a, b) => a.time - b.time);
    const punchMode = songFeatures.percussiveFocus >= 0.6
        && songFeatures.driveScore >= 0.56
        && songFeatures.sustainedFocus <= 0.66
        && songFeatures.calmConfidence <= 0.62;
    if (!punchMode) return [...notes].sort((a, b) => a.time - b.time);

    const beatInterval = 60 / bpm;
    const sectionAt = createSectionLookup(sections);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const percentile = (values: readonly number[], q: number, fallback: number): number => {
        if (values.length === 0) return fallback;
        const sv = [...values].sort((a, b) => a - b);
        const pos = Math.max(0, Math.min(1, q)) * (sv.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sv[lo];
        return lerp(sv[lo], sv[hi], pos - lo);
    };
    const quantStep = difficulty === 'easy' || difficulty === 'normal'
        ? beatInterval * 0.5
        : beatInterval * 0.25;
    const snapToGrid = (time: number): number => {
        if (beatPositions.length === 0) {
            return Math.max(0.02, Math.round(time / quantStep) * quantStep);
        }
        let best = time;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const beat of beatPositions) {
            const candidates = difficulty === 'easy' || difficulty === 'normal'
                ? [beat, beat + beatInterval * 0.5]
                : [beat, beat + beatInterval * 0.25, beat + beatInterval * 0.5, beat + beatInterval * 0.75];
            for (const c of candidates) {
                const d = Math.abs(c - time);
                if (d < bestDist) {
                    bestDist = d;
                    best = c;
                }
            }
            if (beat > time + beatInterval * 1.3) break;
        }
        return Math.max(0.02, best);
    };
    const hasNear = (arr: readonly NoteData[], time: number, lane: number, win: number): boolean =>
        arr.some(n => n.lane === lane && Math.abs(n.time - time) < win);
    const longTargetRatio: Record<Difficulty, number> = {
        easy: 0.18,
        normal: 0.22,
        hard: 0.26,
        expert: 0.31,
    };

    const converted: NoteData[] = [];
    let lastLane = sorted[0]?.lane ?? 1;
    for (const note of sorted) {
        const isLong = note.type === 'slide' || note.type === 'hold';
        if (!isLong) {
            converted.push(note);
            lastLane = note.lane;
            continue;
        }
        const sec = sectionAt(note.time);
        const secType = sec?.type ?? 'verse';
        if (secType === 'intro' || secType === 'outro' || secType === 'interlude') {
            converted.push(note);
            lastLane = note.lane;
            continue;
        }
        const duration = note.duration ?? 0;
        const midTime = note.time + Math.max(0.06, duration * 0.45);
        const profile = getSpectralProfileAt(spectralProfiles, midTime);
        const percussiveLike = (profile?.percussive ?? songFeatures.percussiveFocus) >= 0.6
            || (profile?.transient ?? songFeatures.percussiveFocus) >= 0.58;
        const tonalLow = (profile?.tonal ?? songFeatures.sustainedFocus) <= 0.58;
        const shortLong = duration <= beatInterval * 2.15;
        if (percussiveLike && tonalLow && shortLong) {
            const primaryTime = snapToGrid(note.time);
            const primaryLane = note.lane;
            converted.push({
                time: primaryTime,
                lane: primaryLane,
                type: 'tap',
                strength: Math.max(0.62, (note.strength ?? 0.55) * 0.94),
            });
            if (duration >= beatInterval * 0.88) {
                const subTime = snapToGrid(note.time + beatInterval * 0.5);
                const toLane = note.type === 'slide'
                    ? resolveSlideTargetLane(note)
                    : (primaryLane === 0 ? 1 : 0);
                const subLane = toLane === primaryLane ? (primaryLane === 0 ? 1 : 0) : toLane;
                if (!hasNear(converted, subTime, subLane, Math.max(0.07, beatInterval * 0.2))) {
                    converted.push({
                        time: subTime,
                        lane: subLane,
                        type: 'tap',
                        strength: Math.max(0.56, (note.strength ?? 0.5) * 0.86),
                    });
                }
            }
            lastLane = primaryLane;
            continue;
        }
        converted.push(note);
        lastLane = note.lane;
    }

    let out = dedupeNotes(converted, 0.034);
    const countLongs = (arr: readonly NoteData[]): number =>
        arr.reduce((acc, n) => acc + ((n.type === 'slide' || n.type === 'hold') ? 1 : 0), 0);
    let longCount = countLongs(out);
    const longLimit = Math.floor(out.length * longTargetRatio[difficulty]);
    if (longCount > longLimit) {
        const longScores = out
            .map((n, idx) => ({ n, idx }))
            .filter(e => e.n.type === 'slide' || e.n.type === 'hold')
            .map(e => {
                const n = e.n;
                const dur = n.duration ?? 0;
                const p = getSpectralProfileAt(spectralProfiles, n.time + Math.max(0.04, dur * 0.4));
                const perc = p?.percussive ?? songFeatures.percussiveFocus;
                const tr = p?.transient ?? songFeatures.percussiveFocus;
                const tonal = p?.tonal ?? songFeatures.sustainedFocus;
                const sec = sectionAt(n.time);
                const highlight = sec?.type === 'drop' || sec?.type === 'chorus' || (sec?.avgEnergy ?? 0.5) >= 0.72;
                const keepScore = (n.strength ?? 0.5) * 0.46
                    + dur * 0.08
                    + tonal * 0.2
                    + (highlight ? 0.1 : 0)
                    - perc * 0.18
                    - tr * 0.1;
                return { idx: e.idx, keepScore };
            })
            .sort((a, b) => a.keepScore - b.keepScore);
        const replaceCount = Math.max(0, longCount - longLimit);
        const replaceSet = new Set<number>();
        for (let i = 0; i < replaceCount; i++) {
            if (!longScores[i]) break;
            replaceSet.add(longScores[i].idx);
        }
        out = out.map((n, idx) => {
            if (!replaceSet.has(idx)) return n;
            const lane = n.lane;
            return {
                time: snapToGrid(n.time),
                lane,
                type: 'tap' as const,
                strength: Math.max(0.6, (n.strength ?? 0.5) * 0.9),
            };
        });
        out = dedupeNotes(out, 0.034);
        longCount = countLongs(out);
    }

    const onsetPairs = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
    if (onsetPairs.length < 6) return out;
    const strongThreshold = Math.max(0.58, percentile(onsetPairs.map(p => p.strength), 0.7, 0.64));
    const maxAdd = Math.max(8, Math.floor(out.length * (difficulty === 'easy' ? 0.08 : difficulty === 'normal' ? 0.14 : difficulty === 'hard' ? 0.18 : 0.22)));
    const add: NoteData[] = [];
    for (const onset of onsetPairs) {
        if (add.length >= maxAdd) break;
        if (onset.strength < strongThreshold) continue;
        const sec = sectionAt(onset.time);
        const secType = sec?.type ?? 'verse';
        if (secType === 'intro' || secType === 'outro' || secType === 'interlude') continue;
        const snapped = snapToGrid(onset.time);
        const profile = getSpectralProfileAt(spectralProfiles, snapped);
        const upper = (profile?.high ?? 0) >= (profile?.low ?? 0) * 0.82;
        let lane = upper ? 0 : 1;
        if (hasNear(out, snapped, lane, Math.max(0.08, beatInterval * 0.22)) || hasNear(add, snapped, lane, Math.max(0.08, beatInterval * 0.22))) {
            lane = lane === 0 ? 1 : 0;
            if (hasNear(out, snapped, lane, Math.max(0.08, beatInterval * 0.22)) || hasNear(add, snapped, lane, Math.max(0.08, beatInterval * 0.22))) {
                continue;
            }
        }
        const finalLane = lane === lastLane && detHash(Math.round(snapped * 1000) + lane * 17) % 4 === 0
            ? (lane === 0 ? 1 : 0)
            : lane;
        add.push({
            time: snapped,
            lane: finalLane,
            type: 'tap',
            strength: Math.max(0.62, onset.strength * 0.94),
        });
        lastLane = finalLane;
    }

    return dedupeNotes([...out, ...add], 0.034);
};

const stabilizeGenerationQuality = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length < 6 || bpm <= 0) return [...notes].sort((a, b) => a.time - b.time);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    if (onsetTimes.length < 6) return dedupeNotes(sorted, 0.034);

    const beatInterval = 60 / Math.max(1, bpm);
    const sectionAt = createSectionLookup(sections);
    const onsetPairs = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
    if (onsetPairs.length < 6) return dedupeNotes(sorted, 0.034);

    const percentile = (values: readonly number[], q: number, fallback: number): number => {
        if (values.length === 0) return fallback;
        const sv = [...values].sort((a, b) => a - b);
        const pos = Math.max(0, Math.min(1, q)) * (sv.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sv[lo];
        return lerp(sv[lo], sv[hi], pos - lo);
    };
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const nearest = (arr: readonly number[], time: number): number | null => {
        if (arr.length === 0) return null;
        const idx = lowerBound(arr, time);
        let best: number | null = null;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = Math.max(0, idx - 2); i <= Math.min(arr.length - 1, idx + 2); i++) {
            const d = Math.abs(arr[i] - time);
            if (d < bestDist) {
                bestDist = d;
                best = arr[i];
            }
        }
        return best;
    };

    const strongThreshold = Math.max(0.56, percentile(onsetPairs.map(p => p.strength), 0.68, 0.62));
    const strongOnsetTimes = onsetPairs.filter(p => p.strength >= strongThreshold).map(p => p.time);
    const allOnsetTimes = onsetPairs.map(p => p.time);
    const beatAnchors: number[] = [];
    for (const beat of beatPositions) {
        beatAnchors.push(beat, beat + beatInterval * 0.5);
        if (difficulty === 'hard' || difficulty === 'expert') {
            beatAnchors.push(beat + beatInterval * 0.25, beat + beatInterval * 0.75);
        }
    }
    beatAnchors.sort((a, b) => a - b);

    const tapStrongWin = Math.max(0.03, beatInterval * 0.11);
    const tapOnsetWin = Math.max(0.04, beatInterval * 0.15);
    const tapBeatWin = Math.max(0.05, beatInterval * 0.2);
    const pruneOnsetGap = Math.max(0.085, beatInterval * 0.31);
    const pruneBeatGap = Math.max(0.075, beatInterval * 0.27);

    const out: NoteData[] = [];
    for (let i = 0; i < sorted.length; i++) {
        const note = sorted[i];
        const sec = sectionAt(note.time);
        const secType = sec?.type ?? 'verse';
        const highlight = secType === 'drop' || secType === 'chorus' || (sec?.avgEnergy ?? 0.5) >= 0.72;
        const strength = note.strength ?? 0.5;
        const nearestStrong = nearest(strongOnsetTimes, note.time);
        const nearestOnset = nearest(allOnsetTimes, note.time);
        const nearestBeat = nearest(beatAnchors, note.time);
        const dStrong = nearestStrong === null ? Number.POSITIVE_INFINITY : Math.abs(nearestStrong - note.time);
        const dOnset = nearestOnset === null ? Number.POSITIVE_INFINITY : Math.abs(nearestOnset - note.time);
        const dBeat = nearestBeat === null ? Number.POSITIVE_INFINITY : Math.abs(nearestBeat - note.time);

        if (note.type === 'tap') {
            let adjustedTime = note.time;
            if (nearestStrong !== null && dStrong <= tapStrongWin) {
                adjustedTime = lerp(note.time, nearestStrong, highlight ? 0.9 : Math.max(0.74, 0.9 - strength * 0.2));
            } else if (nearestOnset !== null && dOnset <= tapOnsetWin) {
                adjustedTime = lerp(note.time, nearestOnset, Math.max(0.62, 0.84 - strength * 0.2));
            } else if (nearestBeat !== null && dBeat <= tapBeatWin) {
                adjustedTime = lerp(note.time, nearestBeat, 0.64);
            }

            const weak = strength < (songFeatures.percussiveFocus >= 0.62 ? 0.62 : 0.56);
            const offMusic = dOnset > pruneOnsetGap && dBeat > pruneBeatGap;
            if (
                weak
                && offMusic
                && secType !== 'intro'
                && secType !== 'outro'
                && secType !== 'interlude'
            ) {
                const gate = difficulty === 'easy' ? 5 : difficulty === 'normal' ? 4 : 3;
                if (detHash(Math.round(note.time * 1000) + note.lane * 17 + i * 13) % gate !== 0) {
                    continue;
                }
            }

            out.push({
                ...note,
                time: Math.max(0.02, adjustedTime),
            });
            continue;
        }

        // 롱노트는 시작 헤드를 음원에 더 가깝게 보정하되, 퍼커시브 트랙에서는 짧은 약롱을 탭으로 치환.
        let shifted = note.time;
        if (nearestOnset !== null && dOnset <= Math.max(0.045, beatInterval * 0.16)) {
            shifted = lerp(note.time, nearestOnset, 0.56);
        } else if (nearestBeat !== null && dBeat <= Math.max(0.05, beatInterval * 0.18)) {
            shifted = lerp(note.time, nearestBeat, 0.5);
        }
        const duration = note.duration ?? 0;
        const shortLong = duration > 0 && duration <= beatInterval * 0.95;
        if (shortLong && songFeatures.percussiveFocus >= 0.62 && (note.strength ?? 0.5) < 0.68) {
            out.push({
                time: Math.max(0.02, shifted),
                lane: note.lane,
                type: 'tap',
                strength: Math.max(0.58, (note.strength ?? 0.5) * 0.9),
            });
            continue;
        }
        out.push({
            ...note,
            time: Math.max(0.02, shifted),
        });
    }

    // 최종 롱 비율 과다 방지.
    const longRatioLimit = difficulty === 'easy'
        ? 0.22
        : difficulty === 'normal'
            ? 0.28
            : difficulty === 'hard'
                ? 0.34
                : 0.4;
    const longIndices = out
        .map((n, idx) => ({ n, idx }))
        .filter(e => e.n.type === 'slide' || e.n.type === 'hold')
        .map(e => e.idx);
    const longLimit = Math.floor(out.length * longRatioLimit);
    if (longIndices.length > longLimit) {
        const dropCount = longIndices.length - longLimit;
        const ranked = longIndices
            .map(idx => {
                const n = out[idx];
                const keep = (n.strength ?? 0.5) * 0.62 + (n.duration ?? 0) * 0.06;
                return { idx, keep };
            })
            .sort((a, b) => a.keep - b.keep);
        const replace = new Set<number>();
        for (let i = 0; i < dropCount; i++) {
            if (ranked[i]) replace.add(ranked[i].idx);
        }
        for (let i = 0; i < out.length; i++) {
            if (!replace.has(i)) continue;
            const n = out[i];
            out[i] = {
                time: n.time,
                lane: n.lane,
                type: 'tap',
                strength: Math.max(0.58, (n.strength ?? 0.5) * 0.9),
            };
        }
    }

    const deduped = dedupeNotes(out, 0.034);
    return dedupeNotes(resolveLongNoteCollisions(deduped, bpm), 0.036);
};

const evaluateMapCandidateQuality = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): number => {
    if (notes.length === 0 || bpm <= 0) return 0;
    let notesSorted = true;
    for (let i = 1; i < notes.length; i++) {
        if (notes[i - 1].time > notes[i].time) {
            notesSorted = false;
            break;
        }
    }
    const sorted = notesSorted ? notes : [...notes].sort((a, b) => a.time - b.time);
    const beatInterval = 60 / Math.max(1, bpm);
    const onsetOnly: number[] = [];
    let onsetSorted = true;
    let lastOnset = -Infinity;
    for (let i = 0; i < onsetTimes.length; i++) {
        const time = onsetTimes[i];
        if (!Number.isFinite(time)) continue;
        if (time < lastOnset) onsetSorted = false;
        lastOnset = time;
        onsetOnly.push(time);
    }
    if (onsetOnly.length < 4) return 0.15;
    if (!onsetSorted) {
        onsetOnly.sort((a, b) => a - b);
    }
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const nearestOnsetDistance = (time: number): number => {
        const idx = lowerBound(onsetOnly, time);
        let best = Number.POSITIVE_INFINITY;
        for (let i = Math.max(0, idx - 2); i <= Math.min(onsetOnly.length - 1, idx + 2); i++) {
            best = Math.min(best, Math.abs(onsetOnly[i] - time));
        }
        return best;
    };

    let alignAcc = 0;
    let alignW = 0;
    const tapWindow = Math.max(0.09, beatInterval * 0.32);
    const longWindow = Math.max(0.11, beatInterval * 0.42);
    for (const note of sorted) {
        const isLong = note.type === 'slide' || note.type === 'hold';
        const dist = nearestOnsetDistance(note.time);
        const win = isLong ? longWindow : tapWindow;
        const w = isLong ? 0.72 : 1.0;
        const fit = 1 - Math.min(1, dist / win);
        alignAcc += fit * w;
        alignW += w;
    }
    const alignScore = alignW > 0 ? alignAcc / alignW : 0;

    const sectionAt = createSectionLookup(sections);
    const introEnd = resolveLeadingIntroEnd(sections);
    const firstHighlightStart = sections.find(s =>
        s.type === 'drop'
        || s.type === 'chorus'
        || (s.avgEnergy ?? 0.5) >= 0.72
    )?.startTime ?? Number.POSITIVE_INFINITY;
    const introProtectUntil = introEnd > 0
        ? Math.max(
            introEnd,
            Number.isFinite(firstHighlightStart)
                ? Math.min(firstHighlightStart * 0.74, introEnd + 9)
                : introEnd + 7
        )
        : (Number.isFinite(firstHighlightStart)
            ? Math.max(4.2, Math.min(firstHighlightStart * 0.62, 11))
            : 8);
    const introProtectCap = Math.max(
        2.8,
        Math.min(6.2, (sections[sections.length - 1]?.endTime ?? sorted[sorted.length - 1].time) * 0.18)
    );
    const safeIntroProtectUntil = Math.min(introProtectUntil, introProtectCap);

    let highlightNotes = 0;
    let nonHighlightNotes = 0;
    let introNotes = 0;
    let highlightDur = 0;
    let quietDur = 0;
    let introDur = 0;
    for (const section of sections) {
        const dur = Math.max(0, section.endTime - section.startTime);
        if (dur <= 0) continue;
        const secType = section.type;
        const isIntroLike = secType === 'intro'
            || secType === 'outro'
            || secType === 'interlude'
            || section.endTime <= safeIntroProtectUntil;
        const isHighlight = secType === 'drop'
            || secType === 'chorus'
            || (section.avgEnergy ?? 0.5) >= 0.72;
        if (isIntroLike) introDur += dur;
        else if (isHighlight) highlightDur += dur;
        else quietDur += dur;
    }
    for (const note of sorted) {
        const sec = sectionAt(note.time);
        const secType = sec?.type ?? 'verse';
        const inIntroLike = note.time <= safeIntroProtectUntil
            || secType === 'intro'
            || secType === 'outro'
            || secType === 'interlude';
        if (inIntroLike) {
            introNotes++;
            continue;
        }
        const highlight = secType === 'drop' || secType === 'chorus' || (sec?.avgEnergy ?? 0.5) >= 0.72;
        if (highlight) highlightNotes++;
        else nonHighlightNotes++;
    }
    const totalDur = Math.max(1, (sections[sections.length - 1]?.endTime ?? sorted[sorted.length - 1].time) - (sections[0]?.startTime ?? 0));
    const nps = sorted.length / totalDur;
    const targetNps: Record<Difficulty, number> = {
        easy: 2.1,
        normal: 4.2,
        hard: 6.3,
        expert: 8.6,
    };
    const expectedNps = targetNps[difficulty] * (
        0.92
        + songFeatures.driveScore * 0.16
        + songFeatures.percussiveFocus * 0.08
        - songFeatures.calmConfidence * 0.08
    );
    const densityScore = 1 - Math.min(1, Math.abs(nps - expectedNps) / Math.max(0.7, expectedNps * 0.88));

    let longCount = 0;
    let tapCount = 0;
    let topTap = 0;
    let excessiveStreak = 0;
    let streak = 0;
    let repeatingLoops = 0;
    let prevLane1: number | null = null;
    let prevLane2: number | null = null;
    let prevLane3: number | null = null;
    for (let i = 0; i < sorted.length; i++) {
        const note = sorted[i];
        if (note.type === 'slide' || note.type === 'hold') {
            longCount++;
        }
        const isTap = note.type === 'tap' || note.type === 'burst';
        if (!isTap) continue;
        tapCount++;
        if (note.lane === 0) topTap++;
        if (prevLane1 !== null && note.lane === prevLane1) {
            streak++;
            if (streak >= 3) excessiveStreak++;
        } else {
            streak = 0;
        }
        if (prevLane1 !== null && prevLane2 !== null && prevLane3 !== null) {
            if (note.lane === prevLane2 && prevLane1 === prevLane3) {
                repeatingLoops++;
            }
        }
        prevLane3 = prevLane2;
        prevLane2 = prevLane1;
        prevLane1 = note.lane;
    }
    const longRatio = longCount / Math.max(1, sorted.length);
    const targetLongRatio = clamp01(0.12 + songFeatures.sustainedFocus * 0.24 - songFeatures.percussiveFocus * 0.14);
    const longScore = 1 - Math.min(1, Math.abs(longRatio - targetLongRatio) / 0.3);
    const streakScore = clamp01(1 - excessiveStreak / Math.max(6, tapCount * 0.42));
    const loopScore = clamp01(1 - repeatingLoops / Math.max(4, tapCount * 0.26));
    const patternScore = clamp01(streakScore * 0.58 + loopScore * 0.42);

    const highlightBias = highlightNotes / Math.max(1, highlightNotes + nonHighlightNotes);
    const expectedHighlightBias = clamp01(0.34 + songFeatures.driveScore * 0.22 + songFeatures.dynamicRange * 0.2);
    const sectionScore = 1 - Math.min(1, Math.abs(highlightBias - expectedHighlightBias) / 0.42);
    const highlightNps = highlightNotes / Math.max(0.5, highlightDur);
    const quietNps = nonHighlightNotes / Math.max(0.5, quietDur);
    const desiredContrast = Math.max(
        1.05,
        1.1
        + songFeatures.driveScore * 1.22
        + songFeatures.dynamicRange * 0.82
        - songFeatures.calmConfidence * 0.52
    );
    const actualContrast = highlightNps / Math.max(0.3, quietNps);
    const flowScore = 1 - Math.min(1, Math.abs(actualContrast - desiredContrast) / Math.max(0.85, desiredContrast * 0.74));

    const introNps = introNotes / Math.max(0.5, introDur);
    const introTarget = expectedNps * (
        0.2
        + (1 - songFeatures.introQuietness) * 0.24
        + (1 - songFeatures.calmConfidence) * 0.12
    );
    const introOverflow = Math.max(0, introNps - introTarget);
    const introScore = 1 - Math.min(1, introOverflow / Math.max(0.28, introTarget * 1.28));

    const bottomTap = Math.max(0, tapCount - topTap);
    const laneBalanceScore = tapCount < 6
        ? 0.7
        : 1 - Math.min(1, Math.abs(topTap - bottomTap) / Math.max(1, tapCount));

    return clamp01(
        alignScore * 0.37
        + densityScore * 0.1
        + longScore * 0.1
        + patternScore * 0.11
        + sectionScore * 0.09
        + introScore * 0.09
        + flowScore * 0.09
        + laneBalanceScore * 0.06
    );
};

const applyEnergeticAccentPass = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length === 0 || onsetTimes.length < 6 || beatPositions.length < 4 || bpm <= 0) {
        return [...notes];
    }
    const energetic = songFeatures.driveScore >= 0.56
        || songFeatures.percussiveFocus >= 0.58
        || songFeatures.bassWeight >= 0.56;
    if (!energetic) {
        return [...notes];
    }

    const beatInterval = 60 / Math.max(1, bpm);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const sectionAt = createSectionLookup(sections);
    const candidates = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time) && p.time >= 0 && p.time <= (sections[sections.length - 1]?.endTime ?? Infinity))
        .sort((a, b) => a.time - b.time);
    if (candidates.length < 6) return sorted;

    const percentile = (values: readonly number[], q: number, fallback: number): number => {
        if (values.length === 0) return fallback;
        const sv = [...values].sort((a, b) => a - b);
        const pos = Math.max(0, Math.min(1, q)) * (sv.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sv[lo];
        return lerp(sv[lo], sv[hi], pos - lo);
    };
    const strongGate = Math.max(
        0.52,
        percentile(candidates.map(c => c.strength), difficulty === 'expert' ? 0.56 : difficulty === 'hard' ? 0.6 : 0.64, 0.62)
    );
    const strong = candidates.filter(c => c.strength >= strongGate);
    if (strong.length < 4) return sorted;

    const npsTarget: Record<Difficulty, number> = {
        easy: 1.35,
        normal: 2.8,
        hard: 3.85,
        expert: 4.9,
    };
    const duration = Math.max(1, sections[sections.length - 1]?.endTime ?? sorted[sorted.length - 1].time);
    const currentNps = sorted.length / duration;
    const desiredAdds = Math.max(
        0,
        Math.min(
            Math.floor(duration * 1.5),
            Math.floor((npsTarget[difficulty] - currentNps) * duration * 0.58)
        )
    );
    const accentFloorAdds = energetic
        ? Math.max(0, Math.floor(duration * (difficulty === 'normal' ? 0.03 : difficulty === 'hard' ? 0.045 : 0.06)))
        : 0;
    const targetAdds = Math.max(desiredAdds, accentFloorAdds);
    if (targetAdds <= 0) return sorted;

    const grid: number[] = [];
    for (const beat of beatPositions) {
        grid.push(beat, beat + beatInterval * 0.5);
        if (difficulty === 'hard' || difficulty === 'expert') {
            grid.push(beat + beatInterval * 0.25, beat + beatInterval * 0.75);
        }
    }
    grid.sort((a, b) => a - b);
    const nearestGrid = (time: number): number => {
        if (grid.length === 0) return time;
        let lo = 0;
        let hi = grid.length - 1;
        let best = grid[0];
        let bestDist = Math.abs(best - time);
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const v = grid[mid];
            const d = Math.abs(v - time);
            if (d < bestDist) {
                bestDist = d;
                best = v;
            }
            if (v < time) lo = mid + 1;
            else hi = mid - 1;
        }
        return best;
    };

    const laneTimes: [number[], number[]] = [[], []];
    const longTimes: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
        const laneIdx = sorted[i].lane === 0 ? 0 : 1;
        laneTimes[laneIdx].push(sorted[i].time);
        if (sorted[i].type !== 'tap') {
            longTimes.push(sorted[i].time);
        }
    }
    const lowerBoundTime = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const hasNear = (arr: readonly number[], time: number, win: number): boolean => {
        if (arr.length === 0) return false;
        const idx = lowerBoundTime(arr, time);
        if (idx < arr.length && Math.abs(arr[idx] - time) < win) return true;
        if (idx > 0 && Math.abs(arr[idx - 1] - time) < win) return true;
        return false;
    };
    const hasNearby = (time: number, lane: number): boolean => {
        const laneIdx = lane === 0 ? 0 : 1;
        return hasNear(laneTimes[laneIdx], time, beatInterval * 0.2)
            || hasNear(longTimes, time, beatInterval * 0.08);
    };

    let lane = sorted[sorted.length - 1]?.lane ?? 1;
    let added = 0;
    for (let i = 0; i < strong.length && added < targetAdds; i++) {
        const s = strong[i];
        const sec = sectionAt(s.time);
        const secType = sec?.type ?? 'verse';
        if (secType === 'intro' || secType === 'outro' || secType === 'interlude') continue;
        const snapped = nearestGrid(s.time);
        if (Math.abs(snapped - s.time) > Math.max(0.09, beatInterval * 0.38)) continue;
        const phraseSlot = Math.round(snapped / Math.max(1e-4, beatInterval * 0.5)) % 8;
        if (phraseSlot !== 3 && phraseSlot !== 7) {
            lane = lane === 0 ? 1 : 0;
        }
        if (hasNearby(snapped, lane)) {
            const alt = lane === 0 ? 1 : 0;
            if (hasNearby(snapped, alt)) continue;
            lane = alt;
        }
        const newNote: NoteData = {
            time: snapped,
            lane,
            type: 'tap',
            strength: clamp01(Math.max(0.62, s.strength * 0.9)),
        };
        sorted.push(newNote);
        const laneIdx = lane === 0 ? 0 : 1;
        const laneInsertAt = lowerBoundTime(laneTimes[laneIdx], snapped);
        laneTimes[laneIdx].splice(laneInsertAt, 0, snapped);
        added++;
    }
    return dedupeNotes(sorted, 0.038);
};

const enforceSectionEnergyFlow = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length === 0 || sections.length === 0 || bpm <= 0) return [...notes];
    const beatInterval = 60 / Math.max(1, bpm);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const orderedSections = [...sections].sort((a, b) => a.startTime - b.startTime);
    const sectionAt = createSectionLookup(orderedSections);
    const isPlayable = (type: string): boolean => type !== 'intro' && type !== 'outro' && type !== 'interlude';
    const introEnd = orderedSections
        .filter(s => s.type === 'intro')
        .reduce((mx, s) => Math.max(mx, s.endTime), 0);
    const firstHighlight = orderedSections.find(s =>
        s.type === 'drop'
        || s.type === 'chorus'
        || (s.avgEnergy || 0.5) >= 0.72
    )?.startTime ?? Number.POSITIVE_INFINITY;
    const introProtectUntil = introEnd > 0
        ? Math.max(
            introEnd,
            Number.isFinite(firstHighlight)
                ? Math.min(firstHighlight * 0.64, introEnd + 7)
                : introEnd + 6
        )
        : (Number.isFinite(firstHighlight)
            ? Math.max(4.2, Math.min(firstHighlight * 0.62, 11))
            : 8);
    const boundedIntroProtectUntil = Math.min(
        introProtectUntil,
        Math.max(2.8, Math.min(6.4, (orderedSections[orderedSections.length - 1]?.endTime ?? 0) * 0.19))
    );

    const onsetPairs = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
    if (onsetPairs.length === 0) return sorted;

    const percentile = (values: readonly number[], q: number, fallback: number): number => {
        if (values.length === 0) return fallback;
        const sv = [...values].sort((a, b) => a - b);
        const pos = Math.max(0, Math.min(1, q)) * (sv.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sv[lo];
        return lerp(sv[lo], sv[hi], pos - lo);
    };
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const nearestDistance = (arr: readonly number[], time: number): number => {
        if (arr.length === 0) return Number.POSITIVE_INFINITY;
        const idx = lowerBound(arr, time);
        let best = Number.POSITIVE_INFINITY;
        for (let i = Math.max(0, idx - 2); i <= Math.min(arr.length - 1, idx + 2); i++) {
            best = Math.min(best, Math.abs(arr[i] - time));
        }
        return best;
    };

    const strongThreshold = Math.max(0.58, percentile(onsetPairs.map(p => p.strength), 0.68, 0.64));
    const strongTimes = onsetPairs.filter(p => p.strength >= strongThreshold).map(p => p.time);
    const allOnsetTimes = onsetPairs.map(p => p.time);
    const introCalm = clamp01(songFeatures.introQuietness * 0.58 + songFeatures.calmConfidence * 0.42);
    const introTapGap = Math.max(0.13, beatInterval * (0.5 + introCalm * 0.4));

    const introPruned: NoteData[] = [];
    let lastIntroTap = -Infinity;
    for (let i = 0; i < sorted.length; i++) {
        const n = sorted[i];
        const sec = sectionAt(n.time);
        const secType = sec?.type ?? 'verse';
        if (n.time >= boundedIntroProtectUntil || secType === 'drop' || secType === 'chorus') {
            introPruned.push(n);
            continue;
        }
        if (!isPlayable(secType)) {
            if (n.type !== 'tap' && (n.strength ?? 0.5) >= 0.66) {
                introPruned.push(n);
            }
            continue;
        }
        const strength = n.strength ?? 0.5;
        if (n.type !== 'tap') {
            const keepLong = strength >= 0.62 || (n.duration ?? 0) >= beatInterval * 1.25;
            if (keepLong && n.time - lastIntroTap >= introTapGap * 0.92) {
                introPruned.push(n);
                lastIntroTap = n.time;
            }
            continue;
        }
        const dStrong = nearestDistance(strongTimes, n.time);
        const dOnset = nearestDistance(allOnsetTimes, n.time);
        const strongTap = strength >= Math.max(0.7, strongThreshold * 0.98);
        const nearMusic = dStrong <= Math.max(0.05, beatInterval * 0.16)
            || dOnset <= Math.max(0.042, beatInterval * 0.14);
        if (!strongTap && !nearMusic) continue;
        if (n.time - lastIntroTap < introTapGap) continue;
        if (introCalm >= 0.62 && !strongTap) {
            const gate = detHash(Math.round(n.time * 1000) + n.lane * 47 + i * 13);
            if (gate % 2 !== 0) continue;
        }
        introPruned.push(n);
        lastIntroTap = n.time;
    }

    const baseTargetNps: Record<Difficulty, number> = {
        easy: 1.1,
        normal: 2.2,
        hard: 3.0,
        expert: 3.85,
    };
    const highlightSections = orderedSections.filter(s =>
        isPlayable(s.type) && (s.type === 'drop' || s.type === 'chorus' || (s.avgEnergy || 0.5) >= 0.72)
    );
    if (highlightSections.length === 0 || beatPositions.length === 0) {
        return dedupeNotes(introPruned, 0.036);
    }

    const grid: number[] = [];
    for (const beat of beatPositions) {
        grid.push(beat, beat + beatInterval * 0.5);
        if (difficulty === 'hard' || difficulty === 'expert') {
            grid.push(beat + beatInterval * 0.25, beat + beatInterval * 0.75);
        }
    }
    grid.sort((a, b) => a - b);
    const nearestGrid = (time: number): number => {
        if (grid.length === 0) return time;
        const idx = lowerBound(grid, time);
        let best = grid[Math.max(0, Math.min(grid.length - 1, idx))];
        let bestDist = Math.abs(best - time);
        for (let i = Math.max(0, idx - 2); i <= Math.min(grid.length - 1, idx + 2); i++) {
            const d = Math.abs(grid[i] - time);
            if (d < bestDist) {
                bestDist = d;
                best = grid[i];
            }
        }
        return best;
    };
    const introTimesByLane: [number[], number[]] = [[], []];
    for (let i = 0; i < introPruned.length; i++) {
        const lane = introPruned[i].lane === 0 ? 0 : 1;
        introTimesByLane[lane].push(introPruned[i].time);
    }
    const additionTimesByLane: [number[], number[]] = [[], []];
    const lowerBoundTime = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const hasNearbyTimes = (arr: readonly number[], time: number, win: number): boolean => {
        if (arr.length === 0) return false;
        const idx = lowerBoundTime(arr, time);
        if (idx < arr.length && Math.abs(arr[idx] - time) < win) return true;
        if (idx > 0 && Math.abs(arr[idx - 1] - time) < win) return true;
        return false;
    };
    const hasNearby = (time: number, lane: number, win: number): boolean => {
        const laneIdx = lane === 0 ? 0 : 1;
        return hasNearbyTimes(introTimesByLane[laneIdx], time, win)
            || hasNearbyTimes(additionTimesByLane[laneIdx], time, win);
    };
    const countRange = (arr: readonly number[], start: number, end: number): number => {
        if (arr.length === 0 || end <= start) return 0;
        const i0 = lowerBoundTime(arr, start);
        const i1 = lowerBoundTime(arr, end);
        return Math.max(0, i1 - i0);
    };

    const additions: NoteData[] = [];
    const activityBoost = clamp01(
        songFeatures.driveScore * 0.42
        + songFeatures.percussiveFocus * 0.34
        + songFeatures.dynamicRange * 0.24
    );
    let lane = introPruned[introPruned.length - 1]?.lane ?? 1;
    const highlightWin = Math.max(0.06, beatInterval * 0.14);

    for (const section of highlightSections) {
        const secDur = Math.max(0.001, section.endTime - section.startTime);
        const secTargetNps = baseTargetNps[difficulty] * (0.92 + activityBoost * 0.4);
        const targetCount = Math.max(2, Math.floor(secDur * secTargetNps));
        const existing = countRange(introTimesByLane[0], section.startTime, section.endTime)
            + countRange(introTimesByLane[1], section.startTime, section.endTime)
            + countRange(additionTimesByLane[0], section.startTime, section.endTime)
            + countRange(additionTimesByLane[1], section.startTime, section.endTime);
        if (existing >= targetCount) continue;
        const need = targetCount - existing;
        const oi0 = lowerBoundTime(allOnsetTimes, section.startTime);
        const oi1 = lowerBoundTime(allOnsetTimes, section.endTime);
        const cands: Array<{ time: number; strength: number }> = [];
        const minStrength = strongThreshold * 0.9;
        for (let i = oi0; i < oi1; i++) {
            const cand = onsetPairs[i];
            if (cand.strength >= minStrength) cands.push(cand);
        }
        cands.sort((a, b) => b.strength - a.strength || a.time - b.time);
        let added = 0;
        for (const c of cands) {
            if (added >= need) break;
            const snapped = nearestGrid(c.time);
            if (snapped < section.startTime || snapped >= section.endTime) continue;
            const localSec = sectionAt(snapped);
            if (!isPlayable(localSec?.type ?? 'verse')) continue;
            lane = lane === 0 ? 1 : 0;
            if (hasNearby(snapped, lane, highlightWin)) {
                const alt = lane === 0 ? 1 : 0;
                if (hasNearby(snapped, alt, highlightWin)) continue;
                lane = alt;
            }
            const newNote: NoteData = {
                time: snapped,
                lane,
                type: 'tap',
                strength: Math.max(0.62, c.strength * 0.9),
            };
            additions.push(newNote);
            const laneIdx = lane === 0 ? 0 : 1;
            const insertAt = lowerBoundTime(additionTimesByLane[laneIdx], snapped);
            additionTimesByLane[laneIdx].splice(insertAt, 0, snapped);
            added++;
        }
    }

    return dedupeNotes([...introPruned, ...additions], 0.036);
};

const buildEmergencyMusicalNotes = (
    duration: number,
    bpm: number,
    difficulty: Difficulty,
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    songFeatures: BeatMapSongFeatures,
    minCount: number
): NoteData[] => {
    if (duration <= 0 || bpm <= 0) return [];
    const beatInterval = 60 / Math.max(1, bpm);
    const sectionAt = createSectionLookup(sections);
    const candidates = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time) && p.time >= 0 && p.time <= duration)
        .sort((a, b) => a.time - b.time);
    const grid: number[] = [];
    for (const beat of beatPositions) {
        grid.push(beat, beat + beatInterval * 0.5);
        if (difficulty === 'hard' || difficulty === 'expert') {
            grid.push(beat + beatInterval * 0.25, beat + beatInterval * 0.75);
        }
    }
    grid.sort((a, b) => a - b);
    const nearestGrid = (time: number): number => {
        if (grid.length === 0) return time;
        let lo = 0;
        let hi = grid.length - 1;
        let best = grid[0];
        let bestDist = Math.abs(best - time);
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const v = grid[mid];
            const d = Math.abs(v - time);
            if (d < bestDist) {
                bestDist = d;
                best = v;
            }
            if (v < time) lo = mid + 1;
            else hi = mid - 1;
        }
        return best;
    };

    const out: NoteData[] = [];
    const used = new Set<number>();
    let lane = songFeatures.percussiveFocus >= 0.58 ? 1 : 0;
    for (let i = 0; i < candidates.length && out.length < Math.max(minCount, 8); i++) {
        const c = candidates[i];
        if (c.strength < 0.42) continue;
        const sec = sectionAt(c.time);
        const secType = sec?.type ?? 'verse';
        if (secType === 'intro' || secType === 'outro' || secType === 'interlude') continue;
        const snapped = nearestGrid(c.time);
        const k = Math.round(snapped * 1000);
        if (used.has(k)) continue;
        used.add(k);
        lane = lane === 0 ? 1 : 0;
        out.push({
            time: snapped,
            lane,
            type: 'tap',
            strength: clamp01(Math.max(0.56, c.strength * 0.88)),
        });
    }
    if (out.length >= Math.max(minCount, 8)) {
        return dedupeNotes(out, 0.04);
    }

    let fillLane = lane;
    for (const beat of beatPositions) {
        if (out.length >= Math.max(minCount, 8)) break;
        const sec = sectionAt(beat);
        const secType = sec?.type ?? 'verse';
        if (secType === 'intro' || secType === 'outro' || secType === 'interlude') continue;
        const t = nearestGrid(beat);
        const k = Math.round(t * 1000);
        if (used.has(k)) continue;
        used.add(k);
        fillLane = fillLane === 0 ? 1 : 0;
        out.push({
            time: t,
            lane: fillLane,
            type: 'tap',
            strength: 0.62,
        });
    }
    return dedupeNotes(out, 0.04);
};

const enforceDifficultyNoteCountBand = (
    notes: readonly NoteData[],
    duration: number,
    bpm: number,
    difficulty: Difficulty,
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (duration <= 0 || bpm <= 0) return [...notes];

    const baseNpsByDiff: Record<Difficulty, number> = {
        easy: 2.8,
        normal: 5.9,
        hard: 8.5,
        expert: 11.2,
    };
    const hardClampByDiff: Record<Difficulty, { min: number; max: number }> = {
        easy: { min: 2.2, max: 4.5 },
        normal: { min: 4.9, max: 8.4 },
        hard: { min: 7.2, max: 11.6 },
        expert: { min: 9.8, max: 15.2 },
    };

    const onsetDensity = onsetTimes.length / Math.max(1, duration);
    const strongOnsetDensity = onsetStrengths.filter(s => (s ?? 0.5) >= 0.62).length / Math.max(1, duration);
    const beatPerSec = bpm / 60;
    const densityRef = Math.max(2.2, beatPerSec * 1.9);
    const strongRef = Math.max(0.8, beatPerSec * 0.72);
    const rhythmicCapacity = clamp01(
        (onsetDensity / densityRef) * 0.6
        + (strongOnsetDensity / strongRef) * 0.4
    );
    const musicalLift = clamp01(
        songFeatures.driveScore * 0.46
        + songFeatures.percussiveFocus * 0.22
        + songFeatures.melodicFocus * 0.2
        - songFeatures.calmConfidence * 0.18
    );

    const baseNps = baseNpsByDiff[difficulty];
    const targetNpsRaw = baseNps
        * (0.84 + rhythmicCapacity * 0.56 + musicalLift * 0.16)
        * (difficulty === 'expert' ? 1.06 : 1);
    const hardClamp = hardClampByDiff[difficulty];
    const targetNps = Math.max(hardClamp.min, Math.min(hardClamp.max, targetNpsRaw));

    const minCount = Math.max(8, Math.floor(duration * targetNps * 0.88));
    const maxCount = Math.max(minCount + 1, Math.ceil(duration * targetNps * 1.16));

    let out = [...notes].sort((a, b) => a.time - b.time);
    if (out.length < minCount) {
        const rescue = buildEmergencyMusicalNotes(
            duration,
            bpm,
            difficulty,
            beatPositions,
            sections,
            onsetTimes,
            onsetStrengths,
            songFeatures,
            minCount - out.length
        );
        out = dedupeNotes([...out, ...rescue], 0.034);
        out = pruneImpossibleNestedNotes(resolveLongNoteCollisions(out, bpm), bpm);
    }

    if (out.length <= maxCount) return out;

    const sectionAt = createSectionLookup(sections);
    const ranked = out
        .map((n, idx) => {
            const sec = sectionAt(n.time);
            const secType = sec?.type ?? 'verse';
            const protectedSection = secType === 'drop' || secType === 'chorus';
            const typePenalty = n.type === 'tap' ? 0 : 0.26;
            const sectionPenalty = protectedSection ? 0.28 : secType === 'bridge' ? 0.06 : 0;
            const score = (n.strength ?? 0.5) + typePenalty + sectionPenalty;
            return { idx, score };
        })
        .sort((a, b) => a.score - b.score);

    const removeCount = out.length - maxCount;
    const removeIdx = new Set<number>();
    for (let i = 0; i < ranked.length && removeIdx.size < removeCount; i++) {
        removeIdx.add(ranked[i].idx);
    }

    const trimmed = out.filter((_, idx) => !removeIdx.has(idx));
    return dedupeNotes(trimmed, 0.034);
};

const enforceFinalMusicAnchoring = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length < 6 || onsetTimes.length < 6 || bpm <= 0) {
        return [...notes].sort((a, b) => a.time - b.time);
    }

    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const beatInterval = 60 / bpm;
    const sectionAt = createSectionLookup(sections);

    const onsetPairs = onsetTimes
        .map((time, idx) => ({ time, strength: onsetStrengths[idx] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
    if (onsetPairs.length < 6) return sorted;

    const percentile = (values: readonly number[], q: number, fallback: number): number => {
        if (values.length === 0) return fallback;
        const sv = [...values].sort((a, b) => a - b);
        const pos = Math.max(0, Math.min(1, q)) * (sv.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sv[lo];
        return lerp(sv[lo], sv[hi], pos - lo);
    };

    const calmBias = clamp01(songFeatures.calmConfidence * 0.68 + songFeatures.introQuietness * 0.32);
    const strongQ = difficulty === 'expert'
        ? 0.62
        : difficulty === 'hard'
            ? 0.64
            : 0.66;
    const strongThreshold = Math.max(
        0.54,
        percentile(onsetPairs.map(p => p.strength), strongQ, 0.6)
    );
    const strongTimes = onsetPairs
        .filter(p => p.strength >= strongThreshold)
        .map(p => p.time);
    const allTimes = onsetPairs.map(p => p.time);
    if (allTimes.length < 6) return sorted;

    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    const nearestFrom = (arr: readonly number[], time: number): number | null => {
        if (arr.length === 0) return null;
        const idx = lowerBound(arr, time);
        let best = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        const start = Math.max(0, idx - 2);
        const end = Math.min(arr.length - 1, idx + 2);
        for (let i = start; i <= end; i++) {
            const d = Math.abs(arr[i] - time);
            if (d < bestDist) {
                bestDist = d;
                best = i;
            }
        }
        return best >= 0 ? arr[best] : null;
    };

    const anchors: number[] = [];
    for (const beat of beatPositions) {
        anchors.push(beat, beat + beatInterval * 0.5);
        if (difficulty === 'hard' || difficulty === 'expert') {
            anchors.push(beat + beatInterval * 0.25, beat + beatInterval * 0.75);
        }
    }
    anchors.sort((a, b) => a - b);

    const result: NoteData[] = [];
    for (const note of sorted) {
        const sec = sectionAt(note.time);
        const secType = sec?.type ?? 'verse';
        const highlight = secType === 'drop' || secType === 'chorus' || (sec?.avgEnergy ?? 0.5) >= 0.72;
        const strength = note.strength ?? 0.5;
        const nearestStrong = nearestFrom(strongTimes, note.time);
        const nearestOnset = nearestFrom(allTimes, note.time);
        const nearestGrid = nearestFrom(anchors, note.time);
        const distStrong = nearestStrong === null ? Number.POSITIVE_INFINITY : Math.abs(nearestStrong - note.time);
        const distOnset = nearestOnset === null ? Number.POSITIVE_INFINITY : Math.abs(nearestOnset - note.time);
        const distGrid = nearestGrid === null ? Number.POSITIVE_INFINITY : Math.abs(nearestGrid - note.time);

        const strongSnapLimit = note.type === 'tap'
            ? Math.max(0.028, beatInterval * (highlight ? 0.13 : 0.1))
            : Math.max(0.022, beatInterval * 0.085);
        const onsetSnapLimit = note.type === 'tap'
            ? Math.max(0.035, beatInterval * 0.16)
            : Math.max(0.026, beatInterval * 0.1);
        const pruneOnsetGap = Math.max(0.082, beatInterval * 0.3);
        const pruneGridGap = Math.max(0.068, beatInterval * 0.24);

        let nextTime = note.time;
        if (distStrong <= strongSnapLimit && nearestStrong !== null) {
            const ratio = note.type === 'tap'
                ? (highlight ? 0.88 : Math.max(0.7, 0.9 - strength * 0.25))
                : 0.74;
            nextTime = lerp(note.time, nearestStrong, ratio);
        } else if (distOnset <= onsetSnapLimit && nearestOnset !== null) {
            const ratio = note.type === 'tap'
                ? Math.max(0.58, 0.82 - strength * 0.18)
                : 0.56;
            nextTime = lerp(note.time, nearestOnset, ratio);
        } else if (note.type === 'tap' && nearestGrid !== null && distGrid <= Math.max(0.05, beatInterval * 0.18)) {
            nextTime = lerp(note.time, nearestGrid, 0.66);
        }

        if (
            note.type === 'tap'
            && !highlight
            && distOnset > pruneOnsetGap
            && distGrid > pruneGridGap
            && strength < (calmBias >= 0.58 ? 0.72 : 0.62)
        ) {
            continue;
        }

        result.push({
            ...note,
            time: Math.max(0.02, nextTime),
        });
    }

    return dedupeNotes(resolveLongNoteCollisions(result, bpm), 0.034);
};

const normalizeLongDuration = (
    noteType: NoteData['type'],
    rawDuration: number | undefined,
    beatInterval: number
): number => {
    if (noteType === 'slide') {
        const minSlide = Math.max(MIN_SLIDE_DURATION_SEC, beatInterval * 0.78);
        return Math.max(minSlide, rawDuration || minSlide);
    }
    if (noteType === 'hold') {
        const minHold = Math.max(MIN_HOLD_DURATION_SEC, beatInterval * 0.62);
        return Math.max(minHold, rawDuration || minHold);
    }
    return Math.max(0, rawDuration || 0);
};

const enforceStraightSlideRatio = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty
): NoteData[] => {
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const slideIndices: number[] = [];
    let straightCount = 0;
    for (let i = 0; i < sorted.length; i++) {
        const n = sorted[i];
        if (n.type !== 'slide') continue;
        slideIndices.push(i);
        if (resolveSlideTargetLane(n) === n.lane) straightCount++;
    }
    if (slideIndices.length < 2) return sorted;

    const targetStraightRatioByDiff: Record<Difficulty, number> = {
        easy: 0.58,
        normal: 0.48,
        hard: 0.4,
        expert: 0.34,
    };
    const targetStraightRatio = targetStraightRatioByDiff[difficulty];
    const minDiagonalKeep = Math.max(6, Math.floor(slideIndices.length * 0.34));
    const targetStraight = Math.max(1, Math.round(slideIndices.length * targetStraightRatio));
    const needed = targetStraight - straightCount;
    if (needed <= 0) return sorted;

    const beatInterval = 60 / bpm;
    const sectionLookup = createSectionLookup(sections);
    const sectionAt = (time: number) => sectionLookup(time)?.type ?? 'verse';

    const candidates = slideIndices
        .filter(idx => resolveSlideTargetLane(sorted[idx]) !== sorted[idx].lane)
        .map(idx => {
            const n = sorted[idx];
            const secType = sectionAt(n.time);
            const sectionCost = secType === 'intro' || secType === 'outro' || secType === 'interlude'
                ? -1.8
                : secType === 'verse' || secType === 'bridge'
                    ? 0.2
                    : secType === 'chorus'
                        ? 0.95
                        : 1.25; // drop 우선 보존
            const strength = n.strength ?? 0.5;
            const dur = normalizeLongDuration('slide', n.duration, beatInterval);
            const hashJitter = (detHash(Math.round(n.time * 1000) + idx * 31) % 13) * 0.01;
            const score = sectionCost * 2.4 + strength * 1.1 + dur * 0.15 + hashJitter;
            return { idx, score };
        })
        .sort((a, b) => a.score - b.score);

    const diagonalCount = slideIndices.length - straightCount;
    const maxConvert = Math.max(0, diagonalCount - minDiagonalKeep);
    const convertCount = Math.min(needed, maxConvert);
    for (let i = 0; i < convertCount; i++) {
        const candidate = candidates[i];
        if (!candidate) break;
        const base = sorted[candidate.idx];
        if (!base || base.type !== 'slide') continue;
        const duration = normalizeLongDuration('slide', base.duration, beatInterval);
        sorted[candidate.idx] = {
            ...base,
            targetLane: base.lane,
            duration,
            strength: Math.max(0.46, (base.strength ?? 0.5) * 0.92),
        };
    }

    return dedupeNotes(sorted, 0.035);
};

const sculptSlideVocabulary = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty
): NoteData[] => {
    const base = enforceStraightSlideRatio(notes, sections, bpm, difficulty);

    const beatInterval = 60 / bpm;
    const out: NoteData[] = [...base].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const add: NoteData[] = [];
    const sectionLookup = createSectionLookup(sections);
    const sectionAt = (time: number) => sectionLookup(time)?.type ?? 'verse';
    const addRatioByDiff: Record<Difficulty, number> = {
        easy: 0.08,
        normal: 0.14,
        hard: 0.2,
        expert: 0.24,
    };
    const maxPatternAdds = Math.max(6, Math.floor(out.length * addRatioByDiff[difficulty]));
    let addCount = 0;

    const isLong = (n: NoteData): boolean =>
        (n.type === 'slide' || n.type === 'hold') && normalizeLongDuration(n.type, n.duration, beatInterval) > 0;
    const hasLongConflictNear = (time: number, lanes: readonly number[], win: number, ignore?: NoteData): boolean =>
        out.some(n => {
            if (ignore && n === ignore) return false;
            if (!isLong(n)) return false;
            if (Math.abs(n.time - time) >= win) return false;
            return lanesOverlap(getNoteLanes(n), lanes);
        }) || add.some(n => {
            if (!isLong(n)) return false;
            if (Math.abs(n.time - time) >= win) return false;
            return lanesOverlap(getNoteLanes(n), lanes);
        });

    // A) X자(교차) 대각선 양슬라이드
    let crossAdded = 0;
    for (const anchor of out) {
        if (addCount >= maxPatternAdds) break;
        if (anchor.type !== 'slide') continue;
        const toLane = resolveSlideTargetLane(anchor);
        if (toLane === anchor.lane) continue;
        const secType = sectionAt(anchor.time);
        const energeticSection = secType === 'drop' || secType === 'chorus' || secType === 'verse';
        if (!energeticSection) continue;

        const seed = detHash(Math.round(anchor.time * 1000) + anchor.lane * 53 + toLane * 19);
        const gate = difficulty === 'expert' ? 1 : difficulty === 'hard' ? 1 : 2;
        if (seed % gate !== 0) continue;

        const otherFrom = anchor.lane === 0 ? 1 : 0;
        const otherTo = toLane === 0 ? 1 : 0;
        const start = anchor.time + beatInterval * 0.045;
        const duration = Math.min(
            Math.max(normalizeLongDuration('slide', anchor.duration, beatInterval) * 0.94, MIN_SLIDE_DURATION_SEC),
            beatInterval * 2.4
        );
        const lanes = uniqueLanes([otherFrom, otherTo]);
        if (hasLongConflictNear(start, lanes, beatInterval * 0.16, anchor)) continue;

        add.push({
            time: start,
            lane: otherFrom,
            type: 'slide',
            targetLane: otherTo,
            duration,
            strength: Math.max(0.56, (anchor.strength ?? 0.5) * 0.82),
        });
        addCount++;
        crossAdded++;
    }

    // B) 같은 방향(일자) 양슬라이드 페어
    for (const anchor of out) {
        if (addCount >= maxPatternAdds) break;
        if (anchor.type !== 'slide') continue;
        if (resolveSlideTargetLane(anchor) !== anchor.lane) continue;
        const secType = sectionAt(anchor.time);
        if (secType === 'intro' || secType === 'outro' || secType === 'interlude') continue;
        const seed = detHash(Math.round(anchor.time * 1000) + anchor.lane * 47);
        const gate = difficulty === 'expert' ? 1 : difficulty === 'hard' ? 2 : 3;
        if (seed % gate !== 0) continue;

        const otherLane = anchor.lane === 0 ? 1 : 0;
        const start = anchor.time + beatInterval * 0.03;
        const duration = Math.min(
            Math.max(normalizeLongDuration('slide', anchor.duration, beatInterval) * 0.92, MIN_SLIDE_DURATION_SEC),
            beatInterval * 2.1
        );
        if (hasLongConflictNear(start, [otherLane], beatInterval * 0.14, anchor)) continue;

        add.push({
            time: start,
            lane: otherLane,
            type: 'slide',
            targetLane: otherLane,
            duration,
            strength: Math.max(0.52, (anchor.strength ?? 0.5) * 0.78),
        });
        addCount++;
    }

    // C) 교차 후보가 충분한데 하나도 안 들어간 경우 1개 강제 주입
    if (crossAdded === 0 && addCount < maxPatternAdds) {
        const fallback = out.find(n => {
            if (n.type !== 'slide' || !n.duration) return false;
            const to = resolveSlideTargetLane(n);
            if (to === n.lane) return false;
            const secType = sectionAt(n.time);
            return secType === 'drop' || secType === 'chorus';
        });
        if (fallback) {
            const to = resolveSlideTargetLane(fallback);
            const otherFrom = fallback.lane === 0 ? 1 : 0;
            const otherTo = to === 0 ? 1 : 0;
            const start = fallback.time + beatInterval * 0.05;
            const duration = Math.min(
                Math.max(normalizeLongDuration('slide', fallback.duration, beatInterval) * 0.92, MIN_SLIDE_DURATION_SEC),
                beatInterval * 2.25
            );
            if (!hasLongConflictNear(start, uniqueLanes([otherFrom, otherTo]), beatInterval * 0.17, fallback)) {
                add.push({
                    time: start,
                    lane: otherFrom,
                    type: 'slide',
                    targetLane: otherTo,
                    duration,
                    strength: Math.max(0.58, (fallback.strength ?? 0.5) * 0.84),
                });
            }
        }
    }

    return dedupeNotes([...out, ...add], 0.033);
};

const ensureSlidePresence = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    difficulty: Difficulty,
    bpm: number,
    duration: number
): NoteData[] => {
    const list = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    if (list.length < 4) return list;
    const beatInterval = 60 / bpm;
    const sectionAt = createSectionLookup(sections);
    const existingSlides = list.filter(n => n.type === 'slide').length;

    const baseTarget: Record<Difficulty, number> = {
        easy: Math.max(2, Math.floor(duration / 72)),
        normal: Math.max(5, Math.floor(duration / 32)),
        hard: Math.max(8, Math.floor(duration / 24)),
        expert: Math.max(11, Math.floor(duration / 18)),
    };
    const targetSlides = baseTarget[difficulty];
    if (existingSlides >= targetSlides) return list;

    const needed = targetSlides - existingSlides;
    let added = 0;
    for (let i = 0; i < list.length - 1 && added < needed; i++) {
        const a = list[i];
        const b = list[i + 1];
        if (a.type !== 'tap' || b.type !== 'tap') continue;
        const sameLane = a.lane === b.lane;
        const gap = b.time - a.time;
        const maxGapBeats = sameLane ? 5.6 : 4.8;
        if (gap < beatInterval * 0.6 || gap > beatInterval * maxGapBeats) continue;

        const sec = sectionAt(a.time);
        const type = sec?.type ?? 'verse';
        if (type === 'intro' || type === 'outro' || type === 'interlude') continue;

        const beatIdx = Math.round(a.time / beatInterval);
        const allow = sameLane
            ? (beatIdx % 8 === 1 || beatIdx % 8 === 2 || beatIdx % 8 === 5 || beatIdx % 8 === 6)
            : (beatIdx % 8 === 3 || beatIdx % 8 === 7);
        if (!allow) continue;
        const minSlideByDiff = sameLane
            ? Math.max(MIN_SLIDE_DURATION_SEC, beatInterval * 1.55)
            : Math.max(MIN_SLIDE_DURATION_SEC, beatInterval * 1.35);
        const maxSlideByDiff = sameLane ? beatInterval * 6.2 : beatInterval * 4.8;

        list[i] = {
            ...a,
            type: 'slide',
            targetLane: sameLane ? a.lane : b.lane,
            duration: Math.min(
                Math.max(gap * 0.98, minSlideByDiff),
                maxSlideByDiff
            ),
            strength: Math.max(0.6, a.strength ?? 0.5),
        };
        // 슬라이드 종착점 노트는 제거하여 "유지 후 도착" 감각 강화
        list.splice(i + 1, 1);
        added++;
    }

    return dedupeNotes(list, 0.04);
};

const injectSlideCounterRhythms = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number
): NoteData[] => {
    const beatInterval = 60 / bpm;
    const out: NoteData[] = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const add: NoteData[] = [];
    const maxAdd = Math.max(14, Math.floor(out.length * 0.34));
    let added = 0;

    const isNear = (time: number, lane: number, win: number): boolean =>
        out.some(n => n.lane === lane && Math.abs(n.time - time) < win)
        || add.some(n => n.lane === lane && Math.abs(n.time - time) < win);
    const sectionLookup = createSectionLookup(sections);
    const sectionAt = (t: number) => sectionLookup(t)?.type ?? 'verse';
    const snapToRhythm = (time: number): number => {
        const beatIdx = Math.round(time / beatInterval);
        return beatIdx * beatInterval;
    };

    for (const n of out) {
        if (added >= maxAdd) break;
        if (n.type !== 'slide' || !n.duration || n.duration < Math.max(1.05, beatInterval * 1.45)) continue;
        const secType = sectionAt(n.time);
        if (secType === 'intro' || secType === 'outro' || secType === 'interlude') continue;
        const targetLane = resolveSlideTargetLane(n);
        const straightSlide = targetLane === n.lane;
        const otherLane = n.lane === 0 ? 1 : 0;
        const tickGap = beatInterval * 0.5;
        const start = n.time + beatInterval * (straightSlide ? 0.38 : 0.62);
        const end = n.time + n.duration - beatInterval * (straightSlide ? 0.2 : 0.36);
        let addedForSlide = 0;
        if (straightSlide) {
            for (let t = start; t <= end && added < maxAdd; t += tickGap) {
                const snapped = snapToRhythm(t);
                if (isNear(snapped, otherLane, Math.max(0.08, beatInterval * 0.22))) continue;
                add.push({
                    time: snapped,
                    lane: otherLane,
                    type: 'tap',
                    strength: Math.max(0.58, (n.strength ?? 0.5) * 0.9),
                });
                added++;
                addedForSlide++;
            }
        } else {
            // 대각 슬라이드는 바톤 터치 느낌을 살리기 위해 중앙 구간 카운터 탭을 허용.
            const batonStart = n.time + n.duration * 0.42;
            const batonEnd = n.time + n.duration * 0.62;
            const batonStep = Math.max(beatInterval * 0.25, 0.12);
            for (let t = batonStart; t <= batonEnd && added < maxAdd; t += batonStep) {
                const snapped = snapToRhythm(t);
                if (isNear(snapped, targetLane, Math.max(0.07, beatInterval * 0.16))) continue;
                add.push({
                    time: snapped,
                    lane: targetLane,
                    type: 'tap',
                    strength: Math.max(0.6, (n.strength ?? 0.5) * 0.92),
                });
                added++;
                addedForSlide++;
            }

            // 전/후 앵커도 유지해 연결감 확보.
            const pre = snapToRhythm(n.time - beatInterval * 0.45);
            const post = snapToRhythm(n.time + n.duration + beatInterval * 0.36);
            if (!isNear(pre, n.lane, Math.max(0.08, beatInterval * 0.22))) {
                add.push({
                    time: pre,
                    lane: n.lane,
                    type: 'tap',
                    strength: Math.max(0.56, (n.strength ?? 0.5) * 0.84),
                });
                added++;
                addedForSlide++;
            }
            if (added < maxAdd && !isNear(post, targetLane, Math.max(0.08, beatInterval * 0.22))) {
                add.push({
                    time: post,
                    lane: targetLane,
                    type: 'tap',
                    strength: Math.max(0.56, (n.strength ?? 0.5) * 0.84),
                });
                added++;
                addedForSlide++;
            }
        }
        // 슬라이드가 단독으로 비어 보이지 않도록 최소 1개는 보장
        if (addedForSlide === 0 && added < maxAdd) {
            const fallbackLane = straightSlide ? otherLane : targetLane;
            const fallback = snapToRhythm(n.time + n.duration * (straightSlide ? 0.52 : 0.68));
            if (!isNear(fallback, fallbackLane, Math.max(0.08, beatInterval * 0.24))) {
                add.push({
                    time: fallback,
                    lane: fallbackLane,
                    type: 'tap',
                    strength: Math.max(0.56, (n.strength ?? 0.5) * 0.84),
                });
                added++;
            }
        }
    }

    return dedupeNotes([...out, ...add], 0.035);
};

const enrichSlideContexts = (
    notes: readonly NoteData[],
    bpm: number
): NoteData[] => {
    const beatInterval = 60 / bpm;
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const add: NoteData[] = [];
    const maxAdd = Math.max(8, Math.floor(sorted.length * 0.16));
    let added = 0;
    const longs = sorted
        .filter(n => (n.type === 'slide' || n.type === 'hold') && !!n.duration && n.duration > 0)
        .map(n => ({
            start: n.time,
            end: n.time + normalizeLongDuration(n.type, n.duration, beatInterval),
            lanes: getOccupiedControlLanes(n),
        }));

    const hasNear = (time: number, lane: number, win: number): boolean =>
        sorted.some(n => Math.abs(n.time - time) < win && n.lane === lane)
        || add.some(n => Math.abs(n.time - time) < win && n.lane === lane);
    const laneBusyAt = (time: number, lane: number): boolean =>
        longs.some(l => time >= l.start - 0.02 && time <= l.end + 0.02 && l.lanes.includes(lane));

    for (const n of sorted) {
        if (added >= maxAdd) break;
        if (n.type !== 'slide' || !n.duration || n.duration < Math.max(0.92, beatInterval * 1.25)) continue;

        const start = n.time;
        const end = start + normalizeLongDuration('slide', n.duration, beatInterval);
        const target = resolveSlideTargetLane(n);
        const otherLane = n.lane === 0 ? 1 : 0;
        const hasInnerSupport = sorted.some(m =>
            m.type === 'tap'
            && m.time > start + beatInterval * 0.2
            && m.time < end - beatInterval * 0.2
            && m.lane !== n.lane
        ) || add.some(m =>
            m.type === 'tap'
            && m.time > start + beatInterval * 0.2
            && m.time < end - beatInterval * 0.2
            && m.lane !== n.lane
        );
        if (hasInnerSupport) continue;

        const candidates: Array<{ time: number; lane: number }> = [];
        if (target === n.lane) {
            candidates.push({ time: start + beatInterval * 0.75, lane: otherLane });
            candidates.push({ time: end - beatInterval * 0.55, lane: otherLane });
        } else {
            candidates.push({ time: start + (end - start) * 0.42, lane: target });
            candidates.push({ time: start + (end - start) * 0.72, lane: target });
            candidates.push({ time: start - beatInterval * 0.4, lane: n.lane });
            candidates.push({ time: end + beatInterval * 0.35, lane: target });
        }

        for (const cand of candidates) {
            if (added >= maxAdd) break;
            const t = Math.max(0.02, Math.round(cand.time / (beatInterval * 0.5)) * (beatInterval * 0.5));
            if (hasNear(t, cand.lane, Math.max(0.08, beatInterval * 0.2))) continue;
            if (laneBusyAt(t, cand.lane)) continue;
            add.push({
                time: t,
                lane: cand.lane,
                type: 'tap',
                strength: Math.max(0.54, (n.strength ?? 0.5) * 0.84),
            });
            added++;
        }
    }
    return dedupeNotes([...sorted, ...add], 0.035);
};

const dedupeNotes = (notes: readonly NoteData[], minGap: number): NoteData[] => {
    const sorted = [...notes].sort((a, b) => a.time - b.time);
    const priority = (n: NoteData): number =>
        n.type === 'burst'
            ? 4
            : n.type === 'slide'
                ? 3
                : n.type === 'hold'
                    ? 2
                    : 1;
    const out: NoteData[] = [];
    for (const n of sorted) {
        const prev = out[out.length - 1];
        if (!prev) {
            out.push(n);
            continue;
        }
        if (Math.abs(n.time - prev.time) < minGap && n.lane === prev.lane) {
            const pN = priority(n);
            const pPrev = priority(prev);
            if (
                pN > pPrev
                || (pN === pPrev && (n.strength ?? 0.5) > (prev.strength ?? 0.5))
            ) {
                out[out.length - 1] = n;
            }
            continue;
        }
        out.push(n);
    }
    return out;
};

const alignSmoothMelodyFlow = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty
): NoteData[] => {
    if (notes.length === 0 || onsetTimes.length < 8) return [...notes];
    if (difficulty === 'expert') return [...notes];

    const avgEnergy = sections.length > 0
        ? sections.reduce((acc, s) => acc + (s.avgEnergy || 0.5), 0) / sections.length
        : 0.5;
    const energyVar = sections.length > 0
        ? sections.reduce((acc, s) => acc + Math.pow((s.avgEnergy || avgEnergy) - avgEnergy, 2), 0) / sections.length
        : 0.03;
    const isSmoothTrack = avgEnergy <= 0.58 && energyVar <= 0.026 && bpm <= 152;
    if (!isSmoothTrack) return [...notes];

    const sortedOnsets = [...onsetTimes].sort((a, b) => a - b);
    const beatInterval = 60 / bpm;
    const maxSnap = Math.min(0.12, Math.max(0.045, beatInterval * 0.24));
    const sectionAt = createSectionLookup(sections);

    const nearestOnset = (time: number): number | null => {
        let lo = 0;
        let hi = sortedOnsets.length - 1;
        let best = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const v = sortedOnsets[mid];
            const d = Math.abs(v - time);
            if (d < bestDist) {
                bestDist = d;
                best = mid;
            }
            if (v < time) lo = mid + 1;
            else hi = mid - 1;
        }
        if (best < 0) return null;
        const t = sortedOnsets[best];
        return Math.abs(t - time) <= maxSnap ? t : null;
    };

    const aligned = notes.map(note => {
        if (note.type === 'slide' || note.type === 'hold') return { ...note };
        const section = sectionAt(note.time);
        const secType = section?.type ?? 'verse';
        if (secType === 'drop' || secType === 'chorus') return { ...note };
        if ((note.strength ?? 0.5) > 0.82) return { ...note };
        const onset = nearestOnset(note.time);
        if (onset === null) return { ...note };
        return {
            ...note,
            time: onset,
        };
    });

    return dedupeNotes(aligned, 0.038);
};

const injectExpressiveCombos = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty
): NoteData[] => {
    if (notes.length < 8) return [...notes];
    const beatInterval = 60 / bpm;
    const out: NoteData[] = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const add: NoteData[] = [];
    const isNear = (time: number, lane: number, win: number): boolean =>
        out.some(n => n.lane === lane && Math.abs(n.time - time) < win)
        || add.some(n => n.lane === lane && Math.abs(n.time - time) < win);
    const sectionAt = createSectionLookup(sections);
    const extraRatio = difficulty === 'easy'
        ? 0.08
        : difficulty === 'normal'
            ? 0.16
            : difficulty === 'hard'
                ? 0.24
                : 0.34;
    const cfg = {
        extraRatio,
        longMinDur: 1.2,
        longTapGapBeats: 1.7,
        longTapMax: 4,
        longTapGate: 3,
        chordGate: 8,
        allowReturnSlide: true,
        allowDualSlide: true,
    };
    const baseCount = out.length;
    const maxExtra = Math.max(4, Math.floor(baseCount * cfg.extraRatio));
    let extraCount = 0;
    const canAdd = (): boolean => extraCount < maxExtra;
    const pushIfFree = (note: NoteData, laneWin = 0.065): boolean => {
        if (!canAdd()) return false;
        if (isNear(note.time, note.lane, laneWin)) return false;
        add.push(note);
        extraCount++;
        return true;
    };
    const hasNearSlide = (time: number, win: number): boolean =>
        out.some(n => n.type === 'slide' && Math.abs(n.time - time) < win)
        || add.some(n => n.type === 'slide' && Math.abs(n.time - time) < win);

    // 1) 긴 슬라이드/홀드 위에 반대 레인 리듬(통통 튀는 보조타) 삽입
    for (const n of out) {
        if (!canAdd()) break;
        if ((n.type !== 'slide' && n.type !== 'hold') || !n.duration || n.duration < cfg.longMinDur) continue;
        const sec = sectionAt(n.time);
        const type = sec?.type ?? 'verse';
        if (type === 'intro' || type === 'outro' || type === 'interlude') continue;

        const otherLane = n.lane === 0 ? 1 : 0;
        const tickGap = beatInterval * cfg.longTapGapBeats;
        const start = n.time + beatInterval * 0.62;
        const end = n.time + n.duration - beatInterval * 0.45;
        let ticks = 0;
        for (let t = start; t <= end; t += tickGap) {
            if (!canAdd() || ticks >= cfg.longTapMax) break;
            const seed = Math.round((n.time * 1000) + (t * 700));
            if (cfg.longTapGate > 1 && detHash(seed) % cfg.longTapGate !== 0) continue;
            const added = pushIfFree({
                time: t,
                lane: otherLane,
                type: 'tap',
                strength: Math.max(0.56, (n.strength ?? 0.55) * 0.86),
            }, 0.085);
            if (added) ticks++;
        }
    }

    // 2) 강세 비트 동시 타격(위+아래) 콤보
    if (cfg.chordGate < 9999) {
        for (const n of out) {
            if (!canAdd()) break;
            if (n.type !== 'tap') continue;
            const sec = sectionAt(n.time);
            const type = sec?.type ?? 'verse';
            if (type === 'intro' || type === 'outro' || type === 'interlude') continue;
            if ((n.strength ?? 0.5) < 0.62) continue;
            const seed = Math.round(n.time * 1000) + n.lane * 19;
            if (detHash(seed) % cfg.chordGate !== 0) continue;
            const otherLane = n.lane === 0 ? 1 : 0;
            pushIfFree({
                time: n.time,
                lane: otherLane,
                type: 'tap',
                strength: Math.max(0.58, (n.strength ?? 0.5) * 0.82),
            }, 0.06);
        }
    }

    // 3) 슬라이드 교차/리턴 + 동시 슬라이드 패턴 (코러스/드랍)
    if (cfg.allowReturnSlide || cfg.allowDualSlide) {
        for (const n of out) {
            if (!canAdd()) break;
            if (n.type !== 'slide' || !n.duration || n.duration < beatInterval * 0.9) continue;
            const sec = sectionAt(n.time);
            const type = sec?.type ?? 'verse';
            if (type !== 'drop' && type !== 'chorus') continue;
            const fromLane = n.lane;
            const toLane = n.targetLane ?? (n.lane === 0 ? 1 : 0);

            if (cfg.allowReturnSlide) {
                const returnTime = n.time + n.duration * 0.84;
                if (!hasNearSlide(returnTime, beatInterval * 0.26)) {
                    pushIfFree({
                        time: returnTime,
                        lane: toLane,
                        type: 'slide',
                        targetLane: fromLane,
                        duration: Math.max(MIN_SLIDE_DURATION_SEC, Math.max(beatInterval * 0.82, Math.min(1.55, n.duration * 0.7))),
                        strength: Math.max(0.62, (n.strength ?? 0.5) * 0.88),
                    }, 0.08);
                }
            }

            if (cfg.allowDualSlide && canAdd()) {
                const dualSeed = detHash(Math.round(n.time * 1000) + fromLane * 37);
                if (dualSeed % 4 === 0) {
                    const otherFrom = fromLane === 0 ? 1 : 0;
                    const otherTo = toLane === 0 ? 1 : 0;
                    const dualTime = n.time + beatInterval * 0.08;
                    if (!hasNearSlide(dualTime, beatInterval * 0.2)) {
                        pushIfFree({
                            time: dualTime,
                            lane: otherFrom,
                            type: 'slide',
                            targetLane: otherTo,
                            duration: Math.max(MIN_SLIDE_DURATION_SEC, Math.max(beatInterval * 0.78, Math.min(1.5, n.duration * 0.92))),
                            strength: Math.max(0.58, (n.strength ?? 0.5) * 0.82),
                        }, 0.08);
                    }
                }
            }
        }
    }

    return dedupeNotes([...out, ...add], 0.033);
};

const refineGlobalSync = (
    notes: readonly NoteData[],
    onsets: readonly number[]
): NoteData[] => {
    if (notes.length < 8 || onsets.length < 8) return [...notes];
    const sortedOnsets = [...onsets].sort((a, b) => a - b);
    const sortedNotes = [...notes].sort((a, b) => a.time - b.time);

    const nearestOnsetDist = (time: number): number => {
        let lo = 0;
        let hi = sortedOnsets.length - 1;
        let best = Number.POSITIVE_INFINITY;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const onset = sortedOnsets[mid];
            const d = Math.abs(onset - time);
            if (d < best) best = d;
            if (onset < time) lo = mid + 1;
            else hi = mid - 1;
        }
        return best;
    };

    let bestShift = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let shiftMs = -90; shiftMs <= 90; shiftMs += 5) {
        const shift = shiftMs / 1000;
        let score = 0;
        let used = 0;
        for (const note of sortedNotes) {
            if (note.time < 0.4) continue;
            const w = 0.6 + (note.strength ?? 0.5);
            const d = Math.min(0.14, nearestOnsetDist(note.time + shift));
            score += d * w;
            used++;
        }
        if (used < 6) break;
        const normalized = score / used;
        if (normalized < bestScore) {
            bestScore = normalized;
            bestShift = shift;
        }
    }

    if (Math.abs(bestShift) < 0.006) return sortedNotes;
    return dedupeNotes(sortedNotes.map(note => ({
        ...note,
        time: Math.max(0.02, note.time + bestShift),
    })), 0.04);
};

const refineLocalSyncDrift = (
    notes: readonly NoteData[],
    onsets: readonly number[],
    bpm: number
): NoteData[] => {
    if (notes.length < 16 || onsets.length < 16 || bpm <= 0) return [...notes];
    const sortedNotes = [...notes].sort((a, b) => a.time - b.time);
    const sortedOnsets = [...onsets].sort((a, b) => a - b);
    const songEnd = sortedNotes[sortedNotes.length - 1]?.time ?? 0;
    if (songEnd <= 2) return sortedNotes;

    const beatInterval = 60 / bpm;
    const windowSec = Math.max(6, Math.min(10, beatInterval * 18));
    const hopSec = windowSec * 0.5;
    const maxShiftSec = 0.045;
    const candidateShifts: number[] = [];
    for (let ms = -45; ms <= 45; ms += 5) candidateShifts.push(ms / 1000);

    const nearestOnsetDist = (time: number): number => {
        let lo = 0;
        let hi = sortedOnsets.length - 1;
        let best = Number.POSITIVE_INFINITY;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const onset = sortedOnsets[mid];
            const d = Math.abs(onset - time);
            if (d < best) best = d;
            if (onset < time) lo = mid + 1;
            else hi = mid - 1;
        }
        return best;
    };

    const anchors: Array<{ center: number; shift: number }> = [];
    for (let start = 0; start <= songEnd; start += hopSec) {
        const end = start + windowSec;
        const segment = sortedNotes.filter(n => n.time >= start && n.time < end && n.time > 0.35);
        if (segment.length < 6) continue;

        const focus = segment.filter(n => n.type !== 'hold' && (n.strength ?? 0.5) >= 0.28);
        if (focus.length < 4) continue;

        let bestShift = 0;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const shift of candidateShifts) {
            let score = 0;
            let used = 0;
            for (const n of focus) {
                const w = 0.75 + (n.strength ?? 0.5);
                const d = Math.min(0.15, nearestOnsetDist(n.time + shift));
                score += d * w;
                used++;
            }
            if (used < 4) continue;
            const normalized = score / used + Math.abs(shift) * 0.22;
            if (normalized < bestScore) {
                bestScore = normalized;
                bestShift = shift;
            }
        }

        if (Math.abs(bestShift) >= 0.004) {
            anchors.push({
                center: start + windowSec * 0.5,
                shift: Math.max(-maxShiftSec, Math.min(maxShiftSec, bestShift)),
            });
        }
    }

    if (anchors.length === 0) return sortedNotes;
    anchors.sort((a, b) => a.center - b.center);
    const shiftAt = (time: number): number => {
        if (time <= anchors[0].center) return anchors[0].shift;
        if (time >= anchors[anchors.length - 1].center) return anchors[anchors.length - 1].shift;
        for (let i = 1; i < anchors.length; i++) {
            const b = anchors[i];
            if (time > b.center) continue;
            const a = anchors[i - 1];
            const t = (time - a.center) / Math.max(1e-4, b.center - a.center);
            return lerp(a.shift, b.shift, Math.max(0, Math.min(1, t)));
        }
        return 0;
    };

    const adjusted = sortedNotes.map(note => {
        const shift = shiftAt(note.time) * 0.82;
        const moved = Math.max(0.02, note.time + shift);
        return { ...note, time: moved };
    });
    return dedupeNotes(adjusted, 0.039);
};

const polishRhythmSyncByStrongOnsets = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    bpm: number,
    difficulty: Difficulty
): NoteData[] => {
    if (notes.length < 8 || onsetTimes.length < 8 || bpm <= 0) return [...notes];
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const onsetPairs = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
    if (onsetPairs.length < 8) return sorted;

    const percentile = (values: readonly number[], q: number): number => {
        if (values.length === 0) return 0.6;
        const sv = [...values].sort((a, b) => a - b);
        const pos = Math.max(0, Math.min(1, q)) * (sv.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sv[lo];
        return lerp(sv[lo], sv[hi], pos - lo);
    };
    const strongThreshold = Math.max(0.52, percentile(onsetPairs.map(p => p.strength), 0.66));
    const strongOnsets = onsetPairs.filter(p => p.strength >= strongThreshold);
    if (strongOnsets.length < 4) return sorted;
    const strongTimes = strongOnsets.map(p => p.time);
    const beatInterval = 60 / bpm;
    const maxSnap = difficulty === 'easy'
        ? Math.max(0.035, beatInterval * 0.14)
        : difficulty === 'normal'
            ? Math.max(0.03, beatInterval * 0.12)
            : Math.max(0.026, beatInterval * 0.1);

    const nearestStrong = (time: number): number | null => {
        let lo = 0;
        let hi = strongTimes.length - 1;
        let best = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const d = Math.abs(strongTimes[mid] - time);
            if (d < bestDist) {
                bestDist = d;
                best = mid;
            }
            if (strongTimes[mid] < time) lo = mid + 1;
            else hi = mid - 1;
        }
        if (best < 0 || bestDist > maxSnap) return null;
        return strongTimes[best];
    };

    const adjusted = sorted.map(n => {
        if (n.type === 'slide' || n.type === 'hold') return n;
        const strong = nearestStrong(n.time);
        if (strong === null) return n;
        const str = n.strength ?? 0.5;
        const moveRatio = Math.max(0.58, Math.min(0.9, 0.84 - str * 0.28));
        return {
            ...n,
            time: lerp(n.time, strong, moveRatio),
        };
    });
    return dedupeNotes(adjusted, 0.038);
};

const injectBurstBreakerNotes = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    spectralProfiles: readonly SpectralProfile[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length < 10 || onsetTimes.length < 8) return [...notes].sort((a, b) => a.time - b.time);
    if (difficulty === 'easy') return [...notes].sort((a, b) => a.time - b.time);

    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const beatInterval = 60 / Math.max(1, bpm);
    const onsetPairs = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
    if (onsetPairs.length < 8) return sorted;

    const percentile = (values: readonly number[], q: number, fallback: number): number => {
        if (values.length === 0) return fallback;
        const sv = [...values].sort((a, b) => a - b);
        const pos = Math.max(0, Math.min(1, q)) * (sv.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sv[lo];
        return lerp(sv[lo], sv[hi], pos - lo);
    };
    const strongThreshold = Math.max(0.62, percentile(onsetPairs.map(p => p.strength), 0.78, 0.7));
    const targetCount: Record<Difficulty, number> = {
        easy: 0,
        normal: 2,
        hard: 4,
        expert: 6,
    };
    const existing = sorted.filter(n => n.type === 'burst').length;
    if (existing >= targetCount[difficulty]) return sorted;

    const strongCandidates = onsetPairs.filter(p => p.strength >= strongThreshold);
    if (strongCandidates.length === 0) return sorted;

    let sectionPtr = 0;
    const sectionAt = (time: number): { type: string; avgEnergy: number } => {
        while (sectionPtr + 1 < sections.length && time >= sections[sectionPtr].endTime) sectionPtr++;
        while (sectionPtr > 0 && time < sections[sectionPtr].startTime) sectionPtr--;
        return sections[sectionPtr] ?? { type: 'verse', avgEnergy: 0.5 };
    };
    const burstSpacingMul = difficulty === 'normal'
        ? 0.78
        : difficulty === 'hard'
            ? 0.68
            : 0.58;
    const burstDurationForDiff = difficulty === 'normal'
        ? Math.max(0.72, beatInterval * 1.65)
        : difficulty === 'hard'
            ? Math.max(0.86, beatInterval * 1.95)
            : Math.max(0.98, beatInterval * 2.2);
    const nearCount = (time: number, winMul: number): number => {
        const win = beatInterval * winMul;
        let c = 0;
        for (const n of sorted) {
            if (Math.abs(n.time - time) < win) c++;
        }
        for (const n of add) {
            if (Math.abs(n.time - time) < win) c++;
        }
        return c;
    };
    const nearestNoteDistance = (time: number): number => {
        let best = Number.POSITIVE_INFINITY;
        for (const n of sorted) {
            best = Math.min(best, Math.abs(n.time - time));
        }
        for (const n of add) {
            best = Math.min(best, Math.abs(n.time - time));
        }
        return best;
    };
    const blockedByNearby = (time: number): boolean => {
        const nearest = nearestNoteDistance(time);
        if (nearest < beatInterval * burstSpacingMul) return true;
        // 버스트는 쉬는 구간(낮은 로컬 밀도)에서만 배치.
        return nearCount(time, 0.92) > (difficulty === 'normal' ? 3 : 4);
    };
    const hasBurstWindowConflict = (time: number, duration: number): boolean => {
        const start = time - 0.05;
        const end = time + duration + 0.06;
        const overlaps = (n: NoteData): boolean => {
            const nStart = n.time;
            const nDur = (n.type === 'slide' || n.type === 'hold')
                ? normalizeLongDuration(n.type, n.duration, beatInterval)
                : 0;
            const nEnd = nStart + nDur;
            if (n.type === 'slide' || n.type === 'hold') {
                return Math.max(start, nStart) < Math.min(end, nEnd) - 0.03;
            }
            return nStart >= start && nStart <= end;
        };
        return sorted.some(overlaps) || add.some(overlaps);
    };

    const add: NoteData[] = [];
    const maxAdd = Math.max(1, targetCount[difficulty] - existing);
    for (const onset of strongCandidates) {
        if (add.length >= maxAdd) break;
        const sec = sectionAt(onset.time);
        if (sec.type === 'intro' || sec.type === 'outro' || sec.type === 'interlude') continue;
        const isHighlight = sec.type === 'drop' || sec.type === 'chorus' || (sec.avgEnergy || 0.5) >= 0.72;
        const sustained = songFeatures.sustainedFocus;
        const percussive = songFeatures.percussiveFocus;
        const profile = getSpectralProfileAt(spectralProfiles, onset.time);
        const transient = profile?.transient ?? percussive;
        if (!isHighlight && transient < 0.62) continue;
        if (!isHighlight && sustained > 0.62 && transient < 0.72) continue;

        const snapped = Math.max(0.05, Math.round(onset.time / (beatInterval * 0.5)) * (beatInterval * 0.5));
        if (blockedByNearby(snapped)) continue;

        const hitsRequired = difficulty === 'normal'
            ? 4 + (detHash(Math.round(snapped * 1000)) % 2)
            : difficulty === 'hard'
                ? 5 + (detHash(Math.round(snapped * 1000) + 11) % 3)
                : 6 + (detHash(Math.round(snapped * 1000) + 23) % 3);
        const duration = burstDurationForDiff;
        if (hasBurstWindowConflict(snapped, duration)) continue;

        add.push({
            time: snapped,
            lane: 1,
            type: 'burst',
            duration: Math.min(2.1, duration),
            burstHitsRequired: hitsRequired,
            strength: Math.max(0.56, onset.strength * 0.9),
        });
    }

    if (add.length === 0 && maxAdd > 0) {
        // 강세 기반이더라도 "쉬는 공간"이 있는 위치만 허용.
        const fallback = strongCandidates.find(onset => {
            const sec = sectionAt(onset.time);
            if (sec.type === 'intro' || sec.type === 'outro' || sec.type === 'interlude') return false;
            const isHighlight = sec.type === 'drop' || sec.type === 'chorus' || (sec.avgEnergy || 0.5) >= 0.68;
            if (!isHighlight && (onset.strength < strongThreshold * 1.04)) return false;
            const snapped = Math.max(0.05, Math.round(onset.time / (beatInterval * 0.5)) * (beatInterval * 0.5));
            return !blockedByNearby(snapped);
        });
        if (fallback) {
            const snapped = Math.max(0.05, Math.round(fallback.time / (beatInterval * 0.5)) * (beatInterval * 0.5));
            const hitsRequired = difficulty === 'normal'
                ? 4
                : difficulty === 'hard'
                    ? 5
                    : 6;
            const duration = burstDurationForDiff;
            if (!hasBurstWindowConflict(snapped, duration)) {
                add.push({
                    time: snapped,
                    lane: 1,
                    type: 'burst',
                    duration: Math.min(2.1, duration),
                    burstHitsRequired: hitsRequired,
                    strength: Math.max(0.62, fallback.strength * 0.92),
                });
            }
        }
    }

    if (add.length === 0) return sorted;
    const merged = dedupeNotes([...sorted, ...add], 0.04);
    return dedupeNotes(resolveLongNoteCollisions(merged, bpm), 0.036);
};

const enforceBurstNonOverlap = (
    notes: readonly NoteData[],
    bpm: number
): NoteData[] => {
    if (notes.length <= 1) return [...notes];
    const beatInterval = 60 / Math.max(1, bpm);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const longs = sorted
        .filter(n => (n.type === 'slide' || n.type === 'hold') && (n.duration ?? 0) > 0.05)
        .map(n => ({
            start: n.time,
            end: n.time + normalizeLongDuration(n.type, n.duration, beatInterval),
        }));

    const out: NoteData[] = [];
    for (const note of sorted) {
        if (note.type !== 'burst') {
            out.push(note);
            continue;
        }
        const burstDur = Math.max(0.52, Math.min(2.2, note.duration ?? 0.9));
        const burstStart = note.time - 0.04;
        const burstEnd = note.time + burstDur + 0.05;
        const nearTapWindow = Math.max(0.09, beatInterval * 0.18);

        const overlapsLong = longs.some(l => Math.max(burstStart, l.start) < Math.min(burstEnd, l.end) - 0.03);
        if (overlapsLong) continue;

        const overlapsTap = sorted.some(n =>
            n !== note
            && n.type !== 'slide'
            && n.type !== 'hold'
            && Math.abs(n.time - note.time) < nearTapWindow
        );
        if (overlapsTap) continue;

        out.push(note);
    }
    return dedupeNotes(out, 0.036);
};

const repairSparseAndOffRhythmWindows = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length === 0) return [];
    if (beatPositions.length === 0 || bpm <= 0) return [...notes].sort((a, b) => a.time - b.time);
    const beatInterval = 60 / bpm;
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const playableSection = (type: string): boolean =>
        type !== 'intro' && type !== 'outro' && type !== 'interlude';
    const sectionSorted = [...sections].sort((a, b) => a.startTime - b.startTime);
    let sectionPtr = 0;
    const getSection = (time: number): { type: string; avgEnergy: number } => {
        while (sectionPtr + 1 < sectionSorted.length && time >= sectionSorted[sectionPtr].endTime) sectionPtr++;
        while (sectionPtr > 0 && time < sectionSorted[sectionPtr].startTime) sectionPtr--;
        return sectionSorted[sectionPtr] ?? { type: 'verse', avgEnergy: 0.5 };
    };

    const gridSubdiv = difficulty === 'hard' || difficulty === 'expert' ? 4 : 2;
    const nearestGrid = (time: number): number => {
        let lo = 0;
        let hi = beatPositions.length - 1;
        let idx = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (beatPositions[mid] < time) {
                idx = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        let best = time;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = Math.max(0, idx - 1); i <= Math.min(beatPositions.length - 1, idx + 1); i++) {
            const beat = beatPositions[i];
            for (let s = 0; s < gridSubdiv; s++) {
                const candidate = beat + (beatInterval * s) / gridSubdiv;
                const d = Math.abs(candidate - time);
                if (d < bestDist) {
                    bestDist = d;
                    best = candidate;
                }
            }
        }
        return best;
    };

    const sanitized: NoteData[] = [];
    for (const note of sorted) {
        if (note.type === 'slide' || note.type === 'hold') {
            sanitized.push(note);
            continue;
        }
        const sec = getSection(note.time);
        const highlight = sec.type === 'drop' || sec.type === 'chorus' || (sec.avgEnergy || 0.5) >= 0.72;
        const snapped = nearestGrid(note.time);
        const dist = Math.abs(snapped - note.time);
        const strength = note.strength ?? 0.5;
        const snapLimit = highlight
            ? Math.max(0.03, beatInterval * 0.15)
            : Math.max(0.035, beatInterval * 0.19);
        const pruneLimit = highlight
            ? Math.max(0.08, beatInterval * 0.34)
            : Math.max(0.1, beatInterval * 0.28);
        if (dist > pruneLimit && playableSection(sec.type) && strength < 0.58) {
            continue;
        }
        if (dist <= snapLimit) {
            sanitized.push({
                ...note,
                time: lerp(note.time, snapped, Math.max(0.56, 0.9 - strength * 0.28)),
            });
            continue;
        }
        sanitized.push(note);
    }
    const base = dedupeNotes(sanitized, 0.036);
    const baseTimes = base.map(n => n.time);

    const onsets = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
    if (onsets.length < 6) return base;

    const onsetTimesOnly = onsets.map(p => p.time);
    const prefixWeighted: number[] = new Array(onsets.length + 1).fill(0);
    const prefixStrong: number[] = new Array(onsets.length + 1).fill(0);
    for (let i = 0; i < onsets.length; i++) {
        const weight = clamp01((onsets[i].strength - 0.28) / 0.72);
        prefixWeighted[i + 1] = prefixWeighted[i] + weight;
        prefixStrong[i + 1] = prefixStrong[i] + (onsets[i].strength >= 0.7 ? 1 : 0);
    }
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const rangeStats = (start: number, end: number): { weightedDensity: number; strongDensity: number } => {
        if (end <= start) return { weightedDensity: 0, strongDensity: 0 };
        const i0 = lowerBound(onsetTimesOnly, start);
        const i1 = lowerBound(onsetTimesOnly, end);
        const dur = Math.max(0.001, end - start);
        if (i1 <= i0) return { weightedDensity: 0, strongDensity: 0 };
        const weighted = prefixWeighted[i1] - prefixWeighted[i0];
        const strong = prefixStrong[i1] - prefixStrong[i0];
        return {
            weightedDensity: weighted / dur,
            strongDensity: strong / dur,
        };
    };

    const add: NoteData[] = [];
    const addTimes: number[] = [];
    const occupancyWindow = Math.max(0.055, beatInterval * 0.18);
    const occupancyStep = Math.max(0.03, occupancyWindow * 0.58);
    const occ = new Set<number>();
    const toBucket = (time: number): number => Math.round(time / occupancyStep);
    const markOcc = (time: number): void => {
        const b = toBucket(time);
        occ.add(b - 1);
        occ.add(b);
        occ.add(b + 1);
    };
    for (const n of base) markOcc(n.time);
    const hasNear = (time: number): boolean => occ.has(toBucket(time));
    const baseLaneTimes: [number[], number[]] = [[], []];
    for (let i = 0; i < base.length; i++) {
        baseLaneTimes[base[i].lane === 0 ? 0 : 1].push(base[i].time);
    }
    const addLaneTimes: [number[], number[]] = [[], []];
    const hasNearTime = (arr: readonly number[], time: number, win: number): boolean => {
        if (arr.length === 0) return false;
        const idx = lowerBound(arr, time);
        if (idx < arr.length && Math.abs(arr[idx] - time) < win) return true;
        if (idx > 0 && Math.abs(arr[idx - 1] - time) < win) return true;
        return false;
    };
    const hasLaneNear = (time: number, lane: number): boolean => {
        const laneIdx = lane === 0 ? 0 : 1;
        return hasNearTime(baseLaneTimes[laneIdx], time, occupancyWindow)
            || hasNearTime(addLaneTimes[laneIdx], time, occupancyWindow);
    };

    const targetNps: Record<Difficulty, number> = {
        easy: 2.3,
        normal: 4.4,
        hard: 6.6,
        expert: 8.8,
    };
    const calmSuppress = clamp01(songFeatures.calmConfidence * 0.9 - songFeatures.driveScore * 0.44);
    const maxAdd = Math.max(10, Math.floor(base.length * (difficulty === 'easy' ? 0.18 : difficulty === 'normal' ? 0.32 : difficulty === 'hard' ? 0.48 : 0.65)));
    let added = 0;
    const baseByTime = [...base].sort((a, b) => a.time - b.time);
    const addByTime: Array<{ time: number; lane: number }> = [];

    const nearestPreviousLane = (time: number): number => {
        const baseIdx = lowerBound(baseTimes, time) - 1;
        const addIdx = lowerBound(addTimes, time) - 1;
        const baseCand = baseIdx >= 0 ? baseByTime[baseIdx] : null;
        const addCand = addIdx >= 0 ? addByTime[addIdx] : null;
        if (!baseCand && !addCand) return 1;
        if (!baseCand) return addCand!.lane;
        if (!addCand) return baseCand.lane;
        return addCand.time >= baseCand.time ? addCand.lane : baseCand.lane;
    };

    for (const sec of sectionSorted) {
        if (!playableSection(sec.type)) continue;
        const secDur = Math.max(0.001, sec.endTime - sec.startTime);
        if (secDur < beatInterval * 2) continue;
        const highlight = sec.type === 'drop' || sec.type === 'chorus' || (sec.avgEnergy || 0.5) >= 0.72;
        const windowSec = Math.max(2.2, Math.min(4.8, beatInterval * 8));
        const hopSec = windowSec * 0.55;

        for (let ws = sec.startTime; ws < sec.endTime && added < maxAdd; ws += hopSec) {
            const we = Math.min(sec.endTime, ws + windowSec);
            const dur = Math.max(0.001, we - ws);
            if (dur < beatInterval * 1.8) continue;
            const baseExisting = lowerBound(baseTimes, we) - lowerBound(baseTimes, ws);
            const addExisting = lowerBound(addTimes, we) - lowerBound(addTimes, ws);
            const existing = baseExisting + addExisting;
            const stats = rangeStats(ws, we);
            const beatPerSec = Math.max(0.8, 1 / Math.max(1e-4, beatInterval));
            const activity = clamp01(stats.weightedDensity / (beatPerSec * 0.95));
            const strongBoost = clamp01(stats.strongDensity / (beatPerSec * 0.62));
            let desiredNps = targetNps[difficulty] * (0.58 + activity * 0.72 + strongBoost * 0.22);
            if (!highlight) desiredNps *= 1 - calmSuppress * 0.26;
            if ((sec.type === 'verse' || sec.type === 'bridge') && activity < 0.3) desiredNps *= 0.88;
            const target = Math.max(highlight ? 2 : 1, Math.floor(dur * desiredNps));
            if (existing >= target) continue;

            let missing = Math.min(6, target - existing);
            const i0 = lowerBound(onsetTimesOnly, ws);
            const i1 = lowerBound(onsetTimesOnly, we);
            const minStrength = highlight ? 0.5 : 0.56;
            const localCap = Math.max(8, Math.min(32, missing * 6));
            const local: Array<{ time: number; strength: number }> = [];
            for (let oi = i0; oi < i1; oi++) {
                const cand = onsets[oi];
                if (cand.strength < minStrength) continue;
                if (local.length < localCap) {
                    local.push(cand);
                    for (let j = local.length - 1; j > 0; j--) {
                        if (local[j].strength <= local[j - 1].strength) break;
                        const tmp = local[j - 1];
                        local[j - 1] = local[j];
                        local[j] = tmp;
                    }
                    continue;
                }
                if (cand.strength <= local[local.length - 1].strength) continue;
                local[local.length - 1] = cand;
                for (let j = local.length - 1; j > 0; j--) {
                    if (local[j].strength <= local[j - 1].strength) break;
                    const tmp = local[j - 1];
                    local[j - 1] = local[j];
                    local[j] = tmp;
                }
            }
            if (local.length === 0) continue;

            let lane = nearestPreviousLane(ws);
            for (const cand of local) {
                if (missing <= 0 || added >= maxAdd) break;
                let snapped = nearestGrid(cand.time);
                snapped = Math.max(ws + 0.03, Math.min(we - 0.03, snapped));
                if (hasNear(snapped)) continue;
                lane = lane === 0 ? 1 : 0;
                let useLane = lane;
                if (hasLaneNear(snapped, useLane)) {
                    const alt = useLane === 0 ? 1 : 0;
                    if (hasLaneNear(snapped, alt)) continue;
                    useLane = alt;
                }
                add.push({
                    time: snapped,
                    lane: useLane,
                    type: 'tap',
                    strength: Math.max(0.46, cand.strength * 0.82),
                });
                const insertT = lowerBound(addTimes, snapped);
                addTimes.splice(insertT, 0, snapped);
                const laneArr = addLaneTimes[useLane === 0 ? 0 : 1];
                const insertLane = lowerBound(laneArr, snapped);
                laneArr.splice(insertLane, 0, snapped);
                addByTime.splice(insertT, 0, { time: snapped, lane: useLane });
                markOcc(snapped);
                added++;
                missing--;
            }
        }
    }

    if (add.length === 0) return base;
    return dedupeNotes([...base, ...add], 0.036);
};

const ensureIntroCoverage = (
    notes: readonly NoteData[],
    onsets: readonly number[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures?: BeatMapSongFeatures
): NoteData[] => {
    const sorted = [...notes].sort((a, b) => a.time - b.time);
    if (sorted.length === 0 || beatPositions.length < 2) return sorted;
    const sectionAt = createSectionLookup(sections);
    const calmTrack = (songFeatures?.calmConfidence ?? 0.5) >= 0.58;
    if (calmTrack) {
        return sorted;
    }

    const firstTime = sorted[0].time;
    const maxAllowedStart: Record<Difficulty, number> = {
        easy: 1.8,
        normal: 1.35,
        hard: 1.05,
        expert: 0.9,
    };
    if (firstTime <= maxAllowedStart[difficulty]) return sorted;

    const beatInterval = 60 / bpm;
    const introWindowEnd = Math.min(firstTime - 0.25, 12);
    if (introWindowEnd <= 0.8) return sorted;

    const injectTarget: Record<Difficulty, number> = {
        easy: 4,
        normal: 7,
        hard: 9,
        expert: 11,
    };

    const introOnsets = onsets
        .filter(t => t >= 0.45 && t <= introWindowEnd)
        .slice(0, 80);
    if (introOnsets.length === 0) {
        const fallbackInject: NoteData[] = [];
        let lane = 1;
        for (const beat of beatPositions) {
            if (beat < 0.8 || beat > introWindowEnd) continue;
            const sec = sectionAt(beat);
            const type = sec?.type ?? 'verse';
            if (type === 'outro' || type === 'interlude') continue;
            fallbackInject.push({
                time: beat,
                lane,
                type: 'tap',
                strength: 0.48,
            });
            lane = lane === 0 ? 1 : 0;
            if (fallbackInject.length >= Math.max(2, Math.floor(injectTarget[difficulty] * 0.7))) break;
        }
        if (fallbackInject.length === 0) return sorted;
        return dedupeNotes([...sorted, ...fallbackInject], 0.045);
    }

    const snapToGrid = (time: number): number => {
        let best = time;
        let bestDist = Number.POSITIVE_INFINITY;
        for (const beat of beatPositions) {
            const d1 = Math.abs(beat - time);
            if (d1 < bestDist) {
                bestDist = d1;
                best = beat;
            }
            const half = beat + beatInterval * 0.5;
            const d2 = Math.abs(half - time);
            if (d2 < bestDist) {
                bestDist = d2;
                best = half;
            }
            if (beat > time + beatInterval) break;
        }
        return best;
    };

    const injected: NoteData[] = [];
    let lane = 1;
    for (const t of introOnsets) {
        if (injected.length >= injectTarget[difficulty]) break;
        const sec = sectionAt(t);
        const type = sec?.type ?? 'verse';
        const avg = sec?.avgEnergy ?? 0.5;
        if ((type === 'outro' || type === 'interlude') || (type === 'intro' && avg < 0.07)) continue;
        const snapped = snapToGrid(t);
        const nearExisting = sorted.some(n => Math.abs(n.time - snapped) < beatInterval * 0.22)
            || injected.some(n => Math.abs(n.time - snapped) < beatInterval * 0.22);
        if (nearExisting) continue;
        lane = lane === 0 ? 1 : 0;
        injected.push({
            time: snapped,
            lane,
            type: 'tap',
            strength: 0.5,
        });
    }

    return dedupeNotes([...sorted, ...injected], 0.045);
};

interface TempoSegment {
    readonly start: number;
    readonly end: number;
    readonly bpm: number;
    readonly confidence: number;
}

const alignOffsetToDownbeats = (
    initialOffset: number,
    bpm: number,
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[]
): number => {
    if (bpm <= 0 || onsetTimes.length < 10) return Math.max(0, initialOffset);
    const interval = 60 / bpm;
    if (!isFinite(interval) || interval <= 0) return Math.max(0, initialOffset);

    const base = ((initialOffset % interval) + interval) % interval;
    const sampled: Array<{ time: number; strength: number }> = [];
    for (let i = 0; i < onsetTimes.length; i++) {
        const t = onsetTimes[i];
        if (t < 0.1 || t > 56) continue;
        const s = onsetStrengths[i] ?? 0.5;
        if (s < 0.36) continue;
        sampled.push({ time: t, strength: s });
    }
    if (sampled.length < 8) return base;

    const phaseWindow = interval * 0.28;
    const steps = 72;
    let best = base;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= steps; i++) {
        const delta = ((i / steps) - 0.5) * phaseWindow * 2;
        const candidate = ((base + delta) % interval + interval) % interval;
        let score = 0;
        for (const onset of sampled) {
            const dBeat = circularDistanceToGrid(onset.time, candidate, interval);
            const dHalf = circularDistanceToGrid(onset.time, candidate + interval * 0.5, interval);
            const weighted = dBeat * (0.58 + onset.strength) + dHalf * 0.08;
            score += weighted;
        }
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    }

    return best;
};

const normalizeTempoAroundReference = (
    rawTempo: number,
    referenceTempo: number,
    fallbackTempo: number
): number => {
    const base = Number.isFinite(fallbackTempo) && fallbackTempo > 0 ? fallbackTempo : 120;
    const reference = Number.isFinite(referenceTempo) && referenceTempo > 0
        ? Math.max(60, Math.min(200, referenceTempo))
        : Math.max(60, Math.min(200, base));
    if (!isFinite(rawTempo) || rawTempo <= 0) return reference;

    const candidates = [
        rawTempo,
        rawTempo * 2,
        rawTempo * 0.5,
        rawTempo * 1.5,
        rawTempo * (2 / 3),
        rawTempo * (4 / 3),
        rawTempo * 0.75,
    ].filter(v => v >= 60 && v <= 200);
    if (candidates.length === 0) return reference;

    let best = candidates[0];
    let bestScore = Math.abs(Math.log(best / reference));
    for (let i = 1; i < candidates.length; i++) {
        const cand = candidates[i];
        const score = Math.abs(Math.log(cand / reference));
        if (score < bestScore) {
            bestScore = score;
            best = cand;
        }
    }

    const maxJump = Math.max(8, reference * 0.2);
    if (Math.abs(best - reference) > maxJump) {
        best = reference + Math.sign(best - reference) * maxJump;
    }
    return Math.max(60, Math.min(200, best));
};

const buildAdaptiveTempoSegments = (
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    baseBpm: number,
    duration: number
): TempoSegment[] => {
    const safeBase = Math.max(60, Math.min(200, Number.isFinite(baseBpm) && baseBpm > 0 ? baseBpm : 120));
    if (duration < 12 || onsetTimes.length < 16) {
        return [{ start: 0, end: duration, bpm: safeBase, confidence: 0.18 }];
    }

    const sortedPairs = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time) && p.time >= 0)
        .sort((a, b) => a.time - b.time);
    if (sortedPairs.length < 16) {
        return [{ start: 0, end: duration, bpm: safeBase, confidence: 0.2 }];
    }

    const strengths = sortedPairs.map(p => p.strength).sort((a, b) => a - b);
    const strongIdx = Math.max(0, Math.floor(strengths.length * 0.48));
    const strongThreshold = strengths[strongIdx] ?? 0.45;
    const windowSec = Math.min(18, Math.max(10, duration * 0.085));
    const stepSec = Math.max(4, windowSec * 0.5);

    interface TempoAnchor {
        readonly time: number;
        readonly bpm: number;
        readonly confidence: number;
    }
    const anchors: TempoAnchor[] = [];
    const times = sortedPairs.map(p => p.time);
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    let prevTempo = safeBase;
    for (let start = 0; start < duration; start += stepSec) {
        const end = Math.min(duration, start + windowSec);
        const i0 = lowerBound(times, start);
        const i1 = lowerBound(times, end);
        if (i1 - i0 < 6) continue;

        const intervals: number[] = [];
        let prevStrong = -Infinity;
        let usedStrong = 0;
        for (let i = i0; i < i1; i++) {
            const p = sortedPairs[i];
            if (p.strength < strongThreshold) continue;
            usedStrong++;
            if (isFinite(prevStrong)) {
                const dt = p.time - prevStrong;
                if (dt >= 0.18 && dt <= 1.1) intervals.push(dt);
            }
            prevStrong = p.time;
        }
        if (intervals.length < 3) continue;

        intervals.sort((a, b) => a - b);
        const mid = intervals[Math.floor(intervals.length * 0.5)];
        const p20 = intervals[Math.floor(intervals.length * 0.2)];
        const p80 = intervals[Math.floor(intervals.length * 0.8)];
        const spread = mid > 1e-5 ? (p80 - p20) / mid : 1;
        const rawBpm = 60 / Math.max(0.001, mid);
        const normalized = normalizeTempoAroundReference(rawBpm, prevTempo, safeBase);
        const continuity = clamp01(1 - Math.abs(normalized - prevTempo) / 24);
        const confidence = clamp01(
            Math.min(1, intervals.length / 14) * 0.62
            + Math.max(0, 1 - spread * 2.5) * 0.28
            + continuity * 0.1
        );
        if (confidence < 0.12) continue;
        const blended = lerp(prevTempo, normalized, 0.35 + confidence * 0.45);
        anchors.push({
            time: (start + end) * 0.5,
            bpm: Math.max(60, Math.min(200, blended)),
            confidence,
        });
        prevTempo = blended;
    }

    if (anchors.length === 0) {
        return [{ start: 0, end: duration, bpm: safeBase, confidence: 0.22 }];
    }

    const smoothed = anchors.map((anchor, i) => {
        const prev = anchors[Math.max(0, i - 1)];
        const next = anchors[Math.min(anchors.length - 1, i + 1)];
        const weighted = (prev.bpm * 0.24) + (anchor.bpm * 0.52) + (next.bpm * 0.24);
        return {
            ...anchor,
            bpm: Math.max(60, Math.min(200, weighted)),
        };
    });

    const dedupAnchors: TempoAnchor[] = [];
    for (const anchor of smoothed) {
        const last = dedupAnchors[dedupAnchors.length - 1];
        if (!last) {
            dedupAnchors.push(anchor);
            continue;
        }
        if (anchor.time - last.time < stepSec * 0.7) {
            const merged = {
                time: (last.time + anchor.time) * 0.5,
                bpm: lerp(last.bpm, anchor.bpm, 0.5),
                confidence: Math.max(last.confidence, anchor.confidence),
            };
            dedupAnchors[dedupAnchors.length - 1] = merged;
            continue;
        }
        dedupAnchors.push(anchor);
    }

    const segments: TempoSegment[] = [];
    let prevSegmentTempo = safeBase;
    for (let i = 0; i < dedupAnchors.length; i++) {
        const current = dedupAnchors[i];
        const prev = dedupAnchors[i - 1];
        const next = dedupAnchors[i + 1];
        const start = i === 0 ? 0 : (prev.time + current.time) * 0.5;
        const end = i === dedupAnchors.length - 1 ? duration : (current.time + next.time) * 0.5;
        if (end - start < 1.25) continue;
        const maxJump = Math.max(7, prevSegmentTempo * 0.16);
        const constrained = Math.abs(current.bpm - prevSegmentTempo) > maxJump
            ? prevSegmentTempo + Math.sign(current.bpm - prevSegmentTempo) * maxJump
            : current.bpm;
        const blended = lerp(safeBase, constrained, 0.3 + current.confidence * 0.62);
        const bpm = Math.max(60, Math.min(200, blended));
        segments.push({
            start,
            end,
            bpm,
            confidence: current.confidence,
        });
        prevSegmentTempo = bpm;
    }

    if (segments.length === 0) {
        return [{ start: 0, end: duration, bpm: safeBase, confidence: 0.2 }];
    }

    segments.sort((a, b) => a.start - b.start);
    const normalizedSegments: TempoSegment[] = [];
    for (const seg of segments) {
        const start = Math.max(0, Math.min(duration, seg.start));
        const end = Math.max(start + 0.5, Math.min(duration, seg.end));
        const last = normalizedSegments[normalizedSegments.length - 1];
        if (!last) {
            normalizedSegments.push({ ...seg, start, end });
            continue;
        }
        if (start <= last.end + 0.15 && Math.abs(seg.bpm - last.bpm) <= 2.2) {
            normalizedSegments[normalizedSegments.length - 1] = {
                start: last.start,
                end: Math.max(last.end, end),
                bpm: lerp(last.bpm, seg.bpm, 0.45),
                confidence: Math.max(last.confidence, seg.confidence),
            };
            continue;
        }
        if (start > last.end + 0.25) {
            normalizedSegments.push({
                start: last.end,
                end: start,
                bpm: last.bpm,
                confidence: Math.min(last.confidence, 0.22),
            });
        }
        normalizedSegments.push({ ...seg, start, end });
    }

    const first = normalizedSegments[0];
    if (first.start > 0) {
        normalizedSegments.unshift({
            start: 0,
            end: first.start,
            bpm: first.bpm,
            confidence: first.confidence,
        });
    }
    const last = normalizedSegments[normalizedSegments.length - 1];
    if (last.end < duration) {
        normalizedSegments.push({
            start: last.end,
            end: duration,
            bpm: last.bpm,
            confidence: last.confidence,
        });
    }

    return normalizedSegments;
};

const generateAdaptiveBeatPositions = (
    segments: readonly TempoSegment[],
    duration: number,
    offset: number
): number[] => {
    if (segments.length === 0 || duration <= 0) return [];
    const ordered = [...segments].sort((a, b) => a.start - b.start);
    const beats: number[] = [];
    let t = Number.isFinite(offset) ? Math.max(0, offset) : 0;
    let segPtr = 0;
    let guard = 0;
    const maxPoints = Math.max(1200, Math.ceil(duration * 8.5));
    while (t < duration && guard < maxPoints) {
        while (segPtr + 1 < ordered.length && t >= ordered[segPtr].end - 1e-6) segPtr++;
        const seg = ordered[segPtr] ?? ordered[ordered.length - 1];
        const localBpm = Math.max(60, Math.min(200, seg.bpm));
        const interval = Math.max(0.05, 60 / localBpm);
        beats.push(t);
        t += interval;
        guard++;
    }
    return beats;
};

const buildHalfBeatGrid = (
    beats: readonly number[],
    fallbackBpm: number,
    duration: number
): number[] => {
    if (beats.length === 0) {
        return generateBeatPositions(
            Math.max(60, Math.min(200, fallbackBpm || 120)),
            duration,
            0,
            2
        ) as number[];
    }
    const sorted = [...beats].sort((a, b) => a - b);
    const grid: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
        const b = sorted[i];
        const next = sorted[i + 1];
        const interval = next !== undefined
            ? Math.max(0.05, next - b)
            : Math.max(0.05, 60 / Math.max(1, fallbackBpm));
        grid.push(b);
        grid.push(b + interval * 0.5);
    }
    grid.sort((a, b) => a - b);
    const out: number[] = [];
    let last = -Infinity;
    for (const t of grid) {
        if (t < 0 || t > duration + 0.01) continue;
        if (t - last < 0.015) continue;
        out.push(t);
        last = t;
    }
    return out;
};

const selectBestTempoGrid = (
    bpm: number,
    offset: number,
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[]
): { bpm: number; offset: number } => {
    if (!Number.isFinite(bpm) || bpm <= 0 || onsetTimes.length < 16) {
        return { bpm: Math.max(60, Math.min(200, bpm || 120)), offset: Math.max(0, offset) };
    }
    const base = Math.max(60, Math.min(200, bpm));
    const candidates = new Set<number>();
    const ratios = [0.5, 2/3, 0.75, 1, 1.25, 4/3, 1.5, 2];
    const deltas = [-0.06, -0.04, -0.02, -0.01, 0, 0.01, 0.02, 0.04, 0.06];
    for (const r of ratios) {
        const raw = base * r;
        if (raw < 60 || raw > 200) continue;
        for (const d of deltas) {
            const cand = raw * (1 + d);
            if (cand >= 60 && cand <= 200) {
                candidates.add(Math.round(cand * 100) / 100);
            }
        }
    }

    const sampledIdx: number[] = [];
    const step = Math.max(1, Math.floor(onsetTimes.length / 1200));
    for (let i = 0; i < onsetTimes.length; i += step) sampledIdx.push(i);

    let best = { bpm: base, offset: Math.max(0, offset) };
    let bestScore = Number.POSITIVE_INFINITY;
    for (const candBpm of candidates) {
        const candOffset = refineBeatOffset(offset, candBpm, onsetTimes, onsetStrengths);
        const interval = 60 / candBpm;
        let score = 0;
        let used = 0;
        for (const idx of sampledIdx) {
            const t = onsetTimes[idx];
            if (t < 0.2) continue;
            const s = onsetStrengths[idx] ?? 0.5;
            if (s < 0.15) continue;
            const dBeat = circularDistanceToGrid(t, candOffset, interval);
            const dHalf = circularDistanceToGrid(t, candOffset + interval * 0.5, interval);
            const dQuarter = circularDistanceToGrid(t, candOffset + interval * 0.25, interval);
            const dThird = circularDistanceToGrid(t, candOffset + interval / 3, interval);
            const d = Math.min(dBeat, dHalf * 1.06, dQuarter * 1.18, dThird * 1.14);
            score += d * (0.4 + s);
            used++;
        }
        if (used < 6) continue;
        const normalized = score / used + Math.abs(candBpm - base) * 0.0007;
        if (normalized < bestScore) {
            bestScore = normalized;
            best = { bpm: candBpm, offset: candOffset };
        }
    }
    return best;
};

const applyDetailedMusicalPointMapping = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    beatPositions: readonly number[],
    spectralProfiles: readonly SpectralProfile[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    lowOnsets: readonly number[],
    lowStrengths: readonly number[],
    midOnsets: readonly number[],
    midStrengths: readonly number[],
    highOnsets: readonly number[],
    highStrengths: readonly number[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (bpm <= 0) return [...notes];
    const beatInterval = 60 / Math.max(1, bpm);
    const sortedSections = [...sections].sort((a, b) => a.startTime - b.startTime);
    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const percentile = (values: readonly number[], q: number, fallback: number): number => {
        if (values.length === 0) return fallback;
        const sortedVals = [...values].sort((a, b) => a - b);
        const qq = Math.max(0, Math.min(1, q));
        const pos = (sortedVals.length - 1) * qq;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sortedVals[lo];
        return lerp(sortedVals[lo], sortedVals[hi], pos - lo);
    };
    const toPairs = (
        times: readonly number[],
        strengths: readonly number[],
        fallback: number
    ): Array<{ time: number; strength: number }> =>
        times
            .map((time, i) => ({ time, strength: clamp01(strengths[i] ?? fallback) }))
            .filter(p => Number.isFinite(p.time))
            .sort((a, b) => a.time - b.time);

    const onsetPairs = toPairs(onsetTimes, onsetStrengths, 0.5);
    const lowPairs = toPairs(lowOnsets, lowStrengths, percentile(onsetStrengths, 0.66, 0.58));
    const midPairs = toPairs(
        midOnsets.length > 0 ? midOnsets : onsetTimes,
        midOnsets.length > 0 ? midStrengths : onsetStrengths,
        percentile(onsetStrengths, 0.58, 0.52)
    );
    const highPairs = toPairs(highOnsets, highStrengths, percentile(onsetStrengths, 0.62, 0.56));
    const lowTimes = lowPairs.map(p => p.time);
    const midTimes = midPairs.map(p => p.time);
    const highTimes = highPairs.map(p => p.time);
    const onsetTimesOnly = onsetPairs.map(p => p.time);

    const lowThresh = Math.max(0.54, percentile(lowPairs.map(p => p.strength), 0.66, 0.58));
    const midThresh = Math.max(0.48, percentile(midPairs.map(p => p.strength), 0.58, 0.52));
    const highThresh = Math.max(0.56, percentile(highPairs.map(p => p.strength), 0.66, 0.58));
    const strongGlobal = Math.max(0.66, percentile(onsetPairs.map(p => p.strength), 0.78, 0.7));

    const duration = Math.max(
        beatPositions[beatPositions.length - 1] ?? 0,
        sortedSections[sortedSections.length - 1]?.endTime ?? 0,
        onsetTimesOnly[onsetTimesOnly.length - 1] ?? 0,
        notes[notes.length - 1]?.time ?? 0
    );
    const introCutoff = resolveIntroCutoff(
        sortedSections,
        onsetTimes,
        onsetStrengths,
        bpm,
        difficulty,
        Math.max(5, duration),
        songFeatures
    );
    const firstHighlightStart = sortedSections.find(s =>
        s.type === 'drop' || s.type === 'chorus' || (s.avgEnergy || 0.5) >= 0.72
    )?.startTime ?? Number.POSITIVE_INFINITY;

    const grid: number[] = [];
    if (beatPositions.length > 0) {
        for (const beat of beatPositions) {
            grid.push(beat, beat + beatInterval * 0.5);
            if (difficulty === 'hard' || difficulty === 'expert') {
                grid.push(beat + beatInterval * 0.25, beat + beatInterval * 0.75);
            }
        }
    } else {
        for (let t = 0; t <= duration + beatInterval; t += beatInterval * 0.5) {
            grid.push(t);
        }
    }
    grid.sort((a, b) => a - b);
    const snapToGrid = (time: number, sectionType: string): number => {
        const idx = lowerBound(grid, time);
        let best = grid[Math.max(0, Math.min(grid.length - 1, idx))] ?? time;
        let bestDist = Math.abs(best - time);
        for (let i = Math.max(0, idx - 3); i <= Math.min(grid.length - 1, idx + 3); i++) {
            const d = Math.abs(grid[i] - time);
            if (d < bestDist) {
                bestDist = d;
                best = grid[i];
            }
        }
        // verse/bridge는 셋잇단 스냅도 일부 허용해 기계적 8비트 반복 감소
        if (sectionType === 'verse' || sectionType === 'bridge') {
            const tripletStep = beatInterval / 3;
            const tri = Math.round(time / tripletStep) * tripletStep;
            const triDist = Math.abs(tri - time);
            if (triDist < bestDist * 0.92) {
                best = tri;
            }
        }
        return Math.max(0.02, best);
    };

    interface Candidate {
        readonly time: number;
        readonly lane: number;
        readonly type: 'tap' | 'slide';
        readonly targetLane?: number;
        readonly duration?: number;
        readonly strength: number;
        readonly score: number;
        readonly band: 'low' | 'mid' | 'high';
    }

    const minLaneGapByDiff: Record<Difficulty, number> = {
        easy: beatInterval * 0.27,
        normal: beatInterval * 0.22,
        hard: beatInterval * 0.18,
        expert: beatInterval * 0.14,
    };
    const minLaneGap = Math.max(0.055, minLaneGapByDiff[difficulty]);
    const laneOcc: [number[], number[]] = [[], []];
    const longIntervals: Array<{ start: number; end: number; lanes: number[] }> = [];
    const built: NoteData[] = [];

    const hasLaneNear = (time: number, lane: number): boolean => {
        const arr = laneOcc[lane === 0 ? 0 : 1];
        if (arr.length === 0) return false;
        const idx = lowerBound(arr, time);
        if (idx < arr.length && Math.abs(arr[idx] - time) < minLaneGap) return true;
        if (idx > 0 && Math.abs(arr[idx - 1] - time) < minLaneGap) return true;
        return false;
    };
    const hasLongConflict = (time: number, lane: number): boolean =>
        longIntervals.some(l =>
            l.lanes.includes(lane === 0 ? 0 : 1)
            && time >= l.start - beatInterval * 0.14
            && time <= l.end + beatInterval * 0.14
        );
    const markNote = (note: NoteData): void => {
        const safeLane = note.lane === 0 ? 0 : 1;
        laneOcc[safeLane].push(note.time);
        laneOcc[safeLane].sort((a, b) => a - b);
        if (note.type === 'slide' || note.type === 'hold') {
            const end = note.time + normalizeLongDuration(note.type, note.duration, beatInterval);
            const lanes = getOccupiedControlLanes(note);
            longIntervals.push({ start: note.time, end, lanes });
        }
        built.push(note);
    };

    const npsBase: Record<Difficulty, { verse: number; chorus: number; drop: number; bridge: number }> = {
        easy: { verse: 1.2, chorus: 1.7, drop: 1.95, bridge: 0.85 },
        normal: { verse: 2.6, chorus: 3.8, drop: 4.5, bridge: 1.8 },
        hard: { verse: 3.8, chorus: 5.6, drop: 6.6, bridge: 2.5 },
        expert: { verse: 5.2, chorus: 7.6, drop: 9.2, bridge: 3.6 },
    };

    let midLaneMemory = 1;
    const sectionWeights = (type: string): { low: number; mid: number; high: number } => {
        if (type === 'drop') return { low: 0.86, mid: 0.46, high: 0.72 };
        if (type === 'chorus') return { low: 0.72, mid: 0.56, high: 0.62 };
        if (type === 'bridge') return { low: 0.24, mid: 0.86, high: 0.2 };
        return { low: 0.36, mid: 0.82, high: 0.28 };
    };

    const gatherCandidates = (
        pairs: readonly { time: number; strength: number }[],
        times: readonly number[],
        start: number,
        end: number,
        band: 'low' | 'mid' | 'high',
        secType: string,
        highlight: boolean,
        weight: number
    ): Candidate[] => {
        const i0 = lowerBound(times, start);
        const i1 = lowerBound(times, end);
        if (i1 <= i0) return [];
        const out: Candidate[] = [];
        const thresh = band === 'low'
            ? (highlight ? lowThresh * 0.92 : lowThresh)
            : band === 'mid'
                ? (highlight ? midThresh * 0.98 : midThresh)
                : (highlight ? highThresh * 0.92 : highThresh);

        for (let i = i0; i < i1; i++) {
            const p = pairs[i];
            if (p.strength < thresh) continue;
            const snapped = snapToGrid(p.time, secType);
            const profile = getSpectralProfileAt(spectralProfiles, snapped);
            const tonal = profile?.tonal ?? songFeatures.sustainedFocus;
            const transient = profile?.transient ?? (1 - songFeatures.sustainedFocus);
            const percussive = profile?.percussive ?? songFeatures.percussiveFocus;
            const brightness = profile?.brightness ?? 0.5;

            let lane = band === 'low' ? 1 : band === 'high' ? 0 : (brightness >= 0.5 ? 0 : 1);
            let type: 'tap' | 'slide' = 'tap';
            let targetLane = lane;
            let duration: number | undefined = undefined;
            if (band === 'mid') {
                const sustainedLike = tonal >= 0.58 && transient <= 0.5 && percussive <= 0.58;
                if (sustainedLike && i + 1 < i1) {
                    const nextTime = pairs[i + 1]?.time ?? p.time;
                    const gap = nextTime - p.time;
                    if (gap >= beatInterval * 0.72 && gap <= beatInterval * 3.4) {
                        type = 'slide';
                        duration = Math.min(beatInterval * 3.9, Math.max(MIN_SLIDE_DURATION_SEC, gap * 0.9));
                        // sustained phrase는 기본 직선, 하이라이트에서만 가끔 대각 이동
                        const diagonal = highlight && tonal < 0.7 && transient >= 0.34 && transient <= 0.58;
                        targetLane = diagonal ? (lane === 0 ? 1 : 0) : lane;
                    }
                }
                // 멜로디 연속은 lane memory를 이용해 반복 루프를 줄인다.
                if (type === 'tap' && lane === midLaneMemory) {
                    lane = midLaneMemory === 0 ? 1 : 0;
                }
                midLaneMemory = lane;
            }

            const score = p.strength * 0.6
                + weight * 0.24
                + (highlight ? 0.08 : 0)
                + (band === 'mid' ? songFeatures.melodicFocus * 0.08 : 0)
                + (band === 'low' ? songFeatures.bassWeight * 0.08 : 0)
                + (band === 'high' ? songFeatures.percussiveFocus * 0.08 : 0);
            out.push({
                time: snapped,
                lane,
                type,
                targetLane: type === 'slide' ? targetLane : undefined,
                duration,
                strength: Math.max(0.4, Math.min(1, score * 0.9)),
                score,
                band,
            });
        }
        return out;
    };

    for (const sec of sortedSections) {
        if (sec.type === 'intro' || sec.type === 'outro' || sec.type === 'interlude') continue;
        const secStart = Math.max(introCutoff - 0.01, sec.startTime);
        const secEnd = sec.endTime;
        const secDur = Math.max(0.001, secEnd - secStart);
        if (secDur < beatInterval * 1.8) continue;

        const highlight = sec.type === 'drop' || sec.type === 'chorus' || (sec.avgEnergy || 0.5) >= 0.72;
        const preHighlightCalm = secStart < firstHighlightStart - beatInterval * 0.24
            && !highlight
            && (songFeatures.calmConfidence >= 0.56 || (sec.avgEnergy || 0.5) <= 0.58);
        const weights = sectionWeights(sec.type);
        const energyBoost = clamp01(((sec.avgEnergy || 0.5) - 0.5) / 0.35) * 0.24;
        const base = sec.type === 'drop'
            ? npsBase[difficulty].drop
            : sec.type === 'chorus'
                ? npsBase[difficulty].chorus
                : sec.type === 'bridge'
                    ? npsBase[difficulty].bridge
                    : npsBase[difficulty].verse;
        let targetNps = base * (1 + energyBoost);
        if (preHighlightCalm) {
            targetNps *= difficulty === 'easy' ? 0.9 : difficulty === 'normal' ? 0.88 : difficulty === 'hard' ? 0.84 : 0.8;
        }
        const targetCount = Math.max(1, Math.floor(secDur * targetNps));

        const cands = [
            ...gatherCandidates(lowPairs, lowTimes, secStart, secEnd, 'low', sec.type, highlight, weights.low),
            ...gatherCandidates(midPairs, midTimes, secStart, secEnd, 'mid', sec.type, highlight, weights.mid),
            ...gatherCandidates(highPairs, highTimes, secStart, secEnd, 'high', sec.type, highlight, weights.high),
        ];
        if (cands.length === 0) continue;

        // 동일 시점/레인 후보는 최고 점수만 유지.
        const bucketStep = Math.max(0.022, beatInterval * 0.12);
        const uniq = new Map<string, Candidate>();
        for (const c of cands) {
            if (c.time < introCutoff - 0.01) continue;
            const key = `${c.lane}:${Math.round(c.time / bucketStep)}`;
            const prev = uniq.get(key);
            if (!prev || c.score > prev.score) uniq.set(key, c);
        }
        const ranked = [...uniq.values()].sort((a, b) => b.score - a.score || a.time - b.time);

        let accepted = 0;
        for (const cand of ranked) {
            if (accepted >= targetCount) break;
            if (hasLaneNear(cand.time, cand.lane)) continue;
            if (hasLongConflict(cand.time, cand.lane)) continue;
            if (cand.type === 'slide' && hasLongConflict(cand.time, cand.targetLane ?? cand.lane)) continue;

            const note: NoteData = cand.type === 'slide'
                ? {
                    time: cand.time,
                    lane: cand.lane,
                    type: 'slide',
                    targetLane: cand.targetLane ?? cand.lane,
                    duration: Math.min(
                        beatInterval * 4,
                        Math.max(MIN_SLIDE_DURATION_SEC, cand.duration ?? beatInterval)
                    ),
                    strength: cand.strength,
                }
                : {
                    time: cand.time,
                    lane: cand.lane,
                    type: 'tap',
                    strength: cand.strength,
                };
            markNote(note);
            accepted++;
        }

        // 섹션이 너무 비면 강한 온셋 앵커를 최소 보강.
        if (accepted < Math.max(1, Math.floor(targetCount * 0.58))) {
            const i0 = lowerBound(onsetTimesOnly, secStart);
            const i1 = lowerBound(onsetTimesOnly, secEnd);
            let lane = built[built.length - 1]?.lane ?? 1;
            for (let i = i0; i < i1 && accepted < Math.max(1, Math.floor(targetCount * 0.82)); i++) {
                const o = onsetPairs[i];
                if (!o || o.strength < strongGlobal) continue;
                const t = snapToGrid(o.time, sec.type);
                lane = lane === 0 ? 1 : 0;
                if (hasLaneNear(t, lane) || hasLongConflict(t, lane)) continue;
                markNote({
                    time: t,
                    lane,
                    type: 'tap',
                    strength: Math.max(0.56, o.strength * 0.9),
                });
                accepted++;
            }
        }
    }

    let rebuilt = dedupeNotes(built, 0.034);
    if (rebuilt.length === 0) {
        rebuilt = dedupeNotes([...notes], 0.034);
    } else if (rebuilt.length < Math.max(6, Math.floor(notes.length * 0.45))) {
        // 과소생성시 기존 seed 일부를 보강해 빈 맵 방지
        rebuilt = dedupeNotes([...rebuilt, ...notes], 0.034);
    }

    rebuilt = pruneIntroNotes(rebuilt, introCutoff, sortedSections);
    rebuilt = enforceIntroBalance(rebuilt, introCutoff, sortedSections, bpm, difficulty, songFeatures);
    rebuilt = ensureMinimumDensity(rebuilt, beatPositions, sortedSections, bpm, difficulty, songFeatures);
    rebuilt = ensureSlidePresence(rebuilt, sortedSections, difficulty, bpm, Math.max(5, duration));
    rebuilt = sculptSlideVocabulary(rebuilt, sortedSections, bpm, difficulty);
    rebuilt = injectSlideCounterRhythms(rebuilt, sortedSections, bpm);
    rebuilt = enrichSlideContexts(rebuilt, bpm);
    rebuilt = injectExpressiveCombos(rebuilt, sortedSections, bpm, difficulty);
    rebuilt = enforceBurstNonOverlap(rebuilt, bpm);
    rebuilt = repairSparseAndOffRhythmWindows(
        rebuilt,
        onsetTimes,
        onsetStrengths,
        beatPositions,
        sortedSections,
        bpm,
        difficulty,
        songFeatures
    );
    rebuilt = reducePresetLikeLaneLoops(rebuilt, sortedSections, bpm, songFeatures);
    rebuilt = tightenRhythmIntent(rebuilt, onsetTimes, beatPositions, bpm, difficulty);
    rebuilt = refineGlobalSync(rebuilt, onsetTimes);
    rebuilt = refineLocalSyncDrift(rebuilt, onsetTimes, bpm);
    rebuilt = pruneImpossibleNestedNotes(rebuilt, bpm);
    const denseRebuilt = ensureMinimumDensity(rebuilt, beatPositions, sortedSections, bpm, difficulty, songFeatures);
    if (denseRebuilt.length >= rebuilt.length + Math.max(2, Math.floor(rebuilt.length * 0.035))) {
        rebuilt = denseRebuilt;
    }

    return dedupeNotes(resolveLongNoteCollisions(rebuilt, bpm), 0.035);
};

const tightenRhythmIntent = (
    notes: readonly NoteData[],
    onsets: readonly number[],
    beatPositions: readonly number[],
    bpm: number,
    difficulty: Difficulty
): NoteData[] => {
    if (notes.length === 0 || beatPositions.length === 0 || onsets.length === 0) return [...notes];
    const sortedNotes = [...notes].sort((a, b) => a.time - b.time);
    const sortedOnsets = [...onsets].sort((a, b) => a - b);
    const beatInterval = 60 / bpm;
    const onsetSnapThreshold = difficulty === 'easy'
        ? beatInterval * 0.16
        : difficulty === 'normal'
            ? beatInterval * 0.14
            : beatInterval * 0.12;
    const offRhythmDropThreshold = difficulty === 'easy'
        ? beatInterval * 0.32
        : difficulty === 'normal'
            ? beatInterval * 0.28
            : beatInterval * 0.24;

    let onsetPtr = 0;
    let beatPtr = 0;
    const nearestOnset = (time: number): number => {
        while (onsetPtr + 1 < sortedOnsets.length && sortedOnsets[onsetPtr + 1] <= time) onsetPtr++;
        const a = sortedOnsets[onsetPtr];
        const b = sortedOnsets[Math.min(sortedOnsets.length - 1, onsetPtr + 1)];
        return Math.abs(a - time) <= Math.abs(b - time) ? a : b;
    };
    const nearestBeat = (time: number): number => {
        while (beatPtr + 1 < beatPositions.length && beatPositions[beatPtr + 1] <= time) beatPtr++;
        const a = beatPositions[beatPtr];
        const b = beatPositions[Math.min(beatPositions.length - 1, beatPtr + 1)];
        const ah = a + beatInterval * 0.5;
        const bh = b + beatInterval * 0.5;
        const candidates = [a, b, ah, bh];
        let best = candidates[0];
        let bestDist = Math.abs(best - time);
        for (let i = 1; i < candidates.length; i++) {
            const d = Math.abs(candidates[i] - time);
            if (d < bestDist) {
                bestDist = d;
                best = candidates[i];
            }
        }
        return best;
    };

    const out: NoteData[] = [];
    for (const note of sortedNotes) {
        const o = nearestOnset(note.time);
        const b = nearestBeat(note.time);
        const doOnset = Math.abs(o - note.time);
        const doBeat = Math.abs(b - note.time);
        const str = note.strength ?? 0.5;

        if (doOnset > offRhythmDropThreshold && doBeat > offRhythmDropThreshold && str < 0.72) {
            continue;
        }
        if (doOnset <= onsetSnapThreshold) {
            out.push({ ...note, time: o });
        } else if (doBeat <= beatInterval * 0.18) {
            out.push({ ...note, time: b });
        } else {
            out.push(note);
        }
    }
    return dedupeNotes(out, 0.04);
};

const resolveLongNoteCollisions = (
    notes: readonly NoteData[],
    bpm: number
): NoteData[] => {
    const beatInterval = 60 / bpm;
    const laneBusyUntil = [-Infinity, -Infinity];
    const sorted = [...notes].sort((a, b) => a.time - b.time);
    const out: NoteData[] = [];

    for (const original of sorted) {
        const isLong = (original.type === 'slide' || original.type === 'hold') && !!original.duration && original.duration > 0;
        if (!isLong) {
            // 탭이 롱노트 진행 중인 레인에 떨어지면 스킵 (겹침 방지)
            // 양 레인 모두 확인 (슬라이드는 두 레인을 동시 점유)
            const busyOnLane = original.time < laneBusyUntil[original.lane] - 0.03;
            const busyOnOther = original.time < laneBusyUntil[original.lane === 0 ? 1 : 0] - 0.03;
            // 양쪽 레인이 모두 busy면 슬라이드 중이므로 스킵
            if (busyOnLane) continue;
            if (busyOnOther && laneBusyUntil[0] > original.time && laneBusyUntil[1] > original.time) continue;
            out.push({ ...original });
            laneBusyUntil[original.lane] = Math.max(laneBusyUntil[original.lane], original.time + 0.05);
            continue;
        }

        const targetLane = original.type === 'slide'
            ? resolveSlideTargetLane(original)
            : original.lane;
        const lanes = original.type === 'slide'
            ? getOccupiedControlLanes(original)
            : [original.lane];
        const firstFree = lanes.reduce((mx, lane) => Math.max(mx, laneBusyUntil[lane]), -Infinity);
        const minLongDur = normalizeLongDuration(original.type, undefined, beatInterval);
        const maxLongDur = original.type === 'slide'
            ? Math.max(minLongDur + 0.45, beatInterval * 7.6)
            : Math.max(minLongDur + 0.35, beatInterval * 6.8);

        let start = original.time;
        let duration = Math.min(
            maxLongDur,
            Math.max(minLongDur, normalizeLongDuration(original.type, original.duration, beatInterval))
        );
        if (start < firstFree - 0.02) {
            const shiftedStart = firstFree + 0.02;
            const remain = start + duration - shiftedStart;
            if (remain < minLongDur) {
                continue;
            }
            start = shiftedStart;
            duration = Math.min(maxLongDur, remain);
        }

        const end = start + duration;
        for (const lane of lanes) {
            laneBusyUntil[lane] = Math.max(laneBusyUntil[lane], end + 0.02);
        }

        out.push({
            ...original,
            time: start,
            duration,
            targetLane: original.type === 'slide'
                ? targetLane
                : undefined,
        });
    }

    return dedupeNotes(out, 0.04);
};

const injectMusicAnchoredAccents = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty
): NoteData[] => {
    if (notes.length === 0 || onsetTimes.length === 0 || beatPositions.length === 0) return [...notes];
    if (difficulty === 'easy') return [...notes];

    const out = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const sectionAt = createSectionLookup(sections);
    const beatInterval = 60 / bpm;
    const half = beatInterval * 0.5;
    const quarter = beatInterval * 0.25;
    const maxRatio = difficulty === 'normal' ? 0.08 : difficulty === 'hard' ? 0.18 : 0.24;
    const maxAdd = Math.max(4, Math.floor(out.length * maxRatio));
    const minGap = difficulty === 'normal' ? 0.11 : difficulty === 'hard' ? 0.085 : 0.065;
    const threshold = difficulty === 'normal' ? 0.76 : difficulty === 'hard' ? 0.66 : 0.57;

    const sortedOnsets = onsetTimes.map((t, i) => ({ time: t, strength: onsetStrengths[i] ?? 0.5 }))
        .sort((a, b) => a.time - b.time);
    const grid: number[] = [];
    for (const b of beatPositions) {
        grid.push(b, b + half);
        if (difficulty === 'hard' || difficulty === 'expert') {
            grid.push(b + quarter, b + quarter * 3);
        }
    }
    grid.sort((a, b) => a - b);

    const nearestGrid = (t: number): number => {
        let lo = 0;
        let hi = grid.length - 1;
        let best = grid[0] ?? t;
        let bestD = Math.abs(best - t);
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const v = grid[mid];
            const d = Math.abs(v - t);
            if (d < bestD) {
                bestD = d;
                best = v;
            }
            if (v < t) lo = mid + 1;
            else hi = mid - 1;
        }
        return best;
    };

    const isNear = (time: number, lane: number, win: number): boolean =>
        out.some(n => Math.abs(n.time - time) < win && n.lane === lane);

    let added = 0;
    let lastLane = out.length > 0 ? out[out.length - 1].lane : 1;
    for (const onset of sortedOnsets) {
        if (added >= maxAdd) break;
        if (onset.strength < threshold) continue;
        const section = sectionAt(onset.time);
        const secType = section?.type ?? 'verse';
        if (secType === 'intro' || secType === 'outro' || secType === 'interlude') continue;

        const snapped = nearestGrid(onset.time);
        const snapDist = Math.abs(snapped - onset.time);
        const snapLimit = difficulty === 'normal' ? half * 0.36 : half * 0.45;
        if (snapDist > snapLimit) continue;

        const lane = lastLane === 0 ? 1 : 0;
        if (isNear(snapped, lane, minGap)) continue;
        if (out.some(n => Math.abs(n.time - snapped) < minGap * 0.85 && n.type !== 'tap')) continue;

        out.push({
            time: snapped,
            lane,
            type: 'tap',
            strength: Math.max(0.4, Math.min(1, onset.strength * 0.85)),
        });
        lastLane = lane;
        added++;
    }

    return dedupeNotes(out, 0.04);
};

const spectralNearestCache = new WeakMap<readonly SpectralProfile[], Map<number, SpectralProfile | null>>();

const getSpectralProfileAt = (
    profiles: readonly SpectralProfile[],
    time: number
): SpectralProfile | null => {
    if (profiles.length === 0) return null;
    const quantKey = Math.round(time * 40);
    let cache = spectralNearestCache.get(profiles);
    if (!cache) {
        cache = new Map<number, SpectralProfile | null>();
        spectralNearestCache.set(profiles, cache);
    } else if (cache.has(quantKey)) {
        return cache.get(quantKey) ?? null;
    }
    const queryTime = quantKey / 40;
    let lo = 0;
    let hi = profiles.length - 1;
    let best: SpectralProfile | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const p = profiles[mid];
        const d = Math.abs(p.time - queryTime);
        if (d < bestDist) {
            bestDist = d;
            best = p;
        }
        if (p.time < queryTime) lo = mid + 1;
        else hi = mid - 1;
    }
    const resolved = bestDist <= 2.6 ? best : null;
    if (cache.size > 12000) cache.clear();
    cache.set(quantKey, resolved);
    return resolved;
};

const shapeDynamicFlowBySongProfile = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    beatPositions: readonly number[],
    spectralProfiles: readonly SpectralProfile[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length === 0) return [];
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    if (sections.length === 0) return sorted;

    const beatInterval = 60 / Math.max(1, bpm);
    const calmFactor = clamp01((songFeatures.calmConfidence - 0.42) / 0.58);
    const sustainedFactor = clamp01((songFeatures.sustainedFocus - 0.4) / 0.6);
    const energies = sections.map(s => s.avgEnergy || 0.5);
    const eMean = avg(energies, 0.5);
    const eStd = Math.sqrt(variance(energies, 0.02));
    const eMax = sections.reduce((m, s) => Math.max(m, s.avgEnergy || 0), 0);
    const highlightThreshold = Math.max(0.52, Math.min(0.86, eMean + eStd * 0.45));

    const orderedSections = [...sections].sort((a, b) => a.startTime - b.startTime);
    const percentile = (values: readonly number[], q: number, fallback: number): number => {
        if (values.length === 0) return fallback;
        const sortedVals = [...values].sort((a, b) => a - b);
        const qq = Math.max(0, Math.min(1, q));
        const pos = (sortedVals.length - 1) * qq;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        if (lo === hi) return sortedVals[lo];
        const t = pos - lo;
        return lerp(sortedVals[lo], sortedVals[hi], t);
    };
    const normalizeBySpread = (value: number, values: readonly number[], fallback: number): number => {
        const p20 = percentile(values, 0.2, fallback * 0.75);
        const p85 = percentile(values, 0.85, fallback * 1.25);
        if (p85 - p20 <= 1e-5) return clamp01((value - p20) / Math.max(1e-5, Math.abs(p20) + 1e-5));
        return clamp01((value - p20) / (p85 - p20));
    };

    const onsetPairs = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
    const strongThreshold = percentile(onsetPairs.map(p => p.strength), 0.72, 0.66);

    interface SectionRhythmProfile {
        readonly index: number;
        readonly density: number;
        readonly strongDensity: number;
        readonly transient: number;
        readonly tonal: number;
        readonly energy: number;
        readonly activity: number;
        readonly highlight: boolean;
    }

    let onsetPtr = 0;
    const spectralSorted = [...spectralProfiles].sort((a, b) => a.time - b.time);
    let spectralPtr = 0;
    const rawProfiles: Array<Omit<SectionRhythmProfile, 'activity' | 'highlight'>> = [];
    const densityVals: number[] = [];
    const strongDensityVals: number[] = [];
    const transVals: number[] = [];
    const tonalVals: number[] = [];
    const energyVals: number[] = [];
    for (let i = 0; i < orderedSections.length; i++) {
        const sec = orderedSections[i];
        const dur = Math.max(0.001, sec.endTime - sec.startTime);
        while (onsetPtr < onsetPairs.length && onsetPairs[onsetPtr].time < sec.startTime) onsetPtr++;
        let j = onsetPtr;
        let count = 0;
        let strongCount = 0;
        while (j < onsetPairs.length && onsetPairs[j].time < sec.endTime) {
            count++;
            if (onsetPairs[j].strength >= strongThreshold) strongCount++;
            j++;
        }

        while (spectralPtr < spectralSorted.length && spectralSorted[spectralPtr].time < sec.startTime) spectralPtr++;
        let k = spectralPtr;
        let transSum = 0;
        let tonalSum = 0;
        let spectralCount = 0;
        while (k < spectralSorted.length && spectralSorted[k].time < sec.endTime) {
            transSum += spectralSorted[k].transient;
            tonalSum += spectralSorted[k].tonal;
            spectralCount++;
            k++;
        }
        const trans = spectralCount > 0 ? transSum / spectralCount : 0.35;
        const tonal = spectralCount > 0 ? tonalSum / spectralCount : 0.5;
        const density = count / dur;
        const strongDensity = strongCount / dur;
        const energy = sec.avgEnergy || 0.5;
        rawProfiles.push({ index: i, density, strongDensity, transient: trans, tonal, energy });
        densityVals.push(density);
        strongDensityVals.push(strongDensity);
        transVals.push(trans);
        tonalVals.push(tonal);
        energyVals.push(energy);
    }

    const sectionProfiles: SectionRhythmProfile[] = rawProfiles.map(p => {
        const densityNorm = normalizeBySpread(p.density, densityVals, 1.2);
        const strongNorm = normalizeBySpread(p.strongDensity, strongDensityVals, 0.7);
        const transNorm = normalizeBySpread(p.transient, transVals, 0.35);
        const tonalNorm = normalizeBySpread(p.tonal, tonalVals, 0.5);
        const energyNorm = normalizeBySpread(p.energy, energyVals, 0.5);
        let activity = clamp01(
            densityNorm * 0.33
            + strongNorm * 0.3
            + transNorm * 0.2
            + energyNorm * 0.12
            + (1 - tonalNorm) * 0.05
        );
        const secType = orderedSections[p.index]?.type ?? 'verse';
        if (secType === 'drop') activity = clamp01(activity + 0.22);
        else if (secType === 'chorus') activity = clamp01(activity + 0.13);
        else if (secType === 'intro' || secType === 'interlude' || secType === 'outro') {
            activity = clamp01(activity * 0.58);
        }
        if (songFeatures.calmConfidence >= 0.56 && secType !== 'drop' && secType !== 'chorus') {
            activity = clamp01(activity * 0.84);
        }
        const highlight = activity >= 0.62
            || secType === 'drop'
            || secType === 'chorus'
            || p.energy >= Math.max(0.62, eMax * 0.82);
        return { ...p, activity, highlight };
    });

    let sectionPtr = 0;
    const getSection = (time: number): { index: number; section: typeof orderedSections[number] } => {
        while (sectionPtr + 1 < orderedSections.length && time >= orderedSections[sectionPtr].endTime) sectionPtr++;
        while (sectionPtr > 0 && time < orderedSections[sectionPtr].startTime) sectionPtr--;
        const section = orderedSections[sectionPtr] ?? orderedSections[orderedSections.length - 1];
        return { index: sectionPtr, section };
    };
    const isHighlightSection = (
        section: { type: string; avgEnergy: number },
        index: number
    ): boolean => {
        const profile = sectionProfiles[index];
        if (profile) return profile.highlight;
        return section.type === 'drop'
            || section.type === 'chorus'
            || (section.avgEnergy || 0.5) >= highlightThreshold;
    };
    const introEnd = resolveLeadingIntroEnd(orderedSections);
    const introProtectUntil = introEnd > 0
        ? introEnd
        : Math.min(10, Math.max(4, (orderedSections[orderedSections.length - 1]?.endTime ?? 0) * 0.16));
    const boundedIntroProtectUntil = Math.min(
        introProtectUntil,
        Math.max(2.6, Math.min(5.8, (orderedSections[orderedSections.length - 1]?.endTime ?? 0) * 0.17))
    );
    const firstHighlightStart = orderedSections.find((s, i) => isHighlightSection(s, i))?.startTime ?? Infinity;
    const earlyWindowEnd = Number.isFinite(firstHighlightStart)
        ? Math.max(
            boundedIntroProtectUntil,
            Math.min(firstHighlightStart * 0.5, boundedIntroProtectUntil + 4.5)
        )
        : boundedIntroProtectUntil + 3.8;

    const filtered: NoteData[] = [];
    for (const note of sorted) {
        const { section, index } = getSection(note.time);
        const secType = section.type;
        const secEnergy = section.avgEnergy || 0.5;
        const highlight = isHighlightSection(section, index);
        const quietVerse = !highlight
            && (secType === 'verse' || secType === 'bridge')
            && secEnergy <= eMean + eStd * 0.12;

        if (secType === 'intro' || secType === 'interlude' || secType === 'outro') {
            if (note.time < boundedIntroProtectUntil && calmFactor > 0.14) {
                const gate = difficulty === 'easy'
                    ? 8
                    : difficulty === 'normal'
                        ? 7
                        : difficulty === 'hard'
                            ? 6
                            : 5;
                const key = detHash(Math.round(note.time * 1000) + note.lane * 73);
                const keepStrong = (note.strength ?? 0.5) >= 0.74 && note.type !== 'tap';
                if (!keepStrong && key % gate !== 0) {
                    continue;
                }
            }
            filtered.push(note);
            continue;
        }

        if (calmFactor > 0.16 && quietVerse) {
            if (note.type === 'tap') {
                const inEarlyWindow = note.time <= earlyWindowEnd;
                let gate = difficulty === 'easy'
                    ? 6
                    : difficulty === 'normal'
                        ? 5
                        : difficulty === 'hard'
                            ? 4
                            : 3;
                if (inEarlyWindow) {
                    gate += 2;
                }
                const key = detHash(Math.round(note.time * 1000) + note.lane * 41 + Math.round(secEnergy * 100));
                const keepStrong = (note.strength ?? 0.5) >= (inEarlyWindow ? 0.74 : 0.68);
                if (!keepStrong && key % gate !== 0) {
                    continue;
                }
            }
            if (note.type === 'slide' && (note.duration ?? 0) < beatInterval * 1.02) {
                const key = detHash(Math.round(note.time * 1000) + 19);
                if (key % 3 !== 0) continue;
            }
        }
        filtered.push(note);
    }

    // 멜로디 지속음(바이올린/첼로류)은 슬라이드로 변환해 "끌어가는" 감각 강화.
    const converted: NoteData[] = [];
    if (sustainedFactor > 0.14 && songFeatures.percussiveFocus < 0.66) {
        for (let i = 0; i < filtered.length; i++) {
            const a = filtered[i];
            const b = filtered[i + 1];
            if (
                b
                && a.type === 'tap'
                && b.type === 'tap'
                && b.time > a.time
            ) {
                const laneDelta = Math.abs(a.lane - b.lane);
                const gap = b.time - a.time;
                const minGap = laneDelta > 0 ? beatInterval * 0.78 : beatInterval * 0.62;
                const maxGap = laneDelta > 0 ? beatInterval * 3.1 : beatInterval * 2.6;
                if (gap >= minGap && gap <= maxGap) {
                    const midTime = (a.time + b.time) * 0.5;
                    const profile = getSpectralProfileAt(spectralProfiles, midTime);
                    const tonal = profile?.tonal ?? songFeatures.melodicFocus;
                    const transient = profile?.transient ?? (1 - songFeatures.sustainedFocus);
                    const percussive = profile?.percussive ?? songFeatures.percussiveFocus;
                    const sustainedLike = tonal >= (laneDelta > 0 ? 0.6 : 0.57)
                        && transient <= (laneDelta > 0 ? 0.43 : 0.46)
                        && percussive <= (laneDelta > 0 ? 0.54 : 0.58);
                    const staccatoLike = transient >= 0.61 || percussive >= 0.64;
                    if (sustainedLike && !staccatoLike) {
                        if (laneDelta > 0 && calmFactor > 0.18) {
                            const gate = detHash(Math.round(midTime * 1000) + a.lane * 17 + b.lane * 31);
                            if (gate % 4 !== 0) {
                                converted.push(a);
                                continue;
                            }
                        }
                        const targetLane = laneDelta > 0 ? b.lane : a.lane;
                        converted.push({
                            ...a,
                            type: 'slide',
                            targetLane,
                            duration: Math.min(
                                Math.max(MIN_SLIDE_DURATION_SEC, gap * (laneDelta > 0 ? 0.96 : 0.92)),
                                beatInterval * (laneDelta > 0 ? 3.2 : 2.8)
                            ),
                            strength: Math.max(0.5, ((a.strength ?? 0.5) + (b.strength ?? 0.5)) * 0.5),
                        });
                        i += 1;
                        continue;
                    }
                }
            }
            converted.push(a);
        }
    } else {
        converted.push(...filtered);
    }

    const enforceSectionBudgets = (input: readonly NoteData[]): NoteData[] => {
        if (input.length === 0) return [];
        const byTime = [...input].sort((a, b) => a.time - b.time);
        const sectionBuckets: NoteData[][] = Array.from({ length: orderedSections.length }, () => []);
        let bucketIdx = 0;
        for (const note of byTime) {
            while (bucketIdx + 1 < orderedSections.length && note.time >= orderedSections[bucketIdx].endTime) {
                bucketIdx++;
            }
            const section = orderedSections[bucketIdx];
            if (!section) continue;
            if (note.time < section.startTime || note.time >= section.endTime) continue;
            sectionBuckets[bucketIdx].push(note);
        }
        const nearestBeatDistance = (time: number): number => {
            if (beatPositions.length === 0) return beatInterval * 0.5;
            let lo = 0;
            let hi = beatPositions.length - 1;
            let best = Number.POSITIVE_INFINITY;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const beat = beatPositions[mid];
                best = Math.min(best, Math.abs(beat - time), Math.abs(beat + beatInterval * 0.5 - time));
                if (beat < time) lo = mid + 1;
                else hi = mid - 1;
            }
            return best;
        };
        const npsRange: Record<Difficulty, { min: number; max: number }> = {
            easy: { min: 0.55, max: 1.95 },
            normal: { min: 0.95, max: 3.2 },
            hard: { min: 1.45, max: 4.5 },
            expert: { min: 1.95, max: 5.9 },
        };
        const globalDensityMedian = Math.max(0.3, percentile(densityVals, 0.5, 1.2));
        const globalStrongMedian = Math.max(0.2, percentile(strongDensityVals, 0.5, 0.7));

        const kept: NoteData[] = [];
        for (let si = 0; si < orderedSections.length; si++) {
            const section = orderedSections[si];
            const sectionNotes = sectionBuckets[si];
            if (sectionNotes.length === 0) continue;
            const duration = Math.max(0.001, section.endTime - section.startTime);
            const profile = sectionProfiles[si];
            const highlight = isHighlightSection(section, si);
            const earlyQuiet = section.startTime <= earlyWindowEnd + beatInterval;
            const range = npsRange[difficulty];
            const sectionDensity = profile?.density ?? globalDensityMedian;
            const sectionStrongDensity = profile?.strongDensity ?? globalStrongMedian;
            const densityPressure = clamp01(sectionDensity / (globalDensityMedian * 1.38));
            const strongPressure = clamp01(sectionStrongDensity / (globalStrongMedian * 1.42));
            const activity = profile?.activity ?? (highlight ? 0.68 : 0.42);
            const sectionDrive = clamp01(activity * 0.56 + densityPressure * 0.24 + strongPressure * 0.2);
            let targetNps = lerp(range.min, range.max, sectionDrive);
            if (highlight) {
                targetNps *= 0.9 + songFeatures.dynamicRange * 0.32 + songFeatures.driveScore * 0.18;
            } else {
                targetNps *= 0.84 + sustainedFactor * 0.2;
                if (calmFactor > 0.16) {
                    targetNps *= earlyQuiet ? 0.52 : 0.7;
                }
            }
            if (section.type === 'intro' || section.type === 'interlude') targetNps *= 0.42;
            else if (section.type === 'outro') targetNps *= 0.48;
            targetNps = Math.max(range.min * 0.4, Math.min(range.max * 1.08, targetNps));
            const budget = Math.max(1, Math.floor(duration * targetNps));
            if (sectionNotes.length <= budget) {
                kept.push(...sectionNotes);
                continue;
            }

            const candidates = sectionNotes
                .map(n => {
                    const typeWeight = n.type === 'slide' ? 0.26 : n.type === 'hold' ? 0.2 : 0;
                    const str = n.strength ?? 0.5;
                    const beatDist = nearestBeatDistance(n.time);
                    const beatCloseness = 1 - Math.min(1, beatDist / Math.max(0.001, beatInterval * 0.5));
                    const earlyPenalty = earlyQuiet && n.type === 'tap' ? -0.08 : 0;
                    const sustainBias = !highlight && n.type === 'slide' ? sustainedFactor * 0.12 : 0;
                    const score = str * 0.62 + typeWeight + beatCloseness * 0.16 + earlyPenalty + sustainBias;
                    return { note: n, score };
                })
                .sort((a, b) => b.score - a.score);

            const accepted: NoteData[] = [];
            const acceptedLaneTimes: [number[], number[]] = [[], []];
            const minGap = highlight
                ? Math.max(0.05, beatInterval * 0.17)
                : Math.max(0.09, beatInterval * (earlyQuiet ? 0.34 : 0.28));
            const hasAcceptedNear = (time: number, lane: number): boolean => {
                const arr = acceptedLaneTimes[lane === 0 ? 0 : 1];
                if (arr.length === 0) return false;
                let lo = 0;
                let hi = arr.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (arr[mid] < time) lo = mid + 1;
                    else hi = mid;
                }
                const idx = lo;
                if (idx < arr.length && Math.abs(arr[idx] - time) < minGap) return true;
                if (idx > 0 && Math.abs(arr[idx - 1] - time) < minGap) return true;
                return false;
            };
            const insertAcceptedTime = (time: number, lane: number): void => {
                const arr = acceptedLaneTimes[lane === 0 ? 0 : 1];
                let lo = 0;
                let hi = arr.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (arr[mid] < time) lo = mid + 1;
                    else hi = mid;
                }
                arr.splice(lo, 0, time);
            };
            for (const cand of candidates) {
                if (accepted.length >= budget) break;
                const overlap = hasAcceptedNear(cand.note.time, cand.note.lane);
                if (overlap) continue;
                accepted.push(cand.note);
                insertAcceptedTime(cand.note.time, cand.note.lane);
            }
            if (accepted.length === 0) {
                accepted.push(candidates[0].note);
            }
            kept.push(...accepted);
        }
        return kept.sort((a, b) => a.time - b.time);
    };

    const budgeted = enforceSectionBudgets(converted);

    // 하이라이트 구간 밀도가 지나치게 비면 최소한의 앵커를 보강.
    const highlighted = budgeted.sort((a, b) => a.time - b.time);
    const add: NoteData[] = [];
    const targetHighlightRange: Record<Difficulty, { min: number; max: number }> = {
        easy: { min: 1.3, max: 2.2 },
        normal: { min: 2.3, max: 3.8 },
        hard: { min: 3.3, max: 5.5 },
        expert: { min: 4.2, max: 7.0 },
    };
    const highlightBoost = 0.82 + clamp01(songFeatures.dynamicRange * 0.55 + songFeatures.driveScore * 0.25) * 0.45;
    const lowerBoundTime = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const laneTimes: [number[], number[]] = [[], []];
    for (let i = 0; i < highlighted.length; i++) {
        laneTimes[highlighted[i].lane === 0 ? 0 : 1].push(highlighted[i].time);
    }
    const addedLaneTimes: [number[], number[]] = [[], []];
    const hasNearIn = (arr: readonly number[], time: number, win: number): boolean => {
        if (arr.length === 0) return false;
        const idx = lowerBoundTime(arr, time);
        if (idx < arr.length && Math.abs(arr[idx] - time) < win) return true;
        if (idx > 0 && Math.abs(arr[idx - 1] - time) < win) return true;
        return false;
    };
    const hasNear = (time: number, lane: number, win: number): boolean => {
        const laneIdx = lane === 0 ? 0 : 1;
        return hasNearIn(laneTimes[laneIdx], time, win) || hasNearIn(addedLaneTimes[laneIdx], time, win);
    };
    const allHighlightedTimes = highlighted.map(n => n.time);
    const countInRange = (arr: readonly number[], start: number, end: number): number => {
        if (arr.length === 0) return 0;
        return Math.max(0, lowerBoundTime(arr, end) - lowerBoundTime(arr, start));
    };
    let lane = highlighted[highlighted.length - 1]?.lane ?? 1;
    const maxAdd = Math.max(6, Math.floor(highlighted.length * 0.16));

    for (let si = 0; si < orderedSections.length; si++) {
        const section = orderedSections[si];
        if (!isHighlightSection(section, si)) continue;
        if (section.type === 'intro' || section.type === 'outro' || section.type === 'interlude') continue;
        const profile = sectionProfiles[si];
        const duration = Math.max(0, section.endTime - section.startTime);
        if (duration < beatInterval * 2) continue;
        const existing = countInRange(allHighlightedTimes, section.startTime, section.endTime);
        const range = targetHighlightRange[difficulty];
        const activity = profile?.activity ?? 0.72;
        const targetNps = lerp(range.min, range.max, clamp01(activity * 0.82 + songFeatures.driveScore * 0.18));
        const target = Math.max(2, Math.floor(duration * targetNps * highlightBoost));
        if (existing >= target) continue;
        let addInSection = 0;
        for (const beat of beatPositions) {
            if (add.length >= maxAdd) break;
            if (beat < section.startTime || beat >= section.endTime) continue;
            if (hasNear(beat, lane, beatInterval * 0.22)) continue;
            lane = lane === 0 ? 1 : 0;
            add.push({
                time: beat,
                lane,
                type: 'tap',
                strength: 0.58,
            });
            const laneIdx = lane === 0 ? 0 : 1;
            const insertIdx = lowerBoundTime(addedLaneTimes[laneIdx], beat);
            addedLaneTimes[laneIdx].splice(insertIdx, 0, beat);
            addInSection++;
            if (existing + addInSection >= target) break;
        }
        if (add.length >= maxAdd) break;
    }

    return dedupeNotes([...highlighted, ...add], 0.036);
};

const reinforceSustainedSlidePhrases = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    spectralProfiles: readonly SpectralProfile[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    beatPositions: readonly number[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length === 0) return [];
    const sustainedFactor = clamp01((songFeatures.sustainedFocus - 0.38) / 0.62);
    if (sustainedFactor < 0.08) return [...notes].sort((a, b) => a.time - b.time);

    const beatInterval = 60 / Math.max(1, bpm);
    const minGap = Math.max(beatInterval * (0.44 + (1 - sustainedFactor) * 0.12), 0.24);
    const maxGap = Math.max(beatInterval * (4.4 + sustainedFactor * 0.8), 1.75);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    if (sorted.length < 6) return sorted;

    const isLong = (n: NoteData): boolean =>
        (n.type === 'slide' || n.type === 'hold') && (n.duration ?? 0) > 0;

    const sortedOnsetPairs = onsetTimes
        .map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
    const onsetTimeline = sortedOnsetPairs.map(p => p.time);
    const onsetStrengthTimeline = sortedOnsetPairs.map(p => p.strength);

    const lowerBound = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const measureOnsetDensity = (start: number, end: number): { density: number; strongDensity: number } => {
        if (end <= start || onsetTimeline.length === 0) return { density: 0, strongDensity: 0 };
        const i0 = lowerBound(onsetTimeline, start);
        const i1 = lowerBound(onsetTimeline, end);
        if (i1 <= i0) return { density: 0, strongDensity: 0 };
        const dur = Math.max(0.001, end - start);
        const count = i1 - i0;
        let strong = 0;
        for (let i = i0; i < i1; i++) {
            if ((onsetStrengthTimeline[i] ?? 0.5) >= 0.66) strong++;
        }
        return { density: count / dur, strongDensity: strong / dur };
    };
    const gridSnap = (time: number): number => {
        if (beatPositions.length === 0) return time;
        let lo = 0;
        let hi = beatPositions.length - 1;
        let best = beatPositions[0];
        let bestDist = Math.abs(best - time);
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const b = beatPositions[mid];
            const h = b + beatInterval * 0.5;
            const dBeat = Math.abs(b - time);
            if (dBeat < bestDist) {
                bestDist = dBeat;
                best = b;
            }
            const dHalf = Math.abs(h - time);
            if (dHalf < bestDist) {
                bestDist = dHalf;
                best = h;
            }
            if (b < time) lo = mid + 1;
            else hi = mid - 1;
        }
        return best;
    };

    let sectionPtr = 0;
    const sectionAt = (time: number): { type: string; avgEnergy: number } => {
        while (sectionPtr + 1 < sections.length && time >= sections[sectionPtr].endTime) sectionPtr++;
        while (sectionPtr > 0 && time < sections[sectionPtr].startTime) sectionPtr--;
        return sections[sectionPtr] ?? { type: 'verse', avgEnergy: 0.5 };
    };
    const isPlayableSection = (type: string): boolean =>
        type !== 'intro' && type !== 'outro' && type !== 'interlude';

    interface Candidate {
        readonly startIdx: number;
        readonly endIdx: number;
        readonly score: number;
        readonly duration: number;
    }
    const candidates: Candidate[] = [];
    const maxLookahead = difficulty === 'easy'
        ? 5
        : difficulty === 'normal'
            ? 6
            : difficulty === 'hard'
                ? 7
                : 8;

    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        if (a.type !== 'tap') continue;
        const sec = sectionAt(a.time);
        if (!isPlayableSection(sec.type)) continue;

        for (let j = i + 1; j < sorted.length && j <= i + maxLookahead; j++) {
            const b = sorted[j];
            const gap = b.time - a.time;
            if (gap > maxGap) break;
            if (gap < minGap) continue;
            if (b.type !== 'tap') continue;
            if (a.lane !== b.lane) continue;

            let middleSameLane = 0;
            for (let k = i + 1; k < j; k++) {
                const m = sorted[k];
                if (m.type === 'tap' && m.lane === a.lane) middleSameLane++;
            }
            if (middleSameLane > 3) continue;

            const midTime = (a.time + b.time) * 0.5;
            const section = sectionAt(midTime);
            if (!isPlayableSection(section.type)) continue;
            const pA = getSpectralProfileAt(spectralProfiles, lerp(a.time, b.time, 0.25));
            const pM = getSpectralProfileAt(spectralProfiles, midTime);
            const pB = getSpectralProfileAt(spectralProfiles, lerp(a.time, b.time, 0.75));
            const tonal = avg([
                pA?.tonal ?? songFeatures.melodicFocus,
                pM?.tonal ?? songFeatures.melodicFocus,
                pB?.tonal ?? songFeatures.melodicFocus,
            ], songFeatures.melodicFocus);
            const transient = avg([
                pA?.transient ?? (1 - songFeatures.sustainedFocus),
                pM?.transient ?? (1 - songFeatures.sustainedFocus),
                pB?.transient ?? (1 - songFeatures.sustainedFocus),
            ], 1 - songFeatures.sustainedFocus);
            const percussive = avg([
                pA?.percussive ?? songFeatures.percussiveFocus,
                pM?.percussive ?? songFeatures.percussiveFocus,
                pB?.percussive ?? songFeatures.percussiveFocus,
            ], songFeatures.percussiveFocus);
            const onset = measureOnsetDensity(a.time, b.time);
            const beatPerSec = 1 / Math.max(1e-4, beatInterval);
            const onsetBurst = clamp01((onset.density - beatPerSec * 0.72) / Math.max(0.8, beatPerSec * 0.9));
            const strongBurst = clamp01((onset.strongDensity - beatPerSec * 0.4) / Math.max(0.6, beatPerSec * 0.8));
            const sustainedScore = tonal * 0.64 + (1 - transient) * 0.24 + (1 - percussive) * 0.12;
            const rhythmicBurst = transient * 0.4 + percussive * 0.26 + onsetBurst * 0.22 + strongBurst * 0.12;
            const baseThreshold = section.type === 'drop' || section.type === 'chorus'
                ? 0.5
                : 0.46;
            const threshold = Math.max(0.42, baseThreshold - sustainedFactor * 0.08);
            const burstLimit = 0.8 + sustainedFactor * 0.1;
            if (sustainedScore < threshold || rhythmicBurst > burstLimit) continue;

            const duration = Math.min(
                Math.max(MIN_SLIDE_DURATION_SEC, gap * 0.94, beatInterval * 0.86),
                beatInterval * 4.4
            );
            const smoothness = clamp01((gap - minGap) / Math.max(0.001, maxGap - minGap));
            const score = sustainedScore * 0.72
                - rhythmicBurst * 0.34
                + smoothness * 0.2
                + (1 - onsetBurst) * 0.08
                + (a.strength ?? 0.5) * 0.08;
            candidates.push({ startIdx: i, endIdx: j, score, duration });
        }
    }

    if (candidates.length === 0) return sorted;
    candidates.sort((a, b) => b.score - a.score || sorted[a.startIdx].time - sorted[b.startIdx].time);

    const converted = new Map<number, number>();
    const removed = new Set<number>();
    const consumed = new Set<number>();
    const acceptedIntervals: Array<{ start: number; end: number; lane: number }> = [];
    const convertRatio: Record<Difficulty, number> = {
        easy: 0.12,
        normal: 0.18,
        hard: 0.24,
        expert: 0.28,
    };
    const maxConvert = Math.min(
        36,
        Math.max(2, Math.floor(sorted.length * convertRatio[difficulty] * (0.48 + sustainedFactor * 0.88)))
    );
    const laneLongIntervals: [Array<{ start: number; end: number; idx: number }>, Array<{ start: number; end: number; idx: number }>] = [[], []];
    for (let k = 0; k < sorted.length; k++) {
        const n = sorted[k];
        if (!isLong(n)) continue;
        const lane = n.lane === 0 ? 0 : 1;
        laneLongIntervals[lane].push({
            start: n.time,
            end: n.time + normalizeLongDuration(n.type, n.duration, beatInterval),
            idx: k,
        });
    }
    for (let lane = 0; lane <= 1; lane++) {
        laneLongIntervals[lane].sort((a, b) => a.start - b.start);
    }

    const hasLongConflict = (start: number, end: number, lane: number, ignoreStartIdx: number): boolean => {
        const safeLane = lane === 0 ? 0 : 1;
        const intervals = laneLongIntervals[safeLane];
        if (intervals.length === 0) return false;
        let lo = 0;
        let hi = intervals.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (intervals[mid].start < start) lo = mid + 1;
            else hi = mid;
        }
        for (let i = Math.max(0, lo - 2); i < intervals.length; i++) {
            const iv = intervals[i];
            if (iv.start > end + 0.03) break;
            if (iv.idx === ignoreStartIdx || removed.has(iv.idx)) continue;
            if (Math.max(start, iv.start) < Math.min(end, iv.end) - 0.03) return true;
        }
        return false;
    };

    let convertedCount = 0;
    for (const cand of candidates) {
        if (convertedCount >= maxConvert) break;
        if (consumed.has(cand.startIdx) || consumed.has(cand.endIdx)) continue;
        if (removed.has(cand.startIdx) || removed.has(cand.endIdx)) continue;
        const startNote = sorted[cand.startIdx];
        const endNote = sorted[cand.endIdx];
        const start = startNote.time;
        const end = start + cand.duration;
        const convertedConflict = acceptedIntervals.some(iv =>
            iv.lane === startNote.lane
            && Math.max(start, iv.start) < Math.min(end, iv.end) - 0.04
        );
        if (convertedConflict) continue;
        if (hasLongConflict(start, end, startNote.lane, cand.startIdx)) continue;

        converted.set(cand.startIdx, cand.duration);
        for (let k = cand.startIdx + 1; k <= cand.endIdx; k++) {
            const n = sorted[k];
            if (n.type === 'tap' && n.lane === startNote.lane) {
                removed.add(k);
                consumed.add(k);
            }
        }
        consumed.add(cand.startIdx);
        acceptedIntervals.push({ start, end, lane: startNote.lane });
        convertedCount++;
    }

    const out: NoteData[] = [];
    for (let i = 0; i < sorted.length; i++) {
        if (removed.has(i) && !converted.has(i)) continue;
        const n = sorted[i];
        const duration = converted.get(i);
        if (duration !== undefined) {
            const snapped = gridSnap(n.time);
            out.push({
                ...n,
                time: snapped,
                type: 'slide',
                targetLane: n.lane,
                duration,
                strength: Math.max(0.54, n.strength ?? 0.5),
            });
            continue;
        }
        out.push(n);
    }
    const outSorted = out.sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    // 지속음 구간인데 인접 페어가 없어 누락된 경우, 단발 탭을 직선 슬라이드로 승격.
    if (sustainedFactor >= 0.24) {
        const bonusRatio: Record<Difficulty, number> = {
            easy: 0.03,
            normal: 0.05,
            hard: 0.07,
            expert: 0.09,
        };
        const maxBonus = Math.max(2, Math.floor(outSorted.length * bonusRatio[difficulty] * (0.8 + sustainedFactor * 0.5)));
        let bonusCount = 0;
        const laneBusyUntil: [number, number] = [-Infinity, -Infinity];
        for (const n of outSorted) {
            if (n.type === 'slide' || n.type === 'hold') {
                const lane = n.lane === 0 ? 0 : 1;
                const end = n.time + normalizeLongDuration(n.type, n.duration, beatInterval);
                laneBusyUntil[lane] = Math.max(laneBusyUntil[lane], end + beatInterval * 0.16);
            }
        }
        for (let i = 0; i < outSorted.length && bonusCount < maxBonus; i++) {
            const n = outSorted[i];
            if (n.type !== 'tap') continue;
            const section = sectionAt(n.time);
            if (!isPlayableSection(section.type)) continue;
            if (section.type === 'drop' || section.type === 'chorus') continue;
            if ((n.strength ?? 0.5) < 0.48) continue;

            const profile = getSpectralProfileAt(spectralProfiles, n.time);
            const tonal = profile?.tonal ?? songFeatures.melodicFocus;
            const transient = profile?.transient ?? (1 - songFeatures.sustainedFocus);
            const percussive = profile?.percussive ?? songFeatures.percussiveFocus;
            if (tonal < 0.58 || transient > 0.48 || percussive > 0.58) continue;

            const onset = measureOnsetDensity(n.time, n.time + beatInterval * 2);
            const beatPerSec = 1 / Math.max(1e-4, beatInterval);
            if (onset.strongDensity > beatPerSec * 0.38) continue;

            const lane = n.lane === 0 ? 0 : 1;
            if (n.time < laneBusyUntil[lane]) continue;
            const nearLong = outSorted.some(m =>
                m !== n
                && (m.type === 'slide' || m.type === 'hold')
                && m.lane === lane
                && Math.abs(m.time - n.time) < beatInterval * 0.62
            );
            if (nearLong) continue;

            const baseDur = beatInterval * (1.18 + tonal * 1.15 - transient * 0.45);
            const duration = Math.min(
                beatInterval * 3.1,
                Math.max(MIN_SLIDE_DURATION_SEC, baseDur)
            );
            outSorted[i] = {
                ...n,
                type: 'slide',
                targetLane: n.lane,
                duration,
                strength: Math.max(0.54, n.strength ?? 0.5),
            };
            laneBusyUntil[lane] = n.time + duration + beatInterval * 0.18;
            bonusCount++;
        }
    }

    return dedupeNotes(outSorted, 0.035);
};

const sanitizeFinalLongNotes = (
    notes: readonly NoteData[],
    bpm: number
): NoteData[] => {
    if (notes.length === 0) return [];
    const beatInterval = 60 / Math.max(1, bpm);
    const sanitized = notes.map(note => {
        const lane = note.lane === 0 ? 0 : 1;
        if (note.type === 'slide') {
            const targetLane = note.targetLane === 0 || note.targetLane === 1
                ? note.targetLane
                : lane;
            const duration = normalizeLongDuration('slide', note.duration, beatInterval);
            return {
                ...note,
                lane,
                targetLane,
                duration,
            };
        }
        if (note.type === 'hold') {
            const duration = normalizeLongDuration('hold', note.duration, beatInterval);
            return {
                ...note,
                lane,
                duration,
            };
        }
        return {
            ...note,
            lane,
        };
    });
    return dedupeNotes(resolveLongNoteCollisions(sanitized, bpm), 0.036);
};

const resolveVisualNoteOverlaps = (
    notes: readonly NoteData[],
    bpm: number,
    difficulty: Difficulty
): NoteData[] => {
    if (notes.length <= 1) return [...notes];
    const beatInterval = 60 / Math.max(1, bpm);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const headWindow = Math.max(0.055, beatInterval * 0.18);
    const bodyWindow = Math.max(0.09, beatInterval * 0.36);

    const longNotes = sorted
        .filter(n => (n.type === 'slide' || n.type === 'hold') && (n.duration ?? 0) > 0)
        .map(n => ({
            start: n.time,
            end: n.time + normalizeLongDuration(n.type, n.duration, beatInterval),
            lane: n.lane,
            type: n.type as string,
            toLane: n.type === 'slide' ? resolveSlideTargetLane(n) : n.lane,
            batonMidStart: n.time + normalizeLongDuration(n.type, n.duration, beatInterval) * 0.42,
            batonMidEnd: n.time + normalizeLongDuration(n.type, n.duration, beatInterval) * 0.62,
        }));

    const filtered = sorted.filter(n => {
        if (n.type !== 'tap') return true;
        // 슬라이드/홀드 시작 헤드와 겹치는 탭은 제거 (도형 중첩 방지)
        const overlapHead = longNotes.some(l =>
            (n.lane === l.lane || (l.type === 'slide' && n.lane === l.toLane))
            && Math.abs(n.time - l.start) < headWindow
        );
        if (overlapHead) return false;

        // 슬라이드 바디 중 양쪽 레인 탭 제거 (슬라이드는 두 레인을 동시 사용)
        const overlapSlideBody = longNotes.some(l => {
            if (l.type !== 'slide') return false;
            if (n.time <= l.start + 0.02 || n.time >= l.end - 0.02) return false;
            const diagonal = l.toLane !== l.lane;
            const batonWindow = diagonal
                && n.time >= l.batonMidStart
                && n.time <= l.batonMidEnd
                && n.lane === l.toLane;
            if (batonWindow) return false;
            return true;
        });
        if (overlapSlideBody) return false;

        // 홀드 바디 중 동일 레인 탭 제거
        const overlapBody = longNotes.some(l =>
            l.type === 'hold'
            && n.lane === l.lane
            && n.time > l.start + 0.02
            && n.time < Math.min(l.end, l.start + bodyWindow)
        );
        if (overlapBody) return false;
        return true;
    });

    const priority = (n: NoteData): number =>
        n.type === 'slide' ? 3 : n.type === 'hold' ? 2 : 1;
    const overlapWindow = Math.max(0.03, beatInterval * 0.09);
    const out: NoteData[] = [];
    for (const note of filtered) {
        let merged = false;
        for (let i = out.length - 1; i >= 0; i--) {
            const prev = out[i];
            if (note.time - prev.time > overlapWindow) break;
            if (prev.lane !== note.lane) continue;
            if (Math.abs(note.time - prev.time) >= overlapWindow) continue;

            const noteKey = priority(note) * 10 + (note.strength ?? 0.5);
            const prevKey = priority(prev) * 10 + (prev.strength ?? 0.5);
            if (noteKey > prevKey + 0.03) {
                out[i] = note;
            } else if (Math.abs(noteKey - prevKey) <= 0.03) {
                const noteDur = note.duration ?? 0;
                const prevDur = prev.duration ?? 0;
                if (noteDur > prevDur) out[i] = note;
            }
            merged = true;
            break;
        }
        if (!merged) out.push(note);
    }

    return dedupeNotes(out, 0.034);
};

const enforcePhysicalPlayability = (
    notes: readonly NoteData[],
    beatPositions: readonly number[],
    bpm: number,
    _difficulty: Difficulty
): NoteData[] => {
    if (notes.length === 0) return [];
    const beatInterval = 60 / bpm;
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    interface ActiveLongState {
        readonly start: number;
        readonly end: number;
        readonly lanes: number[];
        readonly type: 'slide' | 'hold';
        readonly fromLane: number;
        readonly toLane: number;
    }
    const activeLongs: ActiveLongState[] = [];
    const out: NoteData[] = [];
    const minGap = 0.085;
    const strictSingleAction = false;
    const allowDualSlidePatterns = true;
    const pairSyncWindow = beatInterval * 0.18;
    const laneRecoveryUntil: [number, number] = [-Infinity, -Infinity];
    const recoveryWindow = beatInterval * 0.24;
    const occupancyStep = Math.max(0.028, minGap * 0.52);
    const laneBuckets: [Set<number>, Set<number>] = [new Set<number>(), new Set<number>()];

    const purgeLongs = (time: number): void => {
        for (let i = activeLongs.length - 1; i >= 0; i--) {
            if (activeLongs[i].end < time - 0.01) activeLongs.splice(i, 1);
        }
    };
    const nearestBeat = (time: number): number => {
        let best = time;
        let bestD = Infinity;
        for (const b of beatPositions) {
            const d1 = Math.abs(b - time);
            if (d1 < bestD) { bestD = d1; best = b; }
            const h = b + beatInterval * 0.5;
            const d2 = Math.abs(h - time);
            if (d2 < bestD) { bestD = d2; best = h; }
            if (b > time + beatInterval) break;
        }
        return best;
    };
    const toBucket = (time: number): number => Math.round(time / occupancyStep);
    const markHeadOccupied = (time: number, lanes: readonly number[]): void => {
        const b = toBucket(time);
        for (const lane of lanes) {
            const safeLane = lane === 0 ? 0 : 1;
            laneBuckets[safeLane].add(b - 1);
            laneBuckets[safeLane].add(b);
            laneBuckets[safeLane].add(b + 1);
        }
    };
    const hasNearbyLaneConflict = (time: number, lanes: readonly number[], win = minGap): boolean => {
        const b = toBucket(time);
        const reach = Math.max(1, Math.ceil(win / Math.max(1e-4, occupancyStep)));
        for (const lane of lanes) {
            const safeLane = lane === 0 ? 0 : 1;
            for (let d = -reach; d <= reach; d++) {
                if (laneBuckets[safeLane].has(b + d)) {
                    return true;
                }
            }
        }
        return false;
    };
    const canPairWithActiveLong = (
        active: ActiveLongState,
        start: number,
        duration: number,
        type: 'slide' | 'hold',
        fromLane: number,
        toLane: number
    ): boolean => {
        if (!allowDualSlidePatterns) return false;
        if (type !== 'slide' || active.type !== 'slide') return false;
        if (Math.abs(active.start - start) > pairSyncWindow) return false;
        if (Math.abs((active.end - active.start) - duration) > beatInterval * 0.9) return false;
        const isCrossPair = active.fromLane === toLane && active.toLane === fromLane;
        const isDualStraight = active.toLane === active.fromLane && toLane === fromLane && active.fromLane !== fromLane;
        if (!isCrossPair && !isDualStraight) return false;
        const concurrent = activeLongs.filter(l => start < l.end - 0.01 && Math.abs(l.start - start) <= pairSyncWindow).length;
        return concurrent < 2;
    };

    for (const note of sorted) {
        purgeLongs(note.time);
        const isLong = (note.type === 'slide' || note.type === 'hold') && !!note.duration && note.duration > 0;
        const targetLane = note.type === 'slide' ? resolveSlideTargetLane(note) : note.lane;
        const noteLanes = note.type === 'slide'
            ? getOccupiedControlLanes(note)
            : [note.lane];

        if (!isLong) {
            if (note.time < laneRecoveryUntil[note.lane]) continue;
            const blocked = activeLongs.some(l => strictSingleAction || lanesOverlap(noteLanes, l.lanes));
            if (blocked) {
                const earliest = Math.max(note.time + beatInterval * 0.45, laneRecoveryUntil[note.lane] + 0.01);
                const shifted = nearestBeat(earliest);
                if (
                    !activeLongs.some(l => shifted <= l.end + 0.01 && (strictSingleAction || lanesOverlap(noteLanes, l.lanes)))
                    && !hasNearbyLaneConflict(shifted, noteLanes, minGap * 0.9)
                ) {
                    out.push({ ...note, time: shifted });
                    markHeadOccupied(shifted, noteLanes);
                }
                continue;
            }
            if (hasNearbyLaneConflict(note.time, noteLanes, minGap)) continue;
            out.push(note);
            markHeadOccupied(note.time, noteLanes);
            continue;
        }

        const longType: 'slide' | 'hold' = note.type === 'slide' ? 'slide' : 'hold';
        const minLongDur = normalizeLongDuration(longType, undefined, beatInterval);
        const maxLongDur = longType === 'slide'
            ? Math.max(minLongDur + 0.45, beatInterval * 8.2)
            : Math.max(minLongDur + 0.35, beatInterval * 7.2);
        const duration = Math.min(
            maxLongDur,
            Math.max(minLongDur, normalizeLongDuration(longType, note.duration, beatInterval))
        );
        let start = note.time;
        let end = start + duration;
        const pairCompatible = activeLongs.some(l => canPairWithActiveLong(l, start, duration, longType, note.lane, targetLane));
        const conflictEnd = activeLongs.reduce((mx, l) => {
            if (canPairWithActiveLong(l, start, duration, longType, note.lane, targetLane)) {
                return mx;
            }
            if (strictSingleAction) {
                return Math.max(mx, l.end);
            }
            const laneConflict = lanesOverlap(noteLanes, l.lanes);
            return laneConflict ? Math.max(mx, l.end) : mx;
        }, -Infinity);

        if (isFinite(conflictEnd) && start < conflictEnd + 0.02) {
            const shiftedStart = conflictEnd + 0.02;
            const remaining = end - shiftedStart;
            if (remaining < minLongDur) {
                continue;
            }
            start = shiftedStart;
            end = start + Math.max(minLongDur, remaining);
        }

        if (!pairCompatible && hasNearbyLaneConflict(start, noteLanes, minGap * 0.9)) continue;
        out.push({
            ...note,
            time: start,
            duration: end - start,
            targetLane: note.type === 'slide' ? targetLane : undefined,
        });
        markHeadOccupied(start, noteLanes);
        activeLongs.push({
            start,
            end,
            lanes: noteLanes,
            type: longType,
            fromLane: note.lane,
            toLane: targetLane,
        });
        for (const lane of noteLanes) {
            laneRecoveryUntil[lane] = Math.max(laneRecoveryUntil[lane], end + recoveryWindow);
        }
    }

    return dedupeNotes(resolveLongNoteCollisions(out, bpm), 0.04);
};

const pruneImpossibleNestedNotes = (
    notes: readonly NoteData[],
    bpm: number
): NoteData[] => {
    if (notes.length <= 1) return [...notes];
    const beatInterval = 60 / Math.max(1, bpm);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const longWindows = sorted
        .filter(n => (n.type === 'slide' || n.type === 'hold') && (n.duration ?? 0) > 0.06)
        .map(n => ({
            start: n.time,
            end: n.time + normalizeLongDuration(n.type, n.duration, beatInterval),
            type: n.type,
            fromLane: n.lane,
            toLane: n.type === 'slide' ? resolveSlideTargetLane(n) : n.lane,
        }))
        .sort((a, b) => a.start - b.start);

    if (longWindows.length === 0) return dedupeNotes(sorted, 0.036);

    const out: NoteData[] = [];
    const startGuard = Math.max(0.035, beatInterval * 0.12);
    const endGuard = Math.max(0.028, beatInterval * 0.1);
    const oppositeTapGap = Math.max(0.24, beatInterval * 0.56);
    const sameLaneGap = Math.max(0.055, beatInterval * 0.17);
    const activeLongs: typeof longWindows = [];
    const lastTapTimeByLane: [number, number] = [-Infinity, -Infinity];
    const lastTypeTime = new Map<string, number>();
    const typeLaneKey = (lane: number, type: NoteData['type']): string => `${lane}:${type}`;
    const commit = (note: NoteData): void => {
        out.push(note);
        lastTypeTime.set(typeLaneKey(note.lane, note.type), note.time);
        if (note.type === 'tap') {
            lastTapTimeByLane[note.lane === 0 ? 0 : 1] = note.time;
        }
    };
    let longPtr = 0;

    for (const note of sorted) {
        if (note.type === 'slide' || note.type === 'hold') {
            commit(note);
            continue;
        }

        while (longPtr < longWindows.length && note.time > longWindows[longPtr].start + startGuard) {
            activeLongs.push(longWindows[longPtr]);
            longPtr++;
        }
        for (let i = activeLongs.length - 1; i >= 0; i--) {
            if (note.time >= activeLongs[i].end - endGuard) {
                activeLongs.splice(i, 1);
            }
        }

        const lastSameType = lastTypeTime.get(typeLaneKey(note.lane, note.type)) ?? -Infinity;
        if (note.time - lastSameType < sameLaneGap) continue;

        let blocked = false;
        for (const long of activeLongs) {
            if (note.time <= long.start + startGuard || note.time >= long.end - endGuard) continue;
            if (long.type === 'hold') {
                if (note.lane === long.fromLane) {
                    blocked = true;
                    break;
                }
                continue;
            }
            const diagonal = long.fromLane !== long.toLane;
            if (diagonal) {
                // 대각 슬라이드는 중간 바톤 터치 구간의 도착 레인 탭은 허용.
                const batonStart = long.start + (long.end - long.start) * 0.42;
                const batonEnd = long.start + (long.end - long.start) * 0.62;
                const batonWindow = note.lane === long.toLane && note.time >= batonStart && note.time <= batonEnd;
                if (!batonWindow && (note.lane === long.fromLane || note.lane === long.toLane)) {
                    blocked = true;
                    break;
                }
                continue;
            }

            // 직선 슬라이드는 반대 레인 탭을 허용하되 과밀 중첩은 차단.
            if (note.lane === long.fromLane) {
                blocked = true;
                break;
            }
            const nearOppositeTap = (note.time - lastTapTimeByLane[note.lane === 0 ? 0 : 1]) < oppositeTapGap;
            if (nearOppositeTap) {
                blocked = true;
                break;
            }
        }
        if (blocked) continue;
        commit(note);
    }

    return dedupeNotes(out, 0.036);
};

const enforceStrictLongBodyExclusion = (
    notes: readonly NoteData[],
    bpm: number,
    difficulty: Difficulty
): NoteData[] => {
    if (notes.length <= 1) return [...notes];
    const beatInterval = 60 / Math.max(1, bpm);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const longWindows = sorted
        .filter(n => (n.type === 'slide' || n.type === 'hold') && (n.duration ?? 0) > 0.05)
        .map(n => ({
            start: n.time,
            end: n.time + normalizeLongDuration(n.type, n.duration, beatInterval),
            type: n.type,
            fromLane: n.lane,
            toLane: n.type === 'slide' ? resolveSlideTargetLane(n) : n.lane,
            batonMidStart: n.time + normalizeLongDuration(n.type, n.duration, beatInterval) * 0.42,
            batonMidEnd: n.time + normalizeLongDuration(n.type, n.duration, beatInterval) * 0.62,
        }))
        .sort((a, b) => a.start - b.start);
    if (longWindows.length === 0) return dedupeNotes(sorted, 0.035);

    const startGuard = Math.max(0.045, beatInterval * 0.12);
    const endGuard = Math.max(0.04, beatInterval * 0.1);
    const out: NoteData[] = [];
    for (const note of sorted) {
        const isLong = note.type === 'slide' || note.type === 'hold';
        if (isLong) {
            out.push(note);
            continue;
        }
        let blocked = false;
        for (const long of longWindows) {
            if (note.time <= long.start + startGuard || note.time >= long.end - endGuard) continue;
            if (long.type === 'slide') {
                const diagonal = long.fromLane !== long.toLane;
                const batonWindow = diagonal
                    && note.time >= long.batonMidStart
                    && note.time <= long.batonMidEnd
                    && note.lane === long.toLane;
                if (!batonWindow) {
                    blocked = true;
                    break;
                }
                continue;
            }
            if (note.lane === long.fromLane || note.lane === long.toLane) {
                blocked = true;
                break;
            }
        }
        if (!blocked) out.push(note);
    }

    return dedupeNotes(resolveLongNoteCollisions(out, bpm), 0.035);
};

const SECTION_NPS_RANGE: Record<Difficulty, { min: number; max: number }> = {
    easy: { min: 1.7, max: 2.9 },
    normal: { min: 3.2, max: 5.6 },
    hard: { min: 4.8, max: 7.9 },
    expert: { min: 6.6, max: 10.6 },
};

const rebalanceSectionDensityByDifficulty = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures,
    aggressiveness = 1,
    typeFeedback?: Partial<Record<'verse' | 'chorus' | 'drop' | 'bridge', number>>
): NoteData[] => {
    if (notes.length === 0 || beatPositions.length === 0 || sections.length === 0 || bpm <= 0) {
        return [...notes];
    }
    const beatInterval = 60 / Math.max(1, bpm);
    const playable = sections
        .filter(s => s.type !== 'intro' && s.type !== 'outro' && s.type !== 'interlude')
        .sort((a, b) => a.startTime - b.startTime);
    if (playable.length === 0) return [...notes];

    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const result = [...sorted];
    const longWindows = sorted
        .filter(n => (n.type === 'slide' || n.type === 'hold') && (n.duration ?? 0) > 0.05)
        .map(n => ({
            start: n.time,
            end: n.time + normalizeLongDuration(n.type, n.duration, beatInterval),
            lanes: getOccupiedControlLanes(n),
        }));
    const laneLongWindows: [Array<{ start: number; end: number }>, Array<{ start: number; end: number }>] = [[], []];
    for (let i = 0; i < longWindows.length; i++) {
        const w = longWindows[i];
        for (let li = 0; li < w.lanes.length; li++) {
            const lane = w.lanes[li] === 0 ? 0 : 1;
            laneLongWindows[lane].push({ start: w.start, end: w.end });
        }
    }
    const existingTimes = result.map(n => n.time).sort((a, b) => a - b);
    const onsetPairs = onsetTimes.map((time, i) => ({ time, strength: onsetStrengths[i] ?? 0.5 }))
        .filter(p => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
    const onsetTimeline = onsetPairs.map(p => p.time);
    const lb = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const minGapByDiff: Record<Difficulty, number> = {
        easy: Math.max(0.085, beatInterval * 0.28),
        normal: Math.max(0.07, beatInterval * 0.22),
        hard: Math.max(0.056, beatInterval * 0.18),
        expert: Math.max(0.046, beatInterval * 0.16),
    };
    const npsRange = SECTION_NPS_RANGE;
    const minGap = minGapByDiff[difficulty];

    const snapToGrid = (time: number): number => {
        const idx = lb(beatPositions, time);
        const lo = Math.max(0, idx - 2);
        const hi = Math.min(beatPositions.length - 1, idx + 2);
        const subdiv = difficulty === 'easy' ? [0, 0.5] : difficulty === 'normal' ? [0, 0.5] : [0, 0.25, 0.5, 0.75];
        let best = time;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = lo; i <= hi; i++) {
            const b = beatPositions[i];
            for (const s of subdiv) {
                const t = b + beatInterval * s;
                const d = Math.abs(t - time);
                if (d < bestDist) {
                    bestDist = d;
                    best = t;
                }
            }
        }
        return best;
    };

    const laneTimes: [number[], number[]] = [[], []];
    const nonTapTimes: number[] = [];
    for (let i = 0; i < result.length; i++) {
        const n = result[i];
        laneTimes[n.lane === 0 ? 0 : 1].push(n.time);
        if (n.type === 'slide' || n.type === 'hold') {
            nonTapTimes.push(n.time);
        }
    }
    const hasNearIn = (arr: readonly number[], time: number, window: number): boolean => {
        if (arr.length === 0) return false;
        const idx = lb(arr, time);
        if (idx < arr.length && Math.abs(arr[idx] - time) < window) return true;
        if (idx > 0 && Math.abs(arr[idx - 1] - time) < window) return true;
        return false;
    };
    const hasNear = (time: number, lane: number): boolean =>
        hasNearIn(laneTimes[lane === 0 ? 0 : 1], time, minGap)
        || hasNearIn(nonTapTimes, time, minGap * 0.74);
    const hasLongConflict = (time: number, lane: number): boolean =>
        laneLongWindows[lane === 0 ? 0 : 1].some(w => time > w.start + 0.04 && time < w.end - 0.04);
    const mark = (note: NoteData): void => {
        result.push(note);
        const idx = lb(existingTimes, note.time);
        existingTimes.splice(idx, 0, note.time);
        const laneArr = laneTimes[note.lane === 0 ? 0 : 1];
        const laneIdx = lb(laneArr, note.time);
        laneArr.splice(laneIdx, 0, note.time);
    };

    let laneSeed = result[result.length - 1]?.lane ?? 1;
    for (const sec of playable) {
        const secDur = Math.max(0.001, sec.endTime - sec.startTime);
        if (secDur < beatInterval * 1.5) continue;
        const i0 = lb(existingTimes, sec.startTime);
        const i1 = lb(existingTimes, sec.endTime);
        const existing = Math.max(0, i1 - i0);
        const range = npsRange[difficulty];
        const secEnergy = Math.max(0, Math.min(1, sec.avgEnergy || 0.5));
        const highlightBoost = (sec.type === 'drop' || sec.type === 'chorus') ? 1.45 : sec.type === 'bridge' ? 0.85 : 1;
        const typeKey = (sec.type === 'drop' || sec.type === 'chorus' || sec.type === 'bridge' || sec.type === 'verse')
            ? sec.type
            : 'verse';
        const typeBoost = Math.max(0.84, Math.min(1.32, typeFeedback?.[typeKey] ?? 1));
        const drive = Math.max(0, Math.min(1, songFeatures.driveScore));
        const calm = Math.max(0, Math.min(1, songFeatures.calmConfidence));
        const dynamic = Math.max(0, Math.min(1, songFeatures.dynamicRange));
        const targetNps = Math.max(
            range.min,
            Math.min(
                range.max,
                (range.min * 0.62 + range.max * 0.38)
                * (0.78 + secEnergy * 0.34 + dynamic * 0.12 + drive * 0.1 - calm * 0.08)
                * highlightBoost
                * typeBoost
                * Math.max(0.9, Math.min(1.22, aggressiveness))
            )
        );
        const targetCount = Math.max(1, Math.floor(targetNps * secDur));
        if (existing >= targetCount) continue;

        let missing = Math.min(
            Math.max(2, Math.floor(targetCount * 0.45)),
            targetCount - existing
        );
        const oi0 = lb(onsetTimeline, sec.startTime);
        const oi1 = lb(onsetTimeline, sec.endTime);
        const candidates = onsetPairs.slice(oi0, oi1)
            .filter(o => o.strength >= (difficulty === 'easy' ? 0.45 : difficulty === 'normal' ? 0.38 : 0.34))
            .sort((a, b) => b.strength - a.strength);
        if (candidates.length === 0) continue;

        for (const cand of candidates) {
            if (missing <= 0) break;
            const snapped = snapToGrid(cand.time);
            laneSeed = laneSeed === 0 ? 1 : 0;
            let lane = laneSeed;
            if (hasNear(snapped, lane) || hasLongConflict(snapped, lane)) {
                const alt = lane === 0 ? 1 : 0;
                if (hasNear(snapped, alt) || hasLongConflict(snapped, alt)) continue;
                lane = alt;
            }
            mark({
                time: snapped,
                lane,
                type: 'tap',
                strength: Math.max(0.42, Math.min(1, cand.strength * 0.84)),
            });
            missing--;
        }
    }

    const cleaned = dedupeNotes(result, 0.034);
    const collisionFree = resolveLongNoteCollisions(cleaned, bpm);
    return pruneImpossibleNestedNotes(collisionFree, bpm);
};

const countSparsePlayableSections = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    difficulty: Difficulty
): number => {
    const summary = computeSectionDensitySummary(notes, sections, difficulty);
    return summary.sparse;
};

const computeSectionDensitySummary = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    difficulty: Difficulty
): {
    sparse: number;
    dense: number;
    feedback: Partial<Record<'verse' | 'chorus' | 'drop' | 'bridge', number>>;
} => {
    const out: Partial<Record<'verse' | 'chorus' | 'drop' | 'bridge', number>> = {};
    if (notes.length === 0 || sections.length === 0) {
        return { sparse: 0, dense: 0, feedback: out };
    }
    const npsRange = SECTION_NPS_RANGE;
    const typeMul = (type: string): number => {
        if (type === 'drop') return 1.45;
        if (type === 'chorus') return 1.32;
        if (type === 'bridge') return 0.82;
        if (type === 'verse') return 0.94;
        return 0.5;
    };
    const range = npsRange[difficulty];
    const noteTimes = notes.map(n => n.time).sort((a, b) => a - b);
    const lb = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    let sparse = 0;
    let dense = 0;
    const perType: Record<'verse' | 'chorus' | 'drop' | 'bridge', { actual: number; target: number; count: number }> = {
        verse: { actual: 0, target: 0, count: 0 },
        chorus: { actual: 0, target: 0, count: 0 },
        drop: { actual: 0, target: 0, count: 0 },
        bridge: { actual: 0, target: 0, count: 0 },
    };
    for (const s of sections) {
        if (s.type === 'intro' || s.type === 'outro' || s.type === 'interlude') continue;
        const dur = Math.max(0.001, s.endTime - s.startTime);
        const cnt = Math.max(0, lb(noteTimes, s.endTime) - lb(noteTimes, s.startTime));
        const nps = cnt / dur;
        const low = range.min * typeMul(s.type);
        const high = range.max * typeMul(s.type);
        if (nps < low) sparse++;
        if (nps > high * 1.05) dense++;
        if (s.type === 'verse' || s.type === 'chorus' || s.type === 'drop' || s.type === 'bridge') {
            const target = ((range.min + range.max) * 0.5) * typeMul(s.type);
            const bucket = perType[s.type];
            bucket.actual += nps;
            bucket.target += target;
            bucket.count++;
        }
    }
    const types: Array<'verse' | 'chorus' | 'drop' | 'bridge'> = ['verse', 'chorus', 'drop', 'bridge'];
    for (let i = 0; i < types.length; i++) {
        const type = types[i];
        const bucket = perType[type];
        if (bucket.count === 0) continue;
        const actualAvg = bucket.actual / bucket.count;
        const targetAvg = bucket.target / bucket.count;
        const ratio = actualAvg / Math.max(0.001, targetAvg);
        out[type] = Math.max(0.86, Math.min(1.24, 1 + (1 - ratio) * 0.34));
    }
    return { sparse, dense, feedback: out };
};

const computeSectionTypeDensityFeedback = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    difficulty: Difficulty
): Partial<Record<'verse' | 'chorus' | 'drop' | 'bridge', number>> => {
    return computeSectionDensitySummary(notes, sections, difficulty).feedback;
};

const trimDensePlayableSections = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    difficulty: Difficulty
): NoteData[] => {
    if (notes.length === 0 || sections.length === 0) return [...notes];
    const npsRange = SECTION_NPS_RANGE;
    const typeMul = (type: string): number => {
        if (type === 'drop') return 1.45;
        if (type === 'chorus') return 1.32;
        if (type === 'bridge') return 0.82;
        if (type === 'verse') return 0.94;
        return 0.5;
    };
    const removeIdx = new Set<number>();
    const sorted = [...notes].sort((a, b) => a.time - b.time);
    const noteTimes = sorted.map(n => n.time);
    const lb = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    for (const sec of sections) {
        if (sec.type === 'intro' || sec.type === 'outro' || sec.type === 'interlude') continue;
        const secDur = Math.max(0.001, sec.endTime - sec.startTime);
        const startIdx = lb(noteTimes, sec.startTime);
        const endIdx = lb(noteTimes, sec.endTime);
        const secCount = Math.max(0, endIdx - startIdx);
        if (secCount === 0) continue;
        const nps = secCount / secDur;
        const high = npsRange[difficulty].max * typeMul(sec.type);
        if (nps <= high * 1.05) continue;
        const targetCount = Math.max(1, Math.floor(high * secDur));
        let needRemove = secCount - targetCount;
        if (needRemove <= 0) continue;
        const candidates: number[] = [];
        for (let i = startIdx; i < endIdx; i++) {
            if (sorted[i].type === 'tap') candidates.push(i);
        }
        candidates.sort((a, b) => {
            const sa = sorted[a].strength ?? 0.5;
            const sb = sorted[b].strength ?? 0.5;
            return sa - sb || sorted[a].time - sorted[b].time;
        });
        for (const i of candidates) {
            if (needRemove <= 0) break;
            removeIdx.add(i);
            needRemove--;
        }
    }
    if (removeIdx.size === 0) return sorted;
    return dedupeNotes(sorted.filter((_, i) => !removeIdx.has(i)), 0.034);
};

const countDensePlayableSections = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    difficulty: Difficulty
): number => {
    return computeSectionDensitySummary(notes, sections, difficulty).dense;
};

const rebalanceSlideTapMix = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    if (notes.length === 0 || sections.length === 0 || bpm <= 0) return [...notes];
    const beatInterval = 60 / Math.max(1, bpm);
    const sorted = [...notes].sort((a, b) => a.time - b.time).map(n => ({ ...n }));
    const noteTimes = sorted.map(n => n.time);
    const lb = (arr: readonly number[], target: number): number => {
        let lo = 0;
        let hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const longTimesByLane: [number[], number[]] = [[], []];
    for (let i = 0; i < sorted.length; i++) {
        const n = sorted[i];
        if (n.type === 'slide' || n.type === 'hold') {
            const laneIdx = n.lane === 0 ? 0 : 1;
            longTimesByLane[laneIdx].push(n.time);
        }
    }
    const hasNearLongOnLane = (time: number, lane: number, window: number): boolean => {
        const arr = longTimesByLane[lane === 0 ? 0 : 1];
        if (arr.length === 0) return false;
        const idx = lb(arr, time);
        if (idx < arr.length && Math.abs(arr[idx] - time) < window) return true;
        if (idx > 0 && Math.abs(arr[idx - 1] - time) < window) return true;
        return false;
    };
    const removeLongOnLane = (time: number, lane: number): void => {
        const arr = longTimesByLane[lane === 0 ? 0 : 1];
        const idx = lb(arr, time);
        if (idx < arr.length && Math.abs(arr[idx] - time) < 1e-6) {
            arr.splice(idx, 1);
            return;
        }
        if (idx > 0 && Math.abs(arr[idx - 1] - time) < 1e-6) {
            arr.splice(idx - 1, 1);
        }
    };
    const addLongOnLane = (time: number, lane: number): void => {
        const arr = longTimesByLane[lane === 0 ? 0 : 1];
        const idx = lb(arr, time);
        arr.splice(idx, 0, time);
    };
    const typeBias = (type: string): number => {
        if (type === 'drop' || type === 'chorus') return -0.04;
        if (type === 'bridge') return 0.08;
        if (type === 'verse') return 0.04;
        return 0;
    };
    const baseDesired = Math.max(
        0.06,
        Math.min(0.32, 0.1 + songFeatures.sustainedFocus * 0.2 - songFeatures.percussiveFocus * 0.14)
    );
    for (const sec of sections) {
        if (sec.type === 'intro' || sec.type === 'outro' || sec.type === 'interlude') continue;
        const idx: number[] = [];
        const startIdx = lb(noteTimes, sec.startTime);
        const endIdx = lb(noteTimes, sec.endTime);
        for (let i = startIdx; i < endIdx; i++) idx.push(i);
        if (idx.length < 4) continue;
        const slideIdx = idx.filter(i => sorted[i].type === 'slide');
        const tapIdx = idx.filter(i => sorted[i].type === 'tap');
        const desired = Math.max(0.05, Math.min(0.32, baseDesired + typeBias(sec.type)));
        const current = slideIdx.length / Math.max(1, idx.length);

        // 과다 슬라이드는 약한 직선 슬라이드부터 탭으로 감산.
        if (current > desired + 0.09 && slideIdx.length > 0) {
            let need = Math.min(slideIdx.length, Math.ceil((current - desired) * idx.length * 0.72));
            const demote = slideIdx
                .filter(i => resolveSlideTargetLane(sorted[i]) === sorted[i].lane)
                .sort((a, b) => (sorted[a].strength ?? 0.5) - (sorted[b].strength ?? 0.5));
            for (const i of demote) {
                if (need <= 0) break;
                const before = sorted[i];
                sorted[i] = {
                    time: before.time,
                    lane: before.lane,
                    type: 'tap',
                    strength: Math.max(0.42, (before.strength ?? 0.5) * 0.92),
                };
                removeLongOnLane(before.time, before.lane);
                need--;
            }
        }

        // 슬라이드 부족 구간은 탭 일부를 짧은 직선 슬라이드로 승격.
        if (current < desired - 0.08 && tapIdx.length >= 3) {
            let need = Math.min(tapIdx.length, Math.ceil((desired - current) * idx.length * (difficulty === 'easy' ? 0.45 : 0.65)));
            const promote = tapIdx
                .slice()
                .sort((a, b) => (sorted[b].strength ?? 0.5) - (sorted[a].strength ?? 0.5));
            for (const i of promote) {
                if (need <= 0) break;
                const n = sorted[i];
                const nearLong = hasNearLongOnLane(n.time, n.lane, beatInterval * 0.66);
                if (nearLong) continue;
                sorted[i] = {
                    ...n,
                    type: 'slide',
                    targetLane: n.lane,
                    duration: Math.max(MIN_SLIDE_DURATION_SEC, beatInterval * (difficulty === 'easy' ? 0.84 : 1.04)),
                    strength: Math.max(0.5, (n.strength ?? 0.5) * 0.96),
                };
                addLongOnLane(n.time, n.lane);
                need--;
            }
        }
    }
    return dedupeNotes(resolveLongNoteCollisions(sorted, bpm), 0.034);
};

const runHolisticBalanceLoop = (
    notes: readonly NoteData[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    beatPositions: readonly number[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number,
    difficulty: Difficulty,
    songFeatures: BeatMapSongFeatures
): NoteData[] => {
    let out = [...notes];
    let best = [...notes];
    let bestPenalty = computeHolisticBalancePenalty(best, sections, difficulty);
    const runtime = getRuntimePerfProfile();
    const maxPass = runtime.tier === 'low' ? 1 : 2;
    const passTiming: Array<{ pass: number; beforeSparse: number; beforeDense: number; afterSparse: number; afterDense: number; ms: number }> = [];
    for (let pass = 0; pass < maxPass; pass++) {
        const passStart = performance.now();
        const summary = computeSectionDensitySummary(out, sections, difficulty);
        const sparse = summary.sparse;
        const dense = summary.dense;
        if (pass === 0 && sparse === 0 && dense === 0) {
            break;
        }
        const feedback = summary.feedback;
        const aggression = Math.max(0.94, Math.min(1.22, 1 + sparse * 0.05 - dense * 0.03));

        out = rebalanceSectionDensityByDifficulty(
            out,
            onsetTimes,
            onsetStrengths,
            beatPositions,
            sections,
            bpm,
            difficulty,
            songFeatures,
            aggression,
            feedback
        );

        if (dense > 0) {
            out = trimDensePlayableSections(out, sections, difficulty);
        }

        if (pass === 0) {
            out = ensureMinimumDensity(
                out,
                beatPositions,
                sections,
                bpm,
                difficulty,
                songFeatures
            );
        }
        out = rebalanceSlideTapMix(out, sections, bpm, difficulty, songFeatures);
        out = pruneImpossibleNestedNotes(resolveLongNoteCollisions(out, bpm), bpm);

        const summaryAfter = computeSectionDensitySummary(out, sections, difficulty);
        const sparseAfter = summaryAfter.sparse;
        const denseAfter = summaryAfter.dense;
        passTiming.push({
            pass,
            beforeSparse: sparse,
            beforeDense: dense,
            afterSparse: sparseAfter,
            afterDense: denseAfter,
            ms: performance.now() - passStart,
        });
        const penalty = computeHolisticBalancePenalty(out, sections, difficulty);
        if (penalty < bestPenalty) {
            bestPenalty = penalty;
            best = [...out];
        }
        if (sparseAfter === 0 && denseAfter === 0) break;
        if (pass >= 1 && sparseAfter <= 1 && denseAfter <= 1) break;
    }
    if (passTiming.length > 0) {
        mapgenLog('[MapGen][holistic-pass]', passTiming.map(p => ({
            pass: p.pass,
            before: `${p.beforeSparse}/${p.beforeDense}`,
            after: `${p.afterSparse}/${p.afterDense}`,
            ms: Math.round(p.ms),
        })));
    }
    return best;
};

const computeHolisticBalancePenalty = (
    notes: readonly NoteData[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    difficulty: Difficulty
): number => {
    const summary = computeSectionDensitySummary(notes, sections, difficulty);
    const sparse = summary.sparse;
    const dense = summary.dense;
    const feedback = summary.feedback;
    const typeDrift = (['verse', 'chorus', 'drop', 'bridge'] as const).reduce((acc, t) => {
        const v = feedback[t] ?? 1;
        return acc + Math.abs(1 - v);
    }, 0);
    let slideCount = 0;
    let tapCount = 0;
    for (let i = 0; i < notes.length; i++) {
        const type = notes[i].type;
        if (type === 'slide') slideCount++;
        if (type === 'tap') tapCount++;
    }
    const slideRatio = slideCount / Math.max(1, notes.length);
    const tapRatio = tapCount / Math.max(1, notes.length);
    const mixPenalty = Math.max(0, slideRatio - 0.58) * 1.4 + Math.max(0, 0.32 - tapRatio) * 1.2;
    return sparse * 3 + dense * 2.2 + typeDrift * 4.5 + mixPenalty;
};

type RuntimePerfTier = 'low' | 'mid' | 'high';
interface RuntimePerfProfile {
    readonly tier: RuntimePerfTier;
    readonly cores: number;
    readonly memoryGb: number;
    readonly score: number;
    readonly qualityBias: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const avg = (values: readonly number[], fallback = 0): number => {
    if (values.length === 0) return fallback;
    return values.reduce((acc, v) => acc + v, 0) / values.length;
};

const variance = (values: readonly number[], fallback = 0): number => {
    if (values.length === 0) return fallback;
    const m = avg(values, fallback);
    return values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / values.length;
};

const getRuntimePerfProfile = (): RuntimePerfProfile => {
    const computeQualityBias = (cores: number, memoryGb: number): number =>
        clamp01(
            Math.max(0, (cores - 4) / 10) * 0.7
            + Math.max(0, (memoryGb - 4) / 16) * 0.3
            + (cores >= 8 ? 0.12 : 0)
        );
    const buildProfile = (coresRaw: number, memoryRaw: number): RuntimePerfProfile => {
        const cores = Math.max(2, Math.floor(coresRaw || 4));
        const memoryGb = Math.max(2, Math.floor(memoryRaw || 4));
        const score = cores + memoryGb * 0.68 + (cores >= 8 ? 1.0 : 0);
        const qualityBias = computeQualityBias(cores, memoryGb);
        const tier: RuntimePerfTier = score >= 10.5
            ? 'high'
            : score >= 6.8
                ? 'mid'
                : 'low';
        return { tier, cores, memoryGb, score, qualityBias };
    };
    const hinted = (globalThis as { __MAPGEN_PERF_HINT?: { cores?: number; memoryGb?: number } }).__MAPGEN_PERF_HINT;
    if (hinted && Number.isFinite(hinted.cores) && Number.isFinite(hinted.memoryGb)) {
        return buildProfile(hinted.cores || 4, hinted.memoryGb || 4);
    }
    if (typeof navigator === 'undefined') {
        return buildProfile(4, 4);
    }
    const nav = navigator as Navigator & { deviceMemory?: number };
    const cores = Math.max(2, nav.hardwareConcurrency || 4);
    const memoryFallback = Math.max(4, Math.round(cores * 0.9));
    const memoryGb = Number.isFinite(nav.deviceMemory) ? (nav.deviceMemory as number) : memoryFallback;
    return buildProfile(cores, memoryGb);
};

const summarizeSongFeatures = (
    onsetResult: OnsetResult,
    spectralProfiles: readonly SpectralProfile[],
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    bpm: number
): BeatMapSongFeatures => {
    const lowCount = onsetResult.lowOnsets.length;
    const midCount = onsetResult.midOnsets.length;
    const highCount = onsetResult.highOnsets.length;
    const totalCount = Math.max(1, lowCount + midCount + highCount);
    const lowShare = lowCount / totalCount;
    const midShare = midCount / totalCount;
    const highShare = highCount / totalCount;

    const avgBrightness = avg(spectralProfiles.map(p => p.brightness), 0.5);
    const avgTransient = avg(spectralProfiles.map(p => p.transient), 0.35);
    const avgTonal = avg(spectralProfiles.map(p => p.tonal), 0.5);
    const avgPercussive = avg(spectralProfiles.map(p => p.percussive), 0.45);
    const avgLowRatio = avg(spectralProfiles.map(p => {
        const total = Math.max(1e-6, p.low + p.mid + p.high);
        return p.low / total;
    }), 0.33);
    const energyVar = variance(sections.map(s => s.avgEnergy || 0.5), 0.02);
    const energyVarNorm = clamp01(energyVar / 0.12);
    const minEnergy = sections.reduce((m, s) => Math.min(m, s.avgEnergy || 0.5), 1);
    const maxEnergy = sections.reduce((m, s) => Math.max(m, s.avgEnergy || 0.5), 0);
    const dynamicRange = clamp01((maxEnergy - minEnergy) / 0.78);
    const bpmNorm = clamp01((bpm - 95) / 95);
    const trackDuration = sections.length > 0 ? sections[sections.length - 1].endTime : 0;
    const introWindow = Math.min(12, Math.max(4, trackDuration * 0.16));
    let introWeightedCount = 0;
    let introStrongCount = 0;
    let introSampleCount = 0;
    for (let i = 0; i < onsetResult.onsets.length; i++) {
        const t = onsetResult.onsets[i];
        if (t < 0 || t > introWindow) continue;
        introSampleCount++;
        const s = onsetResult.strengths[i] ?? 0.5;
        introWeightedCount += clamp01((s - 0.24) / 0.76);
        if (s >= 0.66) introStrongCount++;
    }
    const introDensity = introWeightedCount / Math.max(1, introWindow);
    const introStrongDensity = introStrongCount / Math.max(1, introWindow);
    const beatPerSec = Math.max(1.2, bpm / 60);
    const introQuietFromDensity = clamp01((beatPerSec * 0.82 - introDensity) / (beatPerSec * 0.82));
    const introQuietFromStrong = clamp01((beatPerSec * 0.26 - introStrongDensity) / (beatPerSec * 0.26));
    const introQuietFromSparsity = clamp01(1 - introSampleCount / Math.max(8, introWindow * beatPerSec * 1.35));
    const introQuietness = clamp01(
        introQuietFromDensity * 0.58
        + introQuietFromStrong * 0.26
        + introQuietFromSparsity * 0.16
    );
    const introProfiles = spectralProfiles.filter(p => p.time >= 0 && p.time <= introWindow + 0.2);
    const introTransient = avg(introProfiles.map(p => p.transient), avgTransient);
    const introPercussive = avg(introProfiles.map(p => p.percussive), avgPercussive);
    const introTonal = avg(introProfiles.map(p => p.tonal), avgTonal);
    const earlyCut = Math.min(Math.max(6, trackDuration * 0.22), 14);
    const earlySections = sections.filter(s => s.startTime < earlyCut);
    const lateSections = sections.filter(s => s.startTime >= Math.max(earlyCut, trackDuration * 0.38));
    const earlyEnergy = avg(earlySections.map(s => s.avgEnergy || 0.5), 0.5);
    const lateEnergy = avg(lateSections.map(s => s.avgEnergy || 0.5), 0.5);
    const highlightLift = clamp01((lateEnergy - earlyEnergy) / 0.34);

    const percussiveFocus = clamp01(
        highShare * 0.32
        + midShare * 0.08
        + avgTransient * 0.24
        + avgPercussive * 0.28
        + introPercussive * 0.04
        + bpmNorm * 0.08
    );
    const melodicFocus = clamp01(
        midShare * 0.33
        + (1 - highShare) * 0.12
        + avgTonal * 0.33
        + (1 - avgPercussive) * 0.12
        + (1 - bpmNorm) * 0.1
    );
    const bassWeight = clamp01(lowShare * 0.56 + avgLowRatio * 0.34 + (1 - avgBrightness) * 0.1);
    const driveScore = clamp01(
        bpmNorm * 0.24
        + avgBrightness * 0.18
        + percussiveFocus * 0.26
        + energyVarNorm * 0.18
        + highShare * 0.1
        + highlightLift * 0.04
    );
    const sustainedFocus = clamp01(
        avgTonal * 0.48
        + (1 - avgTransient) * 0.26
        + (1 - avgPercussive) * 0.18
        + midShare * 0.08
    );
    const calmConfidence = clamp01(
        melodicFocus * 0.18
        + sustainedFocus * 0.24
        + introQuietness * 0.18
        + (1 - driveScore) * 0.16
        + (1 - percussiveFocus) * 0.12
        + (1 - introTransient) * 0.06
        + (1 - introPercussive) * 0.04
        + introTonal * 0.04
        - dynamicRange * 0.06
    );
    const slideAffinity = clamp01(
        0.34
        + driveScore * 0.16
        + sustainedFocus * 0.42
        + melodicFocus * 0.08
        - bassWeight * 0.12
        - percussiveFocus * 0.24
    );
    const transients = spectralProfiles.map(p => p.transient);
    const transientVariance = clamp01(variance(transients, 0.02) / 0.08);
    const sharpnessScore = clamp01(
        avgTransient * 0.34
        + percussiveFocus * 0.24
        + dynamicRange * 0.16
        + transientVariance * 0.16
        + highlightLift * 0.1
    );

    return {
        percussiveFocus,
        melodicFocus,
        bassWeight,
        driveScore,
        slideAffinity,
        sustainedFocus,
        calmConfidence,
        introQuietness,
        dynamicRange,
        sharpnessScore,
    };
};

const selectVisualTheme = (
    bpm: number,
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    spectralProfiles: readonly { time: number; brightness: number; percussive?: number; transient?: number; tonal?: number }[],
    songFeatures?: BeatMapSongFeatures
): VisualTheme => {
    const avgEnergy = sections.length > 0
        ? sections.reduce((acc, s) => acc + (s.avgEnergy || 0.5), 0) / sections.length
        : 0.5;
    const peakEnergy = sections.reduce((mx, s) => Math.max(mx, s.avgEnergy || 0), 0);
    const energyVariance = sections.length > 0
        ? sections.reduce((acc, s) => acc + Math.pow((s.avgEnergy || avgEnergy) - avgEnergy, 2), 0) / sections.length
        : 0;
    const avgBrightness = spectralProfiles.length > 0
        ? spectralProfiles.reduce((acc, s) => acc + (s.brightness || 0.5), 0) / spectralProfiles.length
        : 0.5;
    const introWindow = Math.min(14, Math.max(6, (sections[sections.length - 1]?.endTime ?? 0) * 0.2));
    const introProfiles = spectralProfiles.filter(p => p.time >= 0 && p.time <= introWindow + 0.25);
    const introPercussive = avg(introProfiles.map(p => p.percussive ?? 0.5), 0.5);
    const introTransient = avg(introProfiles.map(p => p.transient ?? 0.5), 0.5);
    const introTonal = avg(introProfiles.map(p => p.tonal ?? 0.5), 0.5);
    const energeticSectionRatio = sections.length > 0
        ? sections.filter(s => s.type === 'drop' || s.type === 'chorus' || (s.avgEnergy || 0) >= 0.74).length / sections.length
        : 0;
    const drive = songFeatures?.driveScore ?? clamp01((bpm - 105) / 95);
    const melodic = songFeatures?.melodicFocus ?? 0.5;
    const percussive = songFeatures?.percussiveFocus ?? 0.5;
    const bass = songFeatures?.bassWeight ?? 0.5;
    const sustained = songFeatures?.sustainedFocus ?? 0.5;
    const dynamicRange = songFeatures?.dynamicRange ?? clamp01(energyVariance * 4.2);
    const sharpness = songFeatures?.sharpnessScore
        ?? clamp01(introTransient * 0.4 + percussive * 0.3 + dynamicRange * 0.3);
    const calmConfidence = songFeatures?.calmConfidence ?? 0.5;
    const introQuiet = songFeatures?.introQuietness ?? 0.5;
    const bpmNorm = clamp01((bpm - 92) / 104);
    const calmScore = clamp01(calmConfidence * 0.5 + introQuiet * 0.28 + sustained * 0.22);
    const intensity = clamp01(
        drive * 0.32
        + percussive * 0.24
        + energeticSectionRatio * 0.14
        + dynamicRange * 0.12
        + sharpness * 0.1
        + peakEnergy * 0.1
        + bpmNorm * 0.05
        + (1 - calmConfidence) * 0.05
    );
    const calmness = clamp01(
        calmConfidence * 0.34
        + introQuiet * 0.24
        + sustained * 0.18
        + melodic * 0.12
        + (1 - percussive) * 0.12
    );
    const warmth = clamp01(
        avgBrightness * 0.3
        + introTonal * 0.18
        + melodic * 0.16
        + calmScore * 0.14
        + (1 - bass) * 0.1
        + (1 - percussive) * 0.12
    );
    const phonkLike = clamp01(
        bass * 0.34
        + percussive * 0.28
        + drive * 0.14
        + sharpness * 0.16
        + dynamicRange * 0.1
        + energeticSectionRatio * 0.08
    );
    const introPunch = clamp01(introPercussive * 0.52 + introTransient * 0.48);
    const cityBias = clamp01(phonkLike * 0.58 + introPunch * 0.22 + sharpness * 0.12 + bpmNorm * 0.08);

    // === 장르별 하드 룰 ===
    // 퐁크/메탈/EDM/J-POP 등 공격적인 곡 → nightCity
    const hardCity = cityBias >= 0.58 || (
        intensity >= 0.74
        && (percussive >= 0.6 || bpm >= 144 || energeticSectionRatio >= 0.38 || bass >= 0.66)
        && calmness < 0.58
        && introQuiet < 0.66
    ) || (
        phonkLike >= 0.6
        && bass >= 0.62
        && percussive >= 0.58
        && dynamicRange >= 0.42
    );
    if (hardCity) {
        return 'nightCity';
    }
    // 차분한 발라드/어쿠스틱 → meadow (숲)
    // 여운이 남는 감성적인 곡 → sunset
    const hardCalm = calmness >= 0.68
        && percussive <= 0.54
        && energeticSectionRatio <= 0.30
        && sharpness <= 0.52
        && intensity <= 0.52;
    if (hardCalm) {
        // 밝고 따뜻한 곡 = sunset (노을 감성), 어둡고 조용한 곡 = meadow (숲)
        const isSunsetMood = warmth >= 0.55
            || avgBrightness >= 0.58
            || (melodic >= 0.6 && sustained >= 0.55);
        return isSunsetMood ? 'sunset' : 'meadow';
    }

    let cityScore = clamp01(
        intensity * 0.66
        + percussive * 0.12
        + drive * 0.08
        + dynamicRange * 0.07
        + (avgBrightness >= 0.56 ? 0.02 : 0)
    );
    let meadowScore = clamp01(
        calmness * 0.62
        + (1 - intensity) * 0.16
        + sustained * 0.1
        + (1 - avgBrightness) * 0.12
    );
    let sunsetScore = clamp01(
        warmth * 0.54
        + calmness * 0.18
        + avgBrightness * 0.12
        + melodic * 0.08
        + (1 - intensity) * 0.08
    );

    // 보정: 차분한 곡은 city 점수 대폭 감소
    cityScore -= clamp01((calmness - 0.58) / 0.42) * 0.3;
    // 보정: 강렬한 곡은 meadow 점수 감소
    meadowScore -= clamp01((intensity - 0.55) / 0.45) * 0.28;
    // 보정: 밝은 스펙트럼 + 멜로디 곡은 sunset 소폭 증가
    sunsetScore += clamp01((avgBrightness - 0.5) / 0.3) * 0.06;
    sunsetScore += clamp01((melodic - 0.55) / 0.45) * 0.05;
    // 보정: bass-heavy/percussive 곡은 city 증가
    cityScore += clamp01((cityBias - 0.45) / 0.55) * 0.18;
    meadowScore -= clamp01((cityBias - 0.5) / 0.5) * 0.26;

    if (cityScore > meadowScore + 0.08 && cityScore > sunsetScore + 0.06) {
        return 'nightCity';
    }
    if (meadowScore > sunsetScore + 0.02) {
        return 'meadow';
    }
    return 'sunset';
};

const enforceVisualThemeConsistency = (
    baseTheme: VisualTheme,
    notes: readonly NoteData[],
    duration: number,
    bpm: number,
    sections: readonly { startTime: number; endTime: number; type: string; avgEnergy: number }[],
    songFeatures: BeatMapSongFeatures
): VisualTheme => {
    if (notes.length === 0 || duration <= 0) return baseTheme;
    const nps = notes.length / Math.max(1, duration);
    const strongRatio = notes.filter(n => (n.strength ?? 0.5) >= 0.68).length / Math.max(1, notes.length);
    const slideRatio = notes.filter(n => n.type === 'slide').length / Math.max(1, notes.length);
    const burstRatio = notes.filter(n => n.type === 'burst').length / Math.max(1, notes.length);
    const avgSectionEnergy = sections.length > 0
        ? sections.reduce((acc, s) => acc + (s.avgEnergy || 0.5), 0) / sections.length
        : 0.5;
    const peakSectionEnergy = sections.reduce((mx, s) => Math.max(mx, s.avgEnergy || 0.5), 0.5);
    const energeticSectionRatio = sections.length > 0
        ? sections.filter(s => s.type === 'drop' || s.type === 'chorus' || (s.avgEnergy || 0.5) >= 0.74).length / sections.length
        : 0;
    const calmSectionRatio = sections.length > 0
        ? sections.filter(s => s.type === 'bridge' || s.type === 'verse' || (s.avgEnergy || 0.5) <= 0.56).length / sections.length
        : 0.5;

    const mapDrive = clamp01(
        (songFeatures.driveScore * 0.34)
        + (songFeatures.percussiveFocus * 0.22)
        + (songFeatures.bassWeight * 0.14)
        + (songFeatures.sharpnessScore * 0.08)
        + (strongRatio * 0.12)
        + (slideRatio * 0.06)
        + (burstRatio * 0.04)
        + (energeticSectionRatio * 0.08)
    );
    const phonkLike = clamp01(
        songFeatures.bassWeight * 0.3
        + songFeatures.percussiveFocus * 0.26
        + songFeatures.driveScore * 0.16
        + songFeatures.sharpnessScore * 0.16
        + strongRatio * 0.12
        + energeticSectionRatio * 0.08
    );
    const calmLike = clamp01(
        songFeatures.calmConfidence * 0.42
        + songFeatures.introQuietness * 0.26
        + songFeatures.sustainedFocus * 0.18
        + calmSectionRatio * 0.14
    );

    const forceCity = (
        (phonkLike >= 0.6 && bpm >= 108 && (nps >= 2.0 || energeticSectionRatio >= 0.24))
        || (songFeatures.sharpnessScore >= 0.62 && songFeatures.percussiveFocus >= 0.56 && bpm >= 104 && nps >= 1.9)
        || (mapDrive >= 0.66 && nps >= 2.7 && (strongRatio >= 0.26 || energeticSectionRatio >= 0.26))
        || (peakSectionEnergy >= 0.82 && avgSectionEnergy >= 0.62 && bpm >= 128 && nps >= 2.35)
        || (songFeatures.percussiveFocus >= 0.62 && songFeatures.bassWeight >= 0.58 && energeticSectionRatio >= 0.3 && bpm >= 126)
    ) && calmLike < 0.68;
    if (forceCity) {
        return 'nightCity';
    }

    const forceCalm = calmLike >= 0.66
        && mapDrive <= 0.62
        && energeticSectionRatio <= 0.4
        && nps <= 2.4
        && bpm <= 132;
    if (forceCalm) {
        return songFeatures.introQuietness >= 0.62 ? 'meadow' : 'sunset';
    }

    if (baseTheme === 'meadow') {
        const meadowMismatch = phonkLike >= 0.62
            || mapDrive >= 0.68
            || nps >= 3.0
            || (bpm >= 138 && nps >= 2.7)
            || energeticSectionRatio >= 0.34
            || peakSectionEnergy >= 0.82;
        if (meadowMismatch) {
            return (songFeatures.percussiveFocus >= 0.62 || phonkLike >= 0.64 || energeticSectionRatio >= 0.34)
                ? 'nightCity'
                : 'sunset';
        }
    }
    if (baseTheme === 'nightCity') {
        const cityMismatch = calmLike >= 0.72
            && mapDrive <= 0.56
            && nps <= 2.4
            && phonkLike < 0.58
            && songFeatures.sharpnessScore < 0.5;
        if (cityMismatch) {
            return songFeatures.introQuietness >= 0.58 ? 'meadow' : 'sunset';
        }
    }
    return baseTheme;
};

const detHash = (v: number): number => {
    let x = v | 0;
    x = ((x >>> 16) ^ x) * 0x45d9f3b;
    x = ((x >>> 16) ^ x) * 0x45d9f3b;
    x = (x >>> 16) ^ x;
    return Math.abs(x);
};

/** 메인 스레드 양보 (UI 업데이트 허용) */
const yieldToMain = (): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, 0));
