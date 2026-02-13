import type { NoteData, SectionInfo, SectionType } from './MapData';
import type { SpectralProfile } from '../audio/SpectralAnalyzer';
import { NOTE_TYPE_TAP, NOTE_TYPE_HOLD, NOTE_TYPE_SLIDE, LANE_TOP, LANE_BOTTOM } from '../utils/Constants';


export interface BeatMapSongFeatures {
    readonly percussiveFocus: number;
    readonly melodicFocus: number;
    readonly bassWeight: number;
    readonly driveScore: number;
    readonly slideAffinity: number;
    readonly sustainedFocus: number;
    readonly calmConfidence: number;
    readonly introQuietness: number;
    readonly dynamicRange: number;
    readonly sharpnessScore: number;
}

export const mapBeatsToNotes = (
    beatPositions: readonly number[],
    sections: readonly SectionInfo[],
    spectralProfiles: readonly SpectralProfile[],
    onsetTimes: readonly number[],
    onsetStrengths: readonly number[],
    lowOnsets: readonly number[],
    midOnsets: readonly number[],
    highOnsets: readonly number[],
    lowStrengths: readonly number[],
    midStrengths: readonly number[],
    highStrengths: readonly number[],
    bpm: number,
    songFeatures?: BeatMapSongFeatures
): readonly NoteData[] => {
    const beatInterval = 60 / bpm;
    const halfBeat = beatInterval / 2;
    const getSpectrum = buildSpectralLookup(spectralProfiles);
    const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
    const features: BeatMapSongFeatures = songFeatures ?? {
        percussiveFocus: 0.5,
        melodicFocus: 0.5,
        bassWeight: 0.5,
        driveScore: 0.5,
        slideAffinity: 0.5,
        sustainedFocus: 0.5,
        calmConfidence: 0.5,
        introQuietness: 0.5,
        dynamicRange: 0.5,
        sharpnessScore: 0.5,
    };
    const energeticLiftBase = clamp01(features.driveScore * 0.58 + features.percussiveFocus * 0.42 - 0.5);

    // === Layer 5: 구간별 대역 가중치 (어떤 소리를 따라갈 것인가) ===
    // 기본 구간별 가중치 + songFeatures로 곡 특성 보정
    // percussiveFocus 높으면 → 드럼(low+high) 가중 증가
    // melodicFocus 높으면 → 보컬(mid) 가중 증가
    // bassWeight 높으면 → 베이스(low) 가중 증가
    const getSectionBandWeights = (sectionType: SectionType): { low: number; mid: number; high: number } => {
        // 1) 구간별 베이스 가중치
        let low: number, mid: number, high: number;
        switch (sectionType) {
            case 'verse':
                low = 0.25; mid = 0.64; high = 0.11; break;
            case 'chorus':
                low = 0.40; mid = 0.20; high = 0.40; break;
            case 'drop':
                low = 0.45; mid = 0.15; high = 0.40; break;
            case 'bridge':
                low = 0.12; mid = 0.76; high = 0.12; break;
            case 'intro':
                low = 0.20; mid = 0.60; high = 0.20; break;
            case 'outro':
                low = 0.25; mid = 0.50; high = 0.25; break;
            default:
                low = 0.33; mid = 0.34; high = 0.33; break;
        }
        // 2) songFeatures로 곡 특성 보정 (±0.12 범위)
        // 퍼커시브한 곡 → 드럼 대역(low+high) 강화, 멜로디 약화
        const percShift = (features.percussiveFocus - 0.5) * 0.24;
        low += percShift * 0.5;
        high += percShift * 0.5;
        mid -= percShift;
        // 멜로디 곡 → mid 강화
        const melShift = (features.melodicFocus - 0.5) * 0.20;
        mid += melShift;
        low -= melShift * 0.5;
        high -= melShift * 0.5;
        // 베이스 무거운 곡 → low 강화
        const bassShift = (features.bassWeight - 0.5) * 0.16;
        low += bassShift;
        mid -= bassShift * 0.5;
        high -= bassShift * 0.5;
        // 3) 정규화 (합 = 1.0, 최소 0.05)
        low = Math.max(0.05, low);
        mid = Math.max(0.05, mid);
        high = Math.max(0.05, high);
        const sum = low + mid + high;
        return { low: low / sum, mid: mid / sum, high: high / sum };
    };

    // === 1. onset 인덱스 구축 (빠른 탐색용) ===
    // onset을 시간순 정렬하고 대역별 태깅
    const onsetIndex: { time: number; type: number; strength: number }[] = [];
    const legacyPairs = onsetTimes
        .map((time, idx) => ({ time, strength: clamp01(onsetStrengths[idx] ?? 0.5) }))
        .sort((a, b) => a.time - b.time);
    const legacyTimes = legacyPairs.map(p => p.time);
    const legacyStrengthArr = legacyPairs.map(p => p.strength);
    const getNearestLegacyStrength = (time: number, fallback: number): number => {
        if (legacyTimes.length === 0) return fallback;
        let lo = 0;
        let hi = legacyTimes.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (legacyTimes[mid] < time) lo = mid + 1;
            else hi = mid - 1;
        }
        let bestIdx = Math.max(0, Math.min(legacyTimes.length - 1, lo));
        let bestDist = Math.abs(legacyTimes[bestIdx] - time);
        if (bestIdx > 0) {
            const leftDist = Math.abs(legacyTimes[bestIdx - 1] - time);
            if (leftDist < bestDist) {
                bestIdx -= 1;
                bestDist = leftDist;
            }
        }
        if (bestIdx + 1 < legacyTimes.length) {
            const rightDist = Math.abs(legacyTimes[bestIdx + 1] - time);
            if (rightDist < bestDist) {
                bestIdx += 1;
                bestDist = rightDist;
            }
        }
        if (bestDist > 0.1) return fallback;
        return legacyStrengthArr[bestIdx] ?? fallback;
    };

    // 멀티밴드 onset 등록 (type: 0=Low/Kick, 1=Mid/Vocal, 2=High/Snare+HiHat)
    const addOnsets = (
        times: readonly number[],
        strengths: readonly number[],
        type: number,
        baseStrength: number
    ) => {
        for (let i = 0; i < times.length; i++) {
            const t = times[i];
            const strength = clamp01(
                strengths[i]
                ?? getNearestLegacyStrength(t, baseStrength)
            );
            onsetIndex.push({ time: t, type, strength });
        }
    };

    addOnsets(lowOnsets, lowStrengths, 0, 0.72);
    addOnsets(midOnsets, midStrengths, 1, 0.56);
    addOnsets(highOnsets, highStrengths, 2, 0.63);

    // 레거시 폴백
    if (onsetIndex.length === 0 && onsetTimes.length > 0) {
        onsetTimes.forEach((t, i) => {
            const s = onsetStrengths[i] || 0.5;
            const type = s > 0.85 ? 0 : s > 0.7 ? 2 : 1;
            onsetIndex.push({ time: t, type, strength: s });
        });
    }

    onsetIndex.sort((a, b) => a.time - b.time);

    // === 2. 비트 그리드 기반 노트 배치 ===

    const getDensity = (time: number) => {
        const sec = findSection(sections, time);
    if (sec.type === 'interlude') return 0.0;
        if (sec.type === 'intro') return 0.18;
        if (sec.type === 'outro') return 0.22;
        const base = sec.type === 'drop'
            ? 1.0
            : sec.type === 'chorus'
                ? 0.92
                : sec.type === 'verse'
                    ? 0.6
                    : sec.type === 'bridge'
                        ? 0.42
                        : 0.52;
        return clamp01(base);
    };

    // === Layer 5 핵심: 구간별 대역 가중치를 적용한 onset 선택 ===
    const findNearbyOnset = (
        beatTime: number,
        window: number,
        isDownbeat: boolean
    ) => {
        let best: typeof onsetIndex[0] | null = null;
        let bestDist = Infinity;
        let bestScore = -Infinity;

        // 현재 섹션의 대역 가중치 가져오기
        const section = findSection(sections, beatTime);
        const bandWeights = getSectionBandWeights(section.type);

        // 이진 탐색으로 근처 onset 빠르게 찾기
        let lo = 0, hi = onsetIndex.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (onsetIndex[mid].time < beatTime - window) lo = mid + 1;
            else hi = mid - 1;
        }

        for (let i = lo; i < onsetIndex.length && onsetIndex[i].time <= beatTime + window; i++) {
            const dist = Math.abs(onsetIndex[i].time - beatTime);
            const proximity = 1 - Math.min(1, dist / Math.max(1e-4, window));
            const onset = onsetIndex[i];

            // Layer 5: 구간별 대역 가중치를 onset 선택에 직접 반영
            // 이 onset의 대역(type)에 해당하는 가중치를 적용
            const bandWeight = onset.type === 0 ? bandWeights.low
                : onset.type === 1 ? bandWeights.mid
                : bandWeights.high;

            // 다운비트에서는 킥(low)을 약간 더 선호 (리듬 뼈대)
            const beatBias = isDownbeat
                ? (onset.type === 0 ? 0.10 : onset.type === 1 ? 0.02 : 0.0)
                : (onset.type === 2 ? 0.06 : onset.type === 1 ? 0.04 : -0.02);

            // score = 근접도(0.40) + 대역가중치(0.30) + onset강도(0.24) + 비트위치(0.06)
            const melodicBias = onset.type === 1
                ? features.melodicFocus * 0.06 + features.sustainedFocus * 0.04
                : 0;
            const score = proximity * 0.38
                + bandWeight * 0.34
                + onset.strength * 0.22
                + beatBias
                + melodicBias;

            if (score > bestScore || (Math.abs(score - bestScore) < 1e-6 && dist < bestDist)) {
                bestScore = score;
                bestDist = dist;
                best = onset;
            }
        }

        return best;
    };

    const notes: NoteData[] = [];
    let lastNoteTime = -Infinity;
    let lastLane = LANE_BOTTOM;
    let consecutiveSameLane = 0;
    const laneOccupiedUntil = [-1, -1];
    const occupiedBuckets = new Set<number>();
    const occupancyBucketSize = Math.max(0.04, beatInterval * 0.18);
    const recentLaneHistory: number[] = [];
    const pushRecentLane = (lane: number): void => {
        recentLaneHistory.push(lane);
        if (recentLaneHistory.length > 12) {
            recentLaneHistory.shift();
        }
    };
    const shouldRebalanceLane = (lane: number): boolean => {
        if (recentLaneHistory.length < 6) return false;
        const lookback = Math.min(10, recentLaneHistory.length);
        let sameCount = 0;
        for (let i = recentLaneHistory.length - lookback; i < recentLaneHistory.length; i++) {
            if (recentLaneHistory[i] === lane) sameCount++;
        }
        return sameCount / lookback >= 0.65;
    };
    const toBucket = (time: number): number => Math.round(time / occupancyBucketSize);
    const markOccupied = (time: number): void => {
        const b = toBucket(time);
        occupiedBuckets.add(b - 1);
        occupiedBuckets.add(b);
        occupiedBuckets.add(b + 1);
    };
    const isOccupiedNear = (time: number): boolean => occupiedBuckets.has(toBucket(time));
    const getStrikeProfile = (
        time: number,
        onsetType: number,
        onsetStrength: number,
        isDownbeat: boolean
    ): { attack: number; bassHeavy: boolean; preferTop: boolean; spectrum: SpectralProfile | null } => {
        const spectrum = getSpectrum(time);
        if (!spectrum) {
            const fallbackAttack = clamp01(onsetStrength * 0.85 + (onsetType === 2 ? 0.2 : 0.05));
            return {
                attack: fallbackAttack,
                bassHeavy: onsetType === 0 && fallbackAttack < 0.45 && !isDownbeat,
                preferTop: onsetType === 2 || (onsetType === 1 && fallbackAttack >= 0.5),
                spectrum: null,
            };
        }
        const prev = getSpectrum(Math.max(0, time - halfBeat * 0.55));
        const total = Math.max(1e-5, spectrum.low + spectrum.mid + spectrum.high);
        const lowRatio = spectrum.low / total;
        const midRatio = spectrum.mid / total;
        const highRatio = spectrum.high / total;
        const energyRise = prev ? Math.max(0, spectrum.energy - prev.energy) : 0;
        const transient =
            onsetStrength * 0.55 +
            highRatio * 0.95 +
            midRatio * 0.45 +
            energyRise * 2.2 +
            (onsetType === 2 ? 0.3 : onsetType === 1 ? 0.14 : -0.08) -
            lowRatio * 0.36;
        const attack = clamp01(transient);
        const bassHeavy = lowRatio > 0.56 && highRatio < 0.2 && attack < 0.58;
        const preferTop = attack >= 0.62 || highRatio > 0.34 || (onsetType === 2 && attack > 0.5);
        return { attack, bassHeavy, preferTop, spectrum };
    };

    // 4분음표 + 8분음표 그리드 생성
    const grid: { time: number; isDownbeat: boolean }[] = [];
    const snapGrid: number[] = [];
    for (const beat of beatPositions) {
        grid.push({ time: beat, isDownbeat: true });
        // 8분음표 위치 (코러스/드랍에서만 사용)
        grid.push({ time: beat + halfBeat, isDownbeat: false });
        snapGrid.push(beat, beat + halfBeat);
    }
    grid.sort((a, b) => a.time - b.time);
    snapGrid.sort((a, b) => a - b);
    const findClosestSnap = (time: number): { value: number; dist: number } => {
        if (snapGrid.length === 0) return { value: time, dist: Number.POSITIVE_INFINITY };
        let lo = 0;
        let hi = snapGrid.length - 1;
        let best = snapGrid[0];
        let bestDist = Math.abs(best - time);
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const v = snapGrid[mid];
            const d = Math.abs(v - time);
            if (d < bestDist) {
                bestDist = d;
                best = v;
            }
            if (v < time) lo = mid + 1;
            else hi = mid - 1;
        }
        return { value: best, dist: bestDist };
    };

    for (const gridPoint of grid) {
        const { time: beatTime, isDownbeat } = gridPoint;
        const section = findSection(sections, beatTime);
        const density = getDensity(beatTime);

        if (density === 0.0) continue;

        // 최소 간격
        const driveBoost = clamp01(features.driveScore * 0.6 + features.percussiveFocus * 0.4 - 0.5);
        const minGap = Math.max(0.06, beatInterval * (0.2 - driveBoost * 0.07));

        // 8분음표는 중밀도 이상에서만 (onset이 있으면 0.4 이상에서도 허용)
        const energeticSection = section.type === 'drop' || section.type === 'chorus';
        const offbeatGate = Math.max(
            energeticSection ? 0.15 : 0.2,
            0.28 - driveBoost * 0.1 - (energeticSection ? 0.035 : 0)
        );
        if (!isDownbeat && density < offbeatGate) continue;

        // 비트 근처에서 onset 탐색 (4분음표: ±반비트, 8분음표: ±1/4비트)
        const searchWindow = isDownbeat ? halfBeat * 0.64 : halfBeat * 0.38;
        const nearestOnset = findNearbyOnset(beatTime, searchWindow, isDownbeat);

        // onset이 없는 경우
        if (!nearestOnset) {
            // 정박(다운비트)이고 밀도 충분하면 필 노트 배치
            if (isDownbeat && density >= (energeticSection ? 0.44 : 0.5)) {
                // 4박자 중 1, 3박에만 (약한 필)
                const beatIdx = Math.round(beatTime / beatInterval);
                if (beatIdx % 4 === 3) continue;
            } else {
                continue;
            }
        }
        let noteTime = beatTime;
        if (nearestOnset) {
            const onsetDelta = nearestOnset.time - beatTime;
            const maxNudge = isDownbeat ? halfBeat * 0.36 : halfBeat * 0.52;
            if (Math.abs(onsetDelta) <= maxNudge) {
                const nudge = (section.type === 'drop' || section.type === 'chorus')
                    ? (isDownbeat ? 0.72 : 0.78)
                    : 0.76;
                noteTime = beatTime + onsetDelta * nudge;
            }
        }
        noteTime = Math.max(0, noteTime);
        if (noteTime - lastNoteTime < minGap) continue;

        const strike = getStrikeProfile(
            noteTime,
            nearestOnset?.type ?? 1,
            nearestOnset?.strength ?? 0.35,
            isDownbeat
        );
        // 베이스 위주의 약한 off-beat는 고에너지 구간에서만 사용
        if (nearestOnset && strike.bassHeavy && !isDownbeat
            && section.type !== 'drop' && section.type !== 'chorus'
            && nearestOnset.strength < 0.55) {
            continue;
        }

        // === Layer 6: 레인 결정 (악기 기반) ===
        // 킥/베이스(low) → 항상 하단, 스네어/하이햇(high) → 항상 상단
        // 보컬/멜로디(mid) → 스펙트럼 밝기로 상하 결정 (높은음→상단, 낮은음→하단)
        const spectrum = strike.spectrum ?? getSpectrum(beatTime);
        let preferredLane: number;

        if (nearestOnset) {
            if (nearestOnset.type === 0) {
                // 킥/베이스 → 하단 (리듬게임 관례: 킥=발=아래)
                preferredLane = LANE_BOTTOM;
            } else if (nearestOnset.type === 2) {
                // 스네어/하이햇 → 상단 (타격감=위)
                preferredLane = LANE_TOP;
            } else {
                // 보컬/멜로디 → mid/high 비율로 음높이 추적
                if (spectrum) {
                    const total = Math.max(1e-5, spectrum.low + spectrum.mid + spectrum.high);
                    const highShare = spectrum.high / total;
                    const lowShare = spectrum.low / total;
                    // high 비중 높으면 상단(높은 음), low 비중 높으면 하단(낮은 음)
                    // 비등하면 이전 레인 반대로 교대 (단조로움 방지)
                    if (highShare - lowShare > 0.12) {
                        preferredLane = LANE_TOP;
                    } else if (lowShare - highShare > 0.12) {
                        preferredLane = LANE_BOTTOM;
                    } else {
                        preferredLane = lastLane === LANE_TOP ? LANE_BOTTOM : LANE_TOP;
                    }
                } else {
                    preferredLane = lastLane === LANE_TOP ? LANE_BOTTOM : LANE_TOP;
                }
            }
        } else {
            preferredLane = determineLane(spectrum, 0.4);
        }

        // 연속 같은 레인 방지 (4회 이상 — 3은 의도적 패턴일 수 있음)
        if (preferredLane === lastLane && consecutiveSameLane >= 4) {
            preferredLane = preferredLane === LANE_TOP ? LANE_BOTTOM : LANE_TOP;
        }
        // 저역/고역 고정 규칙을 유지하되, 중역/폴백 구간은 단조 반복을 완화한다.
        const strictLaneAnchor = nearestOnset?.type === 0 || nearestOnset?.type === 2;
        if (!strictLaneAnchor && shouldRebalanceLane(preferredLane)) {
            preferredLane = preferredLane === LANE_TOP ? LANE_BOTTOM : LANE_TOP;
        }

        // === 노트 타입 결정 ===
        let type: NoteData['type'] = NOTE_TYPE_TAP;
        let duration: number | undefined;
        let targetLane: number | undefined;
        const gap = noteTime - lastNoteTime;
        const onsetStrength = nearestOnset?.strength || 0.3;
        const strength = clamp01(onsetStrength * 0.6 + strike.attack * 0.62);
        const localTonal = spectrum?.tonal ?? (features.melodicFocus * 0.78 + 0.1);
        const localTransient = spectrum?.transient ?? (strike.attack * 0.84);
        const localPercussive = spectrum?.percussive ?? features.percussiveFocus;
        const sustainedLike = localTonal >= 0.62
            && localTransient <= 0.38
            && localPercussive <= 0.5
            && onsetStrength <= 0.66;
        const staccatoLike = localTransient >= 0.58 || localPercussive >= 0.62 || onsetStrength >= 0.8;

        if (section.type === 'bridge' && gap > beatInterval * 1.75 && strength > 0.52) {
            type = NOTE_TYPE_HOLD;
            duration = Math.min(gap * 0.5, beatInterval * 2);
        } else if (
            sustainedLike
            && features.sustainedFocus >= 0.58
            && section.type !== 'intro'
            && section.type !== 'outro'
            && section.type !== 'interlude'
            && gap > beatInterval * 0.8
            && gap < beatInterval * 2.45
        ) {
            type = NOTE_TYPE_SLIDE;
            const canCross = (section.type === 'chorus' || section.type === 'drop' || section.type === 'bridge')
                && gap >= beatInterval * 0.9
                && gap <= beatInterval * 2.8
                && localTonal >= 0.52
                && localTransient <= 0.62;
            const gateByDiff = features.driveScore >= 0.72
                ? 2
                : features.driveScore >= 0.56
                    ? 3
                    : features.percussiveFocus >= 0.52
                        ? 4
                        : 6;
            const crossGate = deterministicHash(Math.round(noteTime / Math.max(1e-4, beatInterval)) * 31 + preferredLane * 17) % gateByDiff === 0;
            targetLane = canCross && crossGate
                ? (preferredLane === LANE_TOP ? LANE_BOTTOM : LANE_TOP)
                : preferredLane;
            duration = Math.min(Math.max(gap * 0.9, beatInterval * 0.9), beatInterval * 2.5);
        } else if (section.type === 'drop' && shouldInsertSlide(beatTime, beatInterval, features.slideAffinity) && gap > beatInterval * 0.8) {
            type = NOTE_TYPE_SLIDE;
            targetLane = preferredLane === LANE_TOP ? LANE_BOTTOM : LANE_TOP;
            duration = Math.min(Math.max(gap * 0.82, beatInterval * 0.95), beatInterval * 1.8);
        } else if (staccatoLike) {
            type = NOTE_TYPE_TAP;
            duration = undefined;
            targetLane = undefined;
        }

        // === 물리적 겹침 체크 ===
        const buffer = 0.1;
        if (noteTime < laneOccupiedUntil[preferredLane] + buffer) {
            const otherLane = preferredLane === LANE_TOP ? LANE_BOTTOM : LANE_TOP;
            if (noteTime < laneOccupiedUntil[otherLane] + buffer) continue;
            preferredLane = otherLane;
        }

        const lane = preferredLane;

        if (duration) {
            laneOccupiedUntil[lane] = noteTime + duration + 0.05;
        } else {
            laneOccupiedUntil[lane] = noteTime + 0.08;
        }

        notes.push({
            time: noteTime,
            lane,
            type,
            strength,
            targetLane,
            duration,
        });
        markOccupied(noteTime);

        consecutiveSameLane = (lane === lastLane) ? consecutiveSameLane + 1 : 0;
        lastNoteTime = noteTime;
        lastLane = lane;
        pushRecentLane(lane);
    }

    // onset이 있지만 비트 그리드에 안 잡힌 강한 onset 추가 (보충)
    const supplementThreshold = Math.max(0.3, Math.min(0.72, 0.34
        + features.percussiveFocus * 0.05
        - features.melodicFocus * 0.08
        - energeticLiftBase * 0.12));
    let supplementLastLane = lastLane;
    for (const onset of onsetIndex) {
        if (onset.strength < supplementThreshold) continue; // 강한 onset만

        const section = findSection(sections, onset.time);
        if (section.isInterlude || section.type === 'interlude') continue;

        // 이미 근처에 노트가 있는지 확인
        const hasNearby = isOccupiedNear(onset.time);
        if (hasNearby) continue;

        // 비트/반비트 그리드에 스냅 (이진탐색)
        const snapped = findClosestSnap(onset.time);
        const closestBeat = snapped.value;
        const minDist = snapped.dist;

        if (minDist > halfBeat * 0.82) continue; // 비트에서 너무 멀면 스킵

        const strike = getStrikeProfile(closestBeat, onset.type, onset.strength, true);
        if (strike.bassHeavy && strike.attack < 0.62) continue;
        const localSpectrum = getSpectrum(closestBeat);
        // Layer 6: 보충 노트도 동일한 악기→레인 규칙 적용
        const lane = onset.type === 0 ? LANE_BOTTOM
            : onset.type === 2 ? LANE_TOP
            : (() => {
                const resolved = determineLane(localSpectrum, onset.strength);
                if (!localSpectrum) {
                    return supplementLastLane === LANE_TOP ? LANE_BOTTOM : LANE_TOP;
                }
                return resolved;
            })();
        const sustainedLike = (localSpectrum?.tonal ?? features.melodicFocus) >= 0.66
            && (localSpectrum?.transient ?? strike.attack) <= 0.36
            && (localSpectrum?.percussive ?? features.percussiveFocus) <= 0.5
            && features.sustainedFocus >= 0.62;
        const isBridgeLike = section.type === 'bridge' || (section.type === 'verse' && (section.avgEnergy || 0.5) < 0.56);

        notes.push({
            time: closestBeat,
            lane,
            type: sustainedLike ? NOTE_TYPE_SLIDE : NOTE_TYPE_TAP,
            strength: clamp01(onset.strength * 0.65 + strike.attack * 0.45),
            targetLane: sustainedLike ? lane : undefined,
            duration: sustainedLike
                ? Math.min(Math.max(beatInterval * (isBridgeLike ? 1.26 : 0.98), beatInterval * 0.86), beatInterval * 1.8)
                : undefined,
        });
        supplementLastLane = lane;
        markOccupied(closestBeat);
    }

    // 시간순 정렬 후 중복 제거
    notes.sort((a, b) => a.time - b.time);
    const deduped: NoteData[] = [];
    for (const note of notes) {
        const prev = deduped[deduped.length - 1];
        if (!prev || note.time - prev.time >= 0.06 || note.lane !== prev.lane) {
            deduped.push(note);
        }
    }

    return humanizeNoteFlow(deduped, sections, beatPositions, beatInterval);
};

