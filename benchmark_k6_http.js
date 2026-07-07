/**
 * k6 benchmark using HTTP wrapper for MongoDB queries.
 *
 * Query types in parallel:
 *   FIND phase:
 *   1. oned_eq_ts_find         - find 1-min candles for one EQ ID from oned-eq
 *   2. oned_eq_packed_find     - find packed 1d data for one EQ ID from oned-eq-packed
 *   3. oned_fno_ts_find        - find 1-min candles for one F&O ID from oned-fno
 *   4. oned_fno_packed_find    - find packed 1d data for one F&O ID from oned-fno-packed
 *
 *   AGG phase:
 *   5. oned_eq_ts_5m_agg       - aggregate 5-min OHLC for one EQ ID from oned-eq
 *   6. oned_eq_packed_5m_agg   - aggregate 5-min OHLC for one EQ ID from oned-eq-packed
 *   7. oned_fno_ts_5m_agg      - aggregate 5-min OHLC for one F&O ID from oned-fno
 *   8. oned_fno_packed_5m_agg  - aggregate 5-min OHLC for one F&O ID from oned-fno-packed
 *   9. historic_ts_window_agg  - aggregate historic-eq in random 5-30 day windows at 5/15/30-min bins
 *  10. historic_packed_window_agg - aggregate historic-eq-packed in random 5-30 day windows at 5/15/30-min bins
 *
 * Prerequisites:
 *   1. Build and run the Go wrapper service:
 *      go build -o mongo_wrapper main.go
 *      MONGO_URI="mongodb+srv://..." ./mongo_wrapper
 *
 *   2. Ensure k6 is installed:
 *      brew install k6   (on macOS)
 *
 * Run:
 *   k6 run benchmark_k6_http.js
 *
 * Tune via env vars (all optional):
 *   API_BASE_URL       — HTTP wrapper base URL      (default: http://localhost:8080)
 *   TOTAL_RPS          — total req/sec across scenarios (default: 100)
 *   FIND_PHASE_RPS     — total req/sec during find phase (default: TOTAL_RPS)
 *   AGG_PHASE_RPS      — total req/sec during aggregate phase (default: TOTAL_RPS)
 *   PREALLOCATED_VUS   — pre-allocated VUs per scenario (default: 50)
 *   MAX_VUS            — max VUs per scenario          (default: 500)
 *   RATE_STEP          — minimum req/sec added per step (default: 1)
 *   RATE_STEP_SECONDS  — seconds per rate step         (default: 5)
 *   MINUTES            — duration of each scenario  (default: 2)
 *   ONED_EQ_COLLECTION      — oned-eq collection (default: oned-eq)
 *   ONED_EQ_PACKED_COLLECTION — oned-eq-packed collection (default: oned-eq-packed)
 *   HISTORIC_EQ_COLLECTION  — historic-eq collection (default: historic-eq)
 *   HISTORIC_EQ_PACKED_COLLECTION — historic-eq-packed collection (default: historic-eq-packed)
 *   ONED_FNO_COLLECTION     — oned-fno collection (default: oned-fno)
 *   ONED_FNO_PACKED_COLLECTION — oned-fno-packed collection (default: oned-fno-packed)
 *   HIST_WINDOW_MIN_DAYS — minimum historic window in days (default: 5)
 *   HIST_WINDOW_MAX_DAYS — maximum historic window in days (default: 30)
 *   AGG_MIN_TS         — oldest ts for agg window   (default: 2024-01-01T00:00:00Z)
 *   AGG_MAX_TS         — newest ts for agg window   (default: 2026-06-11T00:00:00Z)
 */

