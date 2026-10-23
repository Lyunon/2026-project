/**
 * netlify/functions/weekly-analysis.mjs
 *
 * Netlify Scheduled Function — 매주 일요일 00:00 KST 자동 실행
 * schedule: "0 15 * * 0"  (UTC 15:00 = KST 00:00)
 *
 * 필요한 환경변수 (Netlify 대시보드 → Site configuration → Environment variables):
 *   FIREBASE_URL  = https://sleep-monitoring-f630c-default-rtdb.firebaseio.com
 */

// Netlify Scheduled Function 선언
export const config = {
  schedule: "0 15 * * 0"   // 매주 일요일 UTC 15:00 = KST 00:00
};

// ── 설정 상수 ──────────────────────────────────────────────────
const INTERVAL_INTENSIVE = 30;
const INTERVAL_ACTIVE    = 60;
const INTERVAL_STABLE    = 120;

const IRREGULARITY_THRESHOLD = 3.0;
const SLEEP_RATIO_THRESHOLD  = 0.70;
const MIN_SLEEP_HOURS        = 6;
const ABSENCE_STREAK_MIN     = 48;   // 연속 N회 비어있음 → 부재 의심

const FIREBASE_URL = process.env.FIREBASE_URL ||
  "https://sleep-monitoring-f630c-default-rtdb.firebaseio.com";

// ── Firebase 헬퍼 ──────────────────────────────────────────────
async function fbGet(path) {
  try {
    const res = await fetch(`${FIREBASE_URL}${path}.json`);
    if (!res.ok) { console.error(`GET ${path} → ${res.status}`); return {}; }
    const data = await res.json();
    return (data && typeof data === "object") ? data : {};
  } catch (e) {
    console.error(`GET ${path} 오류:`, e.message);
    return {};
  }
}

async function fbPut(path, data) {
  try {
    const res = await fetch(`${FIREBASE_URL}${path}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    if (!res.ok) console.error(`PUT ${path} → ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`PUT ${path} 오류:`, e.message);
    return false;
  }
}