const shouldInsertSlide = (time: number, beatInterval: number, slideAffinity = 0.5): boolean => {
    const beatIndex = Math.round(time / beatInterval);
    // 프레이즈 끝부분만 슬라이드 허용 (사람이 짠 전환 느낌)
    const phraseEdge = beatIndex % 16 === 14 || beatIndex % 16 === 15 || beatIndex % 8 === 3 || beatIndex % 8 === 7;
    if (!phraseEdge) return false;
    const gate = slideAffinity >= 0.66
        ? 2
        : slideAffinity >= 0.5
            ? 3
            : 4;
    return deterministicHash(beatIndex * 17 + Math.round(slideAffinity * 100)) % gate === 0;
};

const humanizeNoteFlow = (
    notes: readonly NoteData[],
    sections: readonly SectionInfo[],
    beatPositions: readonly number[],
    beatInterval: number
): readonly NoteData[] => {
    const sorted = [...notes].sort((a, b) => a.time - b.time);
    if (sorted.length === 0) return sorted;

    const adjusted = sorted.map(n => ({ ...n }));

    // === Layer 7-A: 코러스 진입 임팩트 ===
    // 코러스/드랍 시작 직전 1~2비트를 비우고, 첫 비트에 강한 노트 배치
    const chorusStarts: number[] = [];
    for (const sec of sections) {
        if (sec.type === 'chorus' || sec.type === 'drop') {
            chorusStarts.push(sec.startTime);
        }
    }
    for (const chorusStart of chorusStarts) {
        // 코러스 직전 2비트 구간의 노트를 제거 (숨 고르기)
        const clearStart = chorusStart - beatInterval * 2;
        const clearEnd = chorusStart - beatInterval * 0.25;
        for (let i = adjusted.length - 1; i >= 0; i--) {
            const n = adjusted[i];
            if (n.time >= clearStart && n.time < clearEnd && n.type === NOTE_TYPE_TAP) {
                adjusted.splice(i, 1);
            }
        }
        // 코러스 첫 비트에 강한 노트가 없으면 추가
        const hasFirst = adjusted.some(n => Math.abs(n.time - chorusStart) <= beatInterval * 0.2);
        if (!hasFirst) {
            adjusted.push({
                time: chorusStart,
                lane: LANE_BOTTOM,  // 킥 타이밍 → 하단
                type: NOTE_TYPE_TAP,
                strength: 0.92,
            });
        }
    }

    // === Layer 7-B: 마디 시작 강세 보강 ===
    for (let i = 0; i < beatPositions.length; i += 4) {
        const barStart = beatPositions[i];
        if (barStart === undefined) continue;

        const section = findSection(sections, barStart);
        if (section.type !== 'chorus' && section.type !== 'drop') continue;

        const hasAnchor = adjusted.some(n => Math.abs(n.time - barStart) <= beatInterval * 0.2);
        if (hasAnchor) continue;

        const prev = adjusted.filter(n => n.time < barStart).at(-1);
        const lane = prev?.lane === LANE_TOP ? LANE_BOTTOM : LANE_TOP;
        adjusted.push({
            time: barStart,
            lane,
            type: NOTE_TYPE_TAP,
            strength: 0.65,
        });
    }

    adjusted.sort((a, b) => a.time - b.time);

    // === Layer 7-C: 밀도 스무딩 (O(n) 슬라이딩 윈도우) ===
    // 1마디(4비트) 단위로 노트 수를 세서, 과밀 구간에서 약한 tap 제거
    {
        const barLength = beatInterval * 4;
        const maxPerBar = 11; // 과도한 밀도 절삭 완화
        const removeSet = new Set<number>(); // 제거할 인덱스
        let wStart = 0;
        for (let wEnd = 0; wEnd < adjusted.length; wEnd++) {
            // 윈도우 시작 전진
            while (wStart < wEnd && adjusted[wEnd].time - adjusted[wStart].time > barLength) {
                wStart++;
            }
            const windowCount = wEnd - wStart + 1;
            if (windowCount > maxPerBar) {
                // 윈도우 내 가장 약한 tap 찾아서 제거 대상에 추가
                let weakIdx = -1;
                let weakStr = Infinity;
                for (let k = wStart; k <= wEnd; k++) {
                    if (removeSet.has(k)) continue;
                    const n = adjusted[k];
                    if (n.type === NOTE_TYPE_TAP && (n.strength ?? 0.5) < weakStr) {
                        weakStr = n.strength ?? 0.5;
                        weakIdx = k;
                    }
                }
                if (weakIdx >= 0) removeSet.add(weakIdx);
            }
        }
        // 역순 제거 (인덱스 안 꼬이게)
        const removeArr = [...removeSet].sort((a, b) => b - a);
        for (const idx of removeArr) {
            adjusted.splice(idx, 1);
        }
    }

    // === Layer 7-D: 한 레인 연타 교정 (4회 이상) ===
    let streakLane = adjusted[0]?.lane ?? LANE_BOTTOM;
    let streak = 0;
    for (let i = 1; i < adjusted.length; i++) {
        const note = adjusted[i];
        if (note.lane === streakLane) {
            streak++;
        } else {
            streakLane = note.lane;
            streak = 0;
        }

        const sec = findSection(sections, note.time);
        const streakLimit = sec.type === 'chorus' || sec.type === 'drop' ? 3 : 4;
        if (streak >= streakLimit && note.type === NOTE_TYPE_TAP) {
            adjusted[i] = { ...note, lane: note.lane === LANE_TOP ? LANE_BOTTOM : LANE_TOP };
            streakLane = adjusted[i].lane;
            streak = 0;
        }
    }

    // === Layer 7-E: 프레이즈 끝 슬라이드 연결 ===
    for (let i = 0; i < adjusted.length - 1; i++) {
        const current = adjusted[i];
        const next = adjusted[i + 1];
        if (current.type !== NOTE_TYPE_TAP) continue;
        if (next.type !== NOTE_TYPE_TAP) continue;
        if (current.lane === next.lane) continue;

        const gap = next.time - current.time;
        if (gap < beatInterval * 0.35 || gap > beatInterval * 1.1) continue;

        const section = findSection(sections, current.time);
        if (section.type !== 'chorus' && section.type !== 'drop') continue;

        const beatIndex = Math.round(current.time / beatInterval);
        if (beatIndex % 8 !== 3 && beatIndex % 8 !== 7) continue;

        adjusted[i] = {
            ...current,
            type: NOTE_TYPE_SLIDE,
            targetLane: next.lane,
            duration: Math.min(Math.max(gap * 0.88, beatInterval * 0.9), beatInterval * 1.6),
        };
    }

    // === Layer 7-F: 6~8마디마다 호흡(rest) 삽입 ===
    // verse/bridge에서 6마디마다 마디 끝 약한 노트 하나 제거 → 사람처럼 숨쉬기
    {
        const totalBars = Math.floor(beatPositions.length / 4);
        const restInterval = 6;
        for (let bar = restInterval; bar < totalBars; bar += restInterval) {
            // 해당 마디의 3번째 비트(0-indexed) = 마디 끝 근처
            const beatIdx = bar * 4 + 2;
            if (beatIdx >= beatPositions.length) continue;
            const restTime = beatPositions[beatIdx];
            if (restTime === undefined) continue;

            const section = findSection(sections, restTime);
            if (section.type === 'chorus' || section.type === 'drop') continue;

            let weakestIdx = -1;
            let weakestStr = Infinity;
            for (let i = 0; i < adjusted.length; i++) {
                const n = adjusted[i];
                if (Math.abs(n.time - restTime) < beatInterval * 0.6
                    && n.type === NOTE_TYPE_TAP
                    && (n.strength ?? 0.5) < weakestStr) {
                    weakestStr = n.strength ?? 0.5;
                    weakestIdx = i;
                }
            }
            if (weakestIdx >= 0 && weakestStr < 0.7) {
                adjusted.splice(weakestIdx, 1);
            }
        }
    }

    adjusted.sort((a, b) => a.time - b.time);
    const deduped: NoteData[] = [];
    for (const note of adjusted) {
        const prev = deduped[deduped.length - 1];
        if (!prev || Math.abs(note.time - prev.time) > 0.045 || note.lane !== prev.lane) {
            deduped.push(note);
        }
    }

    return deduped;
};