import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_BASE_URL = __ENV.API_BASE_URL  || 'http://localhost:9000';
const TOTAL_RPS    = parseInt(__ENV.TOTAL_RPS || '100');
const FIND_PHASE_RPS = parseInt(__ENV.FIND_PHASE_RPS || String(TOTAL_RPS));
const AGG_PHASE_RPS  = parseInt(__ENV.AGG_PHASE_RPS || String(TOTAL_RPS));
const PREALLOCATED_VUS = parseInt(__ENV.PREALLOCATED_VUS || '50');
const MAX_VUS      = parseInt(__ENV.MAX_VUS || '500');
const RATE_STEP    = parseInt(__ENV.RATE_STEP || '1');
const RATE_STEP_SECONDS = parseInt(__ENV.RATE_STEP_SECONDS || '5');
const MINUTES      = parseInt(__ENV.MINUTES || '2');
const ONED_EQ_COLLECTION     = __ENV.ONED_EQ_COLLECTION     || 'oned-eq';
const ONED_EQ_PACKED_COLLECTION = __ENV.ONED_EQ_PACKED_COLLECTION || 'oned-eq-packed';
const HISTORIC_EQ_COLLECTION = __ENV.HISTORIC_EQ_COLLECTION || 'historic-eq';
const HISTORIC_EQ_PACKED_COLLECTION = __ENV.HISTORIC_EQ_PACKED_COLLECTION || 'historic-eq-packed';
const ONED_FNO_COLLECTION    = __ENV.ONED_FNO_COLLECTION    || 'oned-fno';
const ONED_FNO_PACKED_COLLECTION = __ENV.ONED_FNO_PACKED_COLLECTION || 'oned-fno-packed';

// Fixed date window used by the find phase (mirrors the Python hardcode)
const ONED_START_TS = '2026-06-03T03:45:00Z';
const ONED_END_TS   = '2026-06-03T10:00:00Z';

// F&O date window (2026-06-02)
const FNO_START_TS  = '2026-06-02T03:45:00Z';
const FNO_END_TS    = '2026-06-02T10:00:00Z';

// Timestamp range for aggregate random windows (supply via env for accuracy)
const AGG_MIN_TS = __ENV.AGG_MIN_TS || '2023-03-20T00:00:00Z';
const AGG_MAX_TS = __ENV.AGG_MAX_TS || '2023-05-05T00:00:00Z';
const HIST_WINDOW_MIN_DAYS = parseInt(__ENV.HIST_WINDOW_MIN_DAYS || '5');
const HIST_WINDOW_MAX_DAYS = parseInt(__ENV.HIST_WINDOW_MAX_DAYS || '30');

function parseSymbolsCsv(content) {
  const symbols = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (symbols.length === 0) {
    throw new Error('symbol CSV is empty; provide at least one symbol');
  }

  return symbols;
}

const SYMBOL_POOL_EQ = new SharedArray('symbols_eq', function () {
  return parseSymbolsCsv(open('./symbols_eq.csv'));
});
const SYMBOL_POOL_HISTORIC = new SharedArray('symbols_historic', function () {
  return parseSymbolsCsv(open('./symbols_historic.csv'));
});
const SYMBOL_POOL_FNO = new SharedArray('symbols_fno', function () {
  return parseSymbolsCsv(open('./symbols_fno.csv'));
});

// ---------------------------------------------------------------------------
// Custom metrics  (mirror the Python per-bin-size breakdowns)
// Prefixed with find_/agg_ to control sort order in summary (finds first)
// ---------------------------------------------------------------------------
// Latency trends
const findOnedEqTsLatencyMs            = new Trend('find_oned_eq_ts_latency_ms', true);
const findOnedEqPackedLatencyMs        = new Trend('find_oned_eq_packed_latency_ms', true);
const findOnedFnoTsLatencyMs           = new Trend('find_oned_fno_ts_latency_ms', true);
const findOnedFnoPackedLatencyMs       = new Trend('find_oned_fno_packed_latency_ms', true);
const aggOnedEqTs5mLatencyMs           = new Trend('agg_oned_eq_ts_5m_latency_ms', true);
const aggOnedEqPacked5mLatencyMs       = new Trend('agg_oned_eq_packed_5m_latency_ms', true);
const aggOnedFnoTs5mLatencyMs          = new Trend('agg_oned_fno_ts_5m_latency_ms', true);
const aggOnedFnoPacked5mLatencyMs      = new Trend('agg_oned_fno_packed_5m_latency_ms', true);
const aggHistoricTsWindowLatencyMs     = new Trend('agg_historic_ts_window_latency_ms', true);
const aggHistoricPackedWindowLatencyMs = new Trend('agg_historic_packed_window_latency_ms', true);