async function fbDelete(path) {
  try {
    const res = await fetch(`${FIREBASE_URL}${path}.json`, { method: "DELETE" });
    if (!res.ok) console.error(`DELETE ${path} → ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`DELETE ${path} 오류:`, e.message);
    return false;
  }
}

// ── 분석 함수 ──────────────────────────────────────────────────

/** 타임스탬프 문자열에서 시(0~23) 파싱 */
function parseHour(tsStr) {
  try {
    return new Date(tsStr).getHours();
  } catch {
    return null;
  }
}

/**
 * 시간대별 침대 재실 비율 계산
 * 반환: { sleepHours: number[], irregularity: number }
 */
function analyzeSleepHours(lidarData) {
  const hourBuckets = {};   // { hour: [bedOccupied, ...] }

  for (const [ts, v] of Object.entries(lidarData)) {
    const hour = parseHour(ts);
    if (hour === null || typeof v !== "object") continue;
    const occ = v.bedOccupied ?? 2;
    if (!hourBuckets[hour]) hourBuckets[hour] = [];
    hourBuckets[hour].push(Number(occ));
  }

  const sleepHours = [];
  for (const [hour, vals] of Object.entries(hourBuckets)) {
    const ratio = vals.filter(v => v === 1).length / vals.length;
    if (ratio >= SLEEP_RATIO_THRESHOLD) sleepHours.push(Number(hour));
  }
  sleepHours.sort((a, b) => a - b);

  // 표준편차 계산
  let irregularity = 0;
  if (sleepHours.length >= 2) {
    const mean = sleepHours.reduce((s, v) => s + v, 0) / sleepHours.length;
    const variance = sleepHours.reduce((s, v) => s + (v - mean) ** 2, 0) / sleepHours.length;
    irregularity = Math.sqrt(variance);
  }

  return { sleepHours, irregularity };
}

/**
 * 장시간 부재 의심 체크
 * 연속 ABSENCE_STREAK_MIN회 이상 bedOccupied==0 + PIR 없음
 */
function checkLongAbsence(lidarData, pirData) {
  if (!lidarData || Object.keys(lidarData).length === 0) return false;

  const sorted = Object.keys(lidarData).sort();
  let maxStreak = 0, streak = 0;

  for (const ts of sorted) {
    const v = lidarData[ts];
    const occ = (typeof v === "object" ? v.bedOccupied : null) ?? 2;
    if (occ === 0) { streak++; maxStreak = Math.max(maxStreak, streak); }
    else streak = 0;
  }

  const pirVals = Object.values(pirData || {}).slice(-maxStreak);
  const noPir = !pirVals.some(v => typeof v === "object" && v.motion);

  const absent = maxStreak >= ABSENCE_STREAK_MIN && noPir;
  if (absent) console.log(`[분석] 장시간 부재 의심 — 연속 비어있음: ${maxStreak}회`);
  return absent;
}

/**
 * 주기 결정
 * 반환: { interval: number, reason: string }
 */
function decideInterval(sleepHours, irregularity, longAbsence) {
  if (longAbsence)
    return { interval: INTERVAL_INTENSIVE, reason: "장시간 부재 의심 → 강화 모니터링" };
  if (irregularity > IRREGULARITY_THRESHOLD)
    return { interval: INTERVAL_INTENSIVE,
             reason: `수면 패턴 불규칙 (표준편차 ${irregularity.toFixed(1)}) → 강화 모니터링` };
  if (sleepHours.length >= MIN_SLEEP_HOURS)
    return { interval: INTERVAL_STABLE,
             reason: `수면 패턴 안정 (${sleepHours.length}시간) → 여유 있게` };
  if (sleepHours.length > 0)
    return { interval: INTERVAL_ACTIVE, reason: "수면 패턴 일부 확인 → 일반 모니터링" };
  return { interval: INTERVAL_ACTIVE, reason: "수면 데이터 부족 → 기본 주기 유지" };
}

// ── 메인 핸들러 ────────────────────────────────────────────────
export default async function handler(req, context) {
  const startedAt = new Date().toISOString();
  console.log(`\n${"=".repeat(50)}`);
  console.log(`주간 분석 시작: ${startedAt}`);
  console.log("=".repeat(50));

  // 1. prev_week 데이터 읽기
  const [lidarData, pirData, lightData] = await Promise.all([
    fbGet("/sensor_logs/prev_week/lidar"),
    fbGet("/sensor_logs/prev_week/pir"),
    fbGet("/sensor_logs/prev_week/light")
  ]);

  const lidarCount = Object.keys(lidarData).length;
  const pirCount   = Object.keys(pirData).length;
  const lightCount = Object.keys(lightData).length;
  console.log(`[데이터] LiDAR: ${lidarCount}건 | PIR: ${pirCount}건 | 조도: ${lightCount}건`);

  if (lidarCount === 0 && pirCount === 0) {
    console.log("분석할 데이터 없음 — 기본값 유지");
    await fbPut("/config/last_updated", startedAt);
    return new Response(JSON.stringify({ status: "no_data" }), { status: 200 });
  }

  // 2. 분석
  const { sleepHours, irregularity } = analyzeSleepHours(lidarData);
  console.log(`[분석] 수면 주요 시간대: [${sleepHours.join(", ")}]`);
  console.log(`[분석] 불규칙도(표준편차): ${irregularity.toFixed(2)}`);

  const longAbsence = checkLongAbsence(lidarData, pirData);

  // 3. 주기 결정
  const { interval, reason } = decideInterval(sleepHours, irregularity, longAbsence);
  console.log(`[결정] 추천 주기: ${interval}초 — ${reason}`);

  // 4. Firebase config 업데이트
  await Promise.all([
    fbPut("/config/sleep_interval_sec", interval),
    fbPut("/config/last_updated", startedAt),
    fbPut("/config/analysis", {
      sleep_hours:              sleepHours,
      irregularity:             Math.round(irregularity * 100) / 100,
      long_absence_suspected:   longAbsence,
      recommended_interval_sec: interval,
      reason
    })
  ]);
  console.log("[Firebase] config 업데이트 완료");

  // 5. 롤오버: current_week → prev_week
  const currentWeek = await fbGet("/sensor_logs/current_week");
  if (Object.keys(currentWeek).length > 0) {
    await fbPut("/sensor_logs/prev_week", currentWeek);
    await fbDelete("/sensor_logs/current_week");
    console.log("[롤오버] current_week → prev_week 이동 완료");
  } else {
    console.log("[롤오버] current_week 비어있음 — 스킵");
  }

  console.log(`\n분석 완료 | 다음 주 측정 주기: ${interval}초`);
  return new Response(JSON.stringify({ status: "ok", interval, reason }), { status: 200 });
}