const deterministicHash = (x: number): number => {
    let n = x | 0;
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    n = ((n >>> 16) ^ n) * 0x45d9f3b;
    n = (n >>> 16) ^ n;
    return Math.abs(n);
};


const determineLane = (
    spectrum: SpectralProfile | null,
    strength: number
): number => {
    if (!spectrum) {
        return strength > 0.6 ? LANE_BOTTOM : LANE_TOP;
    }

    const total = spectrum.low + spectrum.mid + spectrum.high;
    if (total <= 0) return LANE_BOTTOM;

    const lowRatio = spectrum.low / total;
    const highRatio = spectrum.high / total;

    if (lowRatio > 0.45) return LANE_BOTTOM;
    if (highRatio > 0.35) return LANE_TOP;
    return strength > 0.5 ? LANE_BOTTOM : LANE_TOP;
};

const FALLBACK_SECTION: SectionInfo = {
    startTime: 0,
    endTime: Infinity,
    type: 'verse',
    avgEnergy: 0.5,
};

const sectionLookupCache = new WeakMap<object, (time: number) => SectionInfo>();

const buildSectionLookup = (
    sections: readonly SectionInfo[]
): ((time: number) => SectionInfo) => {
    if (sections.length === 0) {
        return () => FALLBACK_SECTION;
    }
    const sorted = [...sections].sort((a, b) => a.startTime - b.startTime);
    return (time: number): SectionInfo => {
        let lo = 0;
        let hi = sorted.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const sec = sorted[mid];
            if (time < sec.startTime) {
                hi = mid - 1;
            } else if (time >= sec.endTime) {
                lo = mid + 1;
            } else {
                return sec;
            }
        }
        const nearIdx = Math.max(0, Math.min(sorted.length - 1, lo));
        return sorted[nearIdx] ?? FALLBACK_SECTION;
    };
};

const findSection = (
    sections: readonly SectionInfo[],
    time: number
): SectionInfo => {
    const key = sections as unknown as object;
    let lookup = sectionLookupCache.get(key);
    if (!lookup) {
        lookup = buildSectionLookup(sections);
        sectionLookupCache.set(key, lookup);
    }
    return lookup(time);
};

const buildSpectralLookup = (
    profiles: readonly SpectralProfile[]
): ((time: number) => SpectralProfile | null) => {
    if (profiles.length === 0) return () => null;

    const sorted = [...profiles].sort((a, b) => a.time - b.time);

    return (time: number): SpectralProfile | null => {
        let lo = 0;
        let hi = sorted.length - 1;
        let closest: SpectralProfile | null = null;
        let minDist = Infinity;

        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const dist = Math.abs(sorted[mid].time - time);
            if (dist < minDist) {
                minDist = dist;
                closest = sorted[mid];
            }
            if (sorted[mid].time < time) {
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return minDist < 5 ? closest : null;
    };
};