// Count trends (documents returned)
const findOnedEqTsCountDocs            = new Trend('find_oned_eq_ts_count', false);
const findOnedEqPackedCountDocs        = new Trend('find_oned_eq_packed_count', false);
const findOnedFnoTsCountDocs           = new Trend('find_oned_fno_ts_count', false);
const findOnedFnoPackedCountDocs       = new Trend('find_oned_fno_packed_count', false);
const aggOnedEqTs5mCountDocs           = new Trend('agg_oned_eq_ts_5m_count', false);
const aggOnedEqPacked5mCountDocs       = new Trend('agg_oned_eq_packed_5m_count', false);
const aggOnedFnoTs5mCountDocs          = new Trend('agg_oned_fno_ts_5m_count', false);
const aggOnedFnoPacked5mCountDocs      = new Trend('agg_oned_fno_packed_5m_count', false);
const aggHistoricTsWindowCountDocs     = new Trend('agg_historic_ts_window_count', false);
const aggHistoricPackedWindowCountDocs = new Trend('agg_historic_packed_window_count', false);

const findErrors                = new Counter('find_errors');
const aggErrors                 = new Counter('agg_errors');
const httpErrors    = new Counter('http_errors');

// Per-scenario visibility for attempts/failures (useful when trends have no successful samples)
const findOnedEqTsAttempts      = new Counter('find_oned_eq_ts_attempts');
const findOnedEqTsFailures      = new Counter('find_oned_eq_ts_failures');
const findOnedEqPackedAttempts  = new Counter('find_oned_eq_packed_attempts');
const findOnedEqPackedFailures  = new Counter('find_oned_eq_packed_failures');
const findOnedFnoTsAttempts     = new Counter('find_oned_fno_ts_attempts');
const findOnedFnoTsFailures     = new Counter('find_oned_fno_ts_failures');
const findOnedFnoPackedAttempts = new Counter('find_oned_fno_packed_attempts');
const findOnedFnoPackedFailures = new Counter('find_oned_fno_packed_failures');

const aggOnedEqTs5mAttempts         = new Counter('agg_oned_eq_ts_5m_attempts');
const aggOnedEqTs5mFailures         = new Counter('agg_oned_eq_ts_5m_failures');
const aggOnedEqPacked5mAttempts     = new Counter('agg_oned_eq_packed_5m_attempts');
const aggOnedEqPacked5mFailures     = new Counter('agg_oned_eq_packed_5m_failures');
const aggOnedFnoTs5mAttempts        = new Counter('agg_oned_fno_ts_5m_attempts');
const aggOnedFnoTs5mFailures        = new Counter('agg_oned_fno_ts_5m_failures');
const aggOnedFnoPacked5mAttempts    = new Counter('agg_oned_fno_packed_5m_attempts');
const aggOnedFnoPacked5mFailures    = new Counter('agg_oned_fno_packed_5m_failures');
const aggHistoricTsWindowAttempts   = new Counter('agg_historic_ts_window_attempts');
const aggHistoricTsWindowFailures   = new Counter('agg_historic_ts_window_failures');
const aggHistoricPackedWindowAttempts = new Counter('agg_historic_packed_window_attempts');
const aggHistoricPackedWindowFailures = new Counter('agg_historic_packed_window_failures');

function buildRateStages(targetRate) {
  const safeTarget = Math.max(targetRate, 1);
  const totalSeconds = Math.max(Math.floor(MINUTES * 60), 1);

  if (totalSeconds === 1) {
    return [{ duration: '1s', target: safeTarget }];
  }

  const rampSeconds = Math.max(1, Math.floor(totalSeconds / 2));
  const holdSeconds = totalSeconds - rampSeconds;

  return [
    { duration: `${rampSeconds}s`, target: safeTarget },
    { duration: `${holdSeconds}s`, target: safeTarget },
  ];
}

// Find phase split (totals 100%): 35 + 15 + 35 + 15
const RATE_ONED_EQ_TS_FIND      = Math.max(1, Math.round(FIND_PHASE_RPS * 0.35));
const RATE_ONED_EQ_PACKED_FIND  = Math.max(1, Math.round(FIND_PHASE_RPS * 0.15));
const RATE_ONED_FNO_TS_FIND     = Math.max(1, Math.round(FIND_PHASE_RPS * 0.35));
const RATE_ONED_FNO_PACKED_FIND = Math.max(1, Math.round(FIND_PHASE_RPS * 0.15));

// Aggregate phase split (totals 100%): 20 + 15 + 20 + 15 + 15 + 15
const RATE_ONED_EQ_TS_5M_AGG         = Math.max(1, Math.round(AGG_PHASE_RPS * 0.20));
const RATE_ONED_EQ_PACKED_5M_AGG     = Math.max(1, Math.round(AGG_PHASE_RPS * 0.15));
const RATE_ONED_FNO_TS_5M_AGG        = Math.max(1, Math.round(AGG_PHASE_RPS * 0.20));
const RATE_ONED_FNO_PACKED_5M_AGG    = Math.max(1, Math.round(AGG_PHASE_RPS * 0.15));
const RATE_HISTORIC_TS_WINDOW_AGG    = Math.max(1, Math.round(AGG_PHASE_RPS * 0.15));
const RATE_HISTORIC_PACKED_WINDOW_AGG = Math.max(1, Math.round(AGG_PHASE_RPS * 0.15));
const PHASE_DURATION_SECONDS = Math.max(Math.floor(MINUTES * 60), 1);
const FIND_PHASE_START = '0s';
const AGG_PHASE_START = `${PHASE_DURATION_SECONDS}s`;

// ---------------------------------------------------------------------------
// k6 options — 2-phase execution (find first, then agg)
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    oned_eq_ts_find: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_EQ_TS_FIND),
      startTime: FIND_PHASE_START,
      exec:      'findOnedEqTsScenario',
      tags:      { scenario: 'oned_eq_ts_find' },
    },
    oned_eq_packed_find: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_EQ_PACKED_FIND),
      startTime: FIND_PHASE_START,
      exec:      'findOnedEqPackedScenario',
      tags:      { scenario: 'oned_eq_packed_find' },
    },
    oned_fno_ts_find: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_FNO_TS_FIND),
      startTime: FIND_PHASE_START,
      exec:      'findOnedFnoTsScenario',
      tags:      { scenario: 'oned_fno_ts_find' },
    },
    oned_fno_packed_find: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_FNO_PACKED_FIND),
      startTime: FIND_PHASE_START,
      exec:      'findOnedFnoPackedScenario',
      tags:      { scenario: 'oned_fno_packed_find' },
    },
    oned_eq_ts_5m_agg: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_EQ_TS_5M_AGG),
      startTime: AGG_PHASE_START,
      exec:      'aggOnedEqTs5mScenario',
      tags:      { scenario: 'oned_eq_ts_5m_agg' },
    },
    oned_eq_packed_5m_agg: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_EQ_PACKED_5M_AGG),
      startTime: AGG_PHASE_START,
      exec:      'aggOnedEqPacked5mScenario',
      tags:      { scenario: 'oned_eq_packed_5m_agg' },
    },
    oned_fno_ts_5m_agg: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_FNO_TS_5M_AGG),
      startTime: AGG_PHASE_START,
      exec:      'aggOnedFnoTs5mScenario',
      tags:      { scenario: 'oned_fno_ts_5m_agg' },
    },
    oned_fno_packed_5m_agg: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_ONED_FNO_PACKED_5M_AGG),
      startTime: AGG_PHASE_START,
      exec:      'aggOnedFnoPacked5mScenario',
      tags:      { scenario: 'oned_fno_packed_5m_agg' },
    },
    historic_ts_window_agg: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_HISTORIC_TS_WINDOW_AGG),
      startTime: AGG_PHASE_START,
      exec:      'aggHistoricTsWindowScenario',
      tags:      { scenario: 'historic_ts_window_agg' },
    },
    historic_packed_window_agg: {
      executor:  'ramping-arrival-rate',
      startRate: 0,
      timeUnit:  '1s',
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages:    buildRateStages(RATE_HISTORIC_PACKED_WINDOW_AGG),
      startTime: AGG_PHASE_START,
      exec:      'aggHistoricPackedWindowScenario',
      tags:      { scenario: 'historic_packed_window_agg' },
    },
  },
  // Surface all custom Trends in the end-of-test summary
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ---------------------------------------------------------------------------
// Setup — verify the API is ready
// ---------------------------------------------------------------------------
export function setup() {
  const res = http.get(`${API_BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(`API health check failed: ${res.status}`);
  }
  console.log('API health check passed');
  console.log(`Loaded ${SYMBOL_POOL_EQ.length} symbols for oned-eq`);
  console.log(`Loaded ${SYMBOL_POOL_HISTORIC.length} symbols for historic-eq`);
  console.log(`Loaded ${SYMBOL_POOL_FNO.length} symbols for oned-fno`);
  console.log(`Using packed collection ${ONED_EQ_PACKED_COLLECTION} with symbols_eq.csv`);
  console.log(`Using packed collection ${HISTORIC_EQ_PACKED_COLLECTION} with symbols_historic.csv`);
  console.log(`Using packed collection ${ONED_FNO_PACKED_COLLECTION} with symbols_fno.csv`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickRandomWindowByDays(minIso, maxIso, minDays, maxDays) {
  const minTs = new Date(minIso);
  const maxTs = new Date(maxIso);
  const totalMs = Math.max(maxTs - minTs, 1);
  const safeMinDays = Math.max(1, minDays);
  const safeMaxDays = Math.max(safeMinDays, maxDays);
  const randomDays = safeMinDays + Math.floor(Math.random() * (safeMaxDays - safeMinDays + 1));
  const windowMs = randomDays * 24 * 60 * 60 * 1000;

  if (totalMs <= windowMs) {
    return [minIso, maxIso];
  }

  const offsetMs = Math.random() * (totalMs - windowMs);
  const startTs = new Date(minTs.getTime() + offsetMs);
  const endTs = new Date(startTs.getTime() + windowMs);
  return [startTs.toISOString(), endTs.toISOString()];
}

// ---------------------------------------------------------------------------
// Shared execution helpers
// ---------------------------------------------------------------------------
function runFind(payload, latencyTrend, countTrend, attemptsCounter, failuresCounter) {
  attemptsCounter.add(1);

  const res = http.post(`${API_BASE_URL}/find`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'find' },
  });

  if (res.status !== 200) {
    findErrors.add(1);
    failuresCounter.add(1);
    httpErrors.add(1);
    return;
  }

  try {
    const body = JSON.parse(res.body);
    if (body.error) {
      findErrors.add(1);
      failuresCounter.add(1);
    } else if (body.duration_ms !== undefined) {
      latencyTrend.add(body.duration_ms);
      if (body.count !== undefined) {
        countTrend.add(body.count);
      }
    } else {
      findErrors.add(1);
      failuresCounter.add(1);
    }
  } catch (e) {
    findErrors.add(1);
    failuresCounter.add(1);
  }
}

function runAggregate(payload, latencyTrend, countTrend, attemptsCounter, failuresCounter) {
  attemptsCounter.add(1);

  const res = http.post(`${API_BASE_URL}/aggregate`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'aggregate' },
  });

  if (res.status !== 200) {
    aggErrors.add(1);
    failuresCounter.add(1);
    httpErrors.add(1);
    return;
  }

  try {
    const body = JSON.parse(res.body);
    if (body.error) {
      aggErrors.add(1);
      failuresCounter.add(1);
    } else if (body.duration_ms !== undefined) {
      const elapsedMs = body.duration_ms;
      latencyTrend.add(elapsedMs);
      if (body.count !== undefined) {
        countTrend.add(body.count);
      }
    } else {
      aggErrors.add(1);
      failuresCounter.add(1);
    }
  } catch (e) {
    aggErrors.add(1);
    failuresCounter.add(1);
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — find all 1-min candles for one EQ ID from oned-eq
// ---------------------------------------------------------------------------
export function findOnedEqTsScenario() {
  const symbol = randomChoice(SYMBOL_POOL_EQ);

  const payload = {
    collection: ONED_EQ_COLLECTION,
    filter: {
      id: symbol,
      ts: {
        $gte: ONED_START_TS,
        $lt: ONED_END_TS,
      },
    },
    projection: {
      _id: 0,
      id: 0,
    },
    sort: {
      ts: 1,
    },
  };

  runFind(payload, findOnedEqTsLatencyMs, findOnedEqTsCountDocs, findOnedEqTsAttempts, findOnedEqTsFailures);
}

// ---------------------------------------------------------------------------
// Scenario 2 — find packed 1d data for one EQ ID from oned-eq-packed
// ---------------------------------------------------------------------------
export function findOnedEqPackedScenario() {
  const symbol = randomChoice(SYMBOL_POOL_EQ);

  const payload = {
    collection: ONED_EQ_PACKED_COLLECTION,
    filter: {
      id: symbol,
    },
    projection: {
      _id: 0,
      'data.1d': 1,
      count: 1,
    },
  };

  runFind(payload, findOnedEqPackedLatencyMs, findOnedEqPackedCountDocs, findOnedEqPackedAttempts, findOnedEqPackedFailures);
}

// ---------------------------------------------------------------------------
// Scenario 3 — find all 1-min candles for one F&O ID from oned-fno
// ---------------------------------------------------------------------------
export function findOnedFnoTsScenario() {
  const symbol = randomChoice(SYMBOL_POOL_FNO);

  const payload = {
    collection: ONED_FNO_COLLECTION,
    filter: {
      id: symbol,
      ts: {
        $gte: FNO_START_TS,
        $lte: FNO_END_TS,
      },
    },
    projection: {
      _id: 0,
      id: 0,
    },
    sort: {
      ts: 1,
    },
  };

  runFind(payload, findOnedFnoTsLatencyMs, findOnedFnoTsCountDocs, findOnedFnoTsAttempts, findOnedFnoTsFailures);
}

// ---------------------------------------------------------------------------
// Scenario 4 — find packed 1d data for one F&O ID from oned-fno-packed
// ---------------------------------------------------------------------------
export function findOnedFnoPackedScenario() {
  const symbol = randomChoice(SYMBOL_POOL_FNO);

  const payload = {
    collection: ONED_FNO_PACKED_COLLECTION,
    filter: {
      id: symbol,
    },
    projection: {
      _id: 0,
      id: 0,
      'data.1d': 1,
      count: 1,
      firstTs: 1,
      lastTs: 1,
    },
  };

  runFind(payload, findOnedFnoPackedLatencyMs, findOnedFnoPackedCountDocs, findOnedFnoPackedAttempts, findOnedFnoPackedFailures);
}

// ---------------------------------------------------------------------------
// Scenario 5 — aggregate 5-min OHLC candles for one EQ ID from oned-eq
// ---------------------------------------------------------------------------
export function aggOnedEqTs5mScenario() {
  const symbol = randomChoice(SYMBOL_POOL_EQ);

  const payload = {
    collection: ONED_EQ_COLLECTION,
    pipeline: [
      {
        $match: {
          id: symbol,
          ts: {
            $gte: ONED_START_TS,
            $lt: ONED_END_TS,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$ts',
              unit: 'minute',
              binSize: 5,
            },
          },
          o: { $first: '$o' },
          h: { $max: '$h' },
          l: { $min: '$l' },
          c: { $last: '$c' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ],
  };

  runAggregate(payload, aggOnedEqTs5mLatencyMs, aggOnedEqTs5mCountDocs, aggOnedEqTs5mAttempts, aggOnedEqTs5mFailures);
}

// ---------------------------------------------------------------------------
// Scenario 6 — aggregate 5-min OHLC candles for one EQ ID from oned-eq-packed
// ---------------------------------------------------------------------------
export function aggOnedEqPacked5mScenario() {
  const symbol = randomChoice(SYMBOL_POOL_EQ);

  const payload = {
    collection: ONED_EQ_PACKED_COLLECTION,
    pipeline: [
      {
        $match: {
          id: symbol,
        },
      },
      {
        $unwind: '$data.1d',
      },
      {
        $addFields: {
          candleTs: {
            $convert: {
              input: '$data.1d.ts',
              to: 'date',
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $match: {
          candleTs: {
            $ne: null,
            $gte: ONED_START_TS,
            $lt: ONED_END_TS,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$candleTs',
              unit: 'minute',
              binSize: 5,
            },
          },
          o: { $first: '$data.1d.o' },
          h: { $max: '$data.1d.h' },
          l: { $min: '$data.1d.l' },
          c: { $last: '$data.1d.c' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ],
  };

  runAggregate(payload, aggOnedEqPacked5mLatencyMs, aggOnedEqPacked5mCountDocs, aggOnedEqPacked5mAttempts, aggOnedEqPacked5mFailures);
}

// ---------------------------------------------------------------------------
// Scenario 7 — aggregate 5-min OHLC candles for one F&O ID from oned-fno
// ---------------------------------------------------------------------------
export function aggOnedFnoTs5mScenario() {
  const symbol = randomChoice(SYMBOL_POOL_FNO);

  const payload = {
    collection: ONED_FNO_COLLECTION,
    pipeline: [
      {
        $match: {
          id: symbol,
          ts: {
            $gte: FNO_START_TS,
            $lte: FNO_END_TS,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$ts',
              unit: 'minute',
              binSize: 5,
            },
          },
          o: { $first: '$o' },
          h: { $max: '$h' },
          l: { $min: '$l' },
          c: { $last: '$c' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ],
  };

  runAggregate(payload, aggOnedFnoTs5mLatencyMs, aggOnedFnoTs5mCountDocs, aggOnedFnoTs5mAttempts, aggOnedFnoTs5mFailures);
}

// ---------------------------------------------------------------------------
// Scenario 8 — aggregate 5-min OHLC candles for one F&O ID from oned-fno-packed
// ---------------------------------------------------------------------------
export function aggOnedFnoPacked5mScenario() {
  const symbol = randomChoice(SYMBOL_POOL_FNO);

  const payload = {
    collection: ONED_FNO_PACKED_COLLECTION,
    pipeline: [
      {
        $match: {
          id: symbol,
        },
      },
      {
        $unwind: '$data.1d',
      },
      {
        $addFields: {
          candleTs: {
            $convert: {
              input: '$data.1d.ts',
              to: 'date',
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $match: {
          candleTs: {
            $ne: null,
            $gte: FNO_START_TS,
            $lte: FNO_END_TS,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$candleTs',
              unit: 'minute',
              binSize: 5,
            },
          },
          o: { $first: '$data.1d.o' },
          h: { $max: '$data.1d.h' },
          l: { $min: '$data.1d.l' },
          c: { $last: '$data.1d.c' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ],
  };

  runAggregate(payload, aggOnedFnoPacked5mLatencyMs, aggOnedFnoPacked5mCountDocs, aggOnedFnoPacked5mAttempts, aggOnedFnoPacked5mFailures);
}

// ---------------------------------------------------------------------------
// Scenario 9 — aggregate historic-eq in random 5-30 day windows at 5/15/30-min bins
// ---------------------------------------------------------------------------
export function aggHistoricTsWindowScenario() {
  const symbol = randomChoice(SYMBOL_POOL_HISTORIC);
  const binSize = randomChoice([5, 15, 30]);
  const [startTs, endTs] = pickRandomWindowByDays(AGG_MIN_TS, AGG_MAX_TS, HIST_WINDOW_MIN_DAYS, HIST_WINDOW_MAX_DAYS);

  const payload = {
    collection: HISTORIC_EQ_COLLECTION,
    pipeline: [
      {
        $match: {
          id: symbol,
          ts: {
            $gte: startTs,
            $lt: endTs,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$ts',
              unit: 'minute',
              binSize: binSize,
            },
          },
          o: { $first: '$o' },
          h: { $max: '$h' },
          l: { $min: '$l' },
          c: { $last: '$c' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ],
  };

  runAggregate(payload, aggHistoricTsWindowLatencyMs, aggHistoricTsWindowCountDocs, aggHistoricTsWindowAttempts, aggHistoricTsWindowFailures);
}

// ---------------------------------------------------------------------------
// Scenario 10 — aggregate historic-eq-packed in random 5-30 day windows at 5/15/30-min bins
// ---------------------------------------------------------------------------
export function aggHistoricPackedWindowScenario() {
  const symbol = randomChoice(SYMBOL_POOL_HISTORIC);
  const binSize = randomChoice([5, 15, 30]);
  const [startTs, endTs] = pickRandomWindowByDays(AGG_MIN_TS, AGG_MAX_TS, HIST_WINDOW_MIN_DAYS, HIST_WINDOW_MAX_DAYS);

  const payload = {
    collection: HISTORIC_EQ_PACKED_COLLECTION,
    pipeline: [
      {
        $match: {
          id: symbol,
        },
      },
      {
        $unwind: '$data.1d',
      },
      {
        $addFields: {
          candleTs: {
            $convert: {
              input: '$data.1d.ts',
              to: 'date',
              onError: null,
              onNull: null,
            },
          },
        },
      },
      {
        $match: {
          candleTs: {
            $ne: null,
            $gte: startTs,
            $lt: endTs,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$candleTs',
              unit: 'minute',
              binSize: binSize,
            },
          },
          o: { $first: '$data.1d.o' },
          h: { $max: '$data.1d.h' },
          l: { $min: '$data.1d.l' },
          c: { $last: '$data.1d.c' },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ],
  };

  runAggregate(payload, aggHistoricPackedWindowLatencyMs, aggHistoricPackedWindowCountDocs, aggHistoricPackedWindowAttempts, aggHistoricPackedWindowFailures);
}

function formatSummaryLine(name, metric) {
  if (!metric) {
    return `${name}: no successful samples recorded`;
  }

  const values = metric.values || {};
  if (metric.type === 'trend') {
    const avg = values.avg !== undefined ? values.avg.toFixed(2) : 'n/a';
    const p95 = values['p(95)'] !== undefined ? values['p(95)'].toFixed(2) : 'n/a';
    const p99 = values['p(99)'] !== undefined ? values['p(99)'].toFixed(2) : 'n/a';
    return `${name}: avg=${avg} p95=${p95} p99=${p99}`;
  }
  if (metric.type === 'counter') {
    const count = values.count !== undefined ? values.count : 'n/a';
    const rate = values.rate !== undefined ? values.rate.toFixed(2) : 'n/a';
    return `${name}: count=${count} rate=${rate}`;
  }
  return `${name}: ${JSON.stringify(values)}`;
}

export function handleSummary(data) {
  const metricsByName = data.metrics || {};

  const tsMetricNames = [
    'find_oned_eq_ts_attempts',
    'find_oned_eq_ts_failures',
    'find_oned_eq_ts_count',
    'find_oned_eq_ts_latency_ms',
    'find_oned_fno_ts_attempts',
    'find_oned_fno_ts_failures',
    'find_oned_fno_ts_count',
    'find_oned_fno_ts_latency_ms',
    'agg_oned_eq_ts_5m_attempts',
    'agg_oned_eq_ts_5m_failures',
    'agg_oned_eq_ts_5m_count',
    'agg_oned_eq_ts_5m_latency_ms',
    'agg_oned_fno_ts_5m_attempts',
    'agg_oned_fno_ts_5m_failures',
    'agg_oned_fno_ts_5m_count',
    'agg_oned_fno_ts_5m_latency_ms',
    'agg_historic_ts_window_attempts',
    'agg_historic_ts_window_failures',
    'agg_historic_ts_window_count',
    'agg_historic_ts_window_latency_ms',
    'find_errors',
    'agg_errors',
    'http_errors',
  ];

  const packedMetricNames = [
    'find_oned_eq_packed_attempts',
    'find_oned_eq_packed_failures',
    'find_oned_eq_packed_count',
    'find_oned_eq_packed_latency_ms',
    'find_oned_fno_packed_attempts',
    'find_oned_fno_packed_failures',
    'find_oned_fno_packed_count',
    'find_oned_fno_packed_latency_ms',
    'agg_oned_eq_packed_5m_attempts',
    'agg_oned_eq_packed_5m_failures',
    'agg_oned_eq_packed_5m_count',
    'agg_oned_eq_packed_5m_latency_ms',
    'agg_oned_fno_packed_5m_attempts',
    'agg_oned_fno_packed_5m_failures',
    'agg_oned_fno_packed_5m_count',
    'agg_oned_fno_packed_5m_latency_ms',
    'agg_historic_packed_window_attempts',
    'agg_historic_packed_window_failures',
    'agg_historic_packed_window_count',
    'agg_historic_packed_window_latency_ms',
  ];

  const lines = [];
  lines.push('=== TS Metrics ===');
  tsMetricNames.forEach((name) => {
    lines.push(formatSummaryLine(name, metricsByName[name]));
  });

  lines.push('');
  lines.push('=== Packed Metrics ===');
  packedMetricNames.forEach((name) => {
    lines.push(formatSummaryLine(name, metricsByName[name]));
  });

  lines.push('');
  lines.push('=== Full Raw Summary (JSON) ===');

  return {
    stdout: `${lines.join('\n')}\n`,
    'summary.json': JSON.stringify(data, null, 2),
  };
}
