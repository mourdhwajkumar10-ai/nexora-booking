/**
 * NFR-01 load test: availability endpoint under 50 concurrent requests for one venue.
 * Usage (API running on :4000 with seeded demo data):
 *   npm run loadtest -w @nexora/api -- [--venue ember-and-oak] [--concurrency 50] [--seconds 10]
 * Pass criteria: p95 <= 200 ms, 0 errors.
 */
export {};

const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const BASE = process.env.API_URL ?? 'http://localhost:4000';
const venue = args.venue ?? 'ember-and-oak';
const concurrency = Number(args.concurrency ?? 50);
const seconds = Number(args.seconds ?? 10);

const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
  new Date(Date.now() + 86_400_000),
);
const url = `${BASE}/api/v1/venues/${venue}/availability?date=${date}&partySize=2`;

const latencies: number[] = [];
let errors = 0;
const deadline = Date.now() + seconds * 1000;

async function worker() {
  while (Date.now() < deadline) {
    const t0 = performance.now();
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      if (!res.ok) errors++;
    } catch {
      errors++;
    }
    latencies.push(performance.now() - t0);
  }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

console.log(`GET ${url}\n${concurrency} concurrent workers for ${seconds}s…`);
await Promise.all(Array.from({ length: concurrency }, worker));
const s = latencies.sort((a, b) => a - b);
const report = {
  requests: s.length,
  errors,
  rps: Math.round(s.length / seconds),
  p50: +pct(s, 50).toFixed(1),
  p95: +pct(s, 95).toFixed(1),
  p99: +pct(s, 99).toFixed(1),
  max: +s[s.length - 1].toFixed(1),
};
console.table(report);
const pass = report.p95 <= 200 && errors === 0;
console.log(pass ? 'PASS: p95 <= 200 ms with 0 errors' : 'FAIL: NFR-01 threshold not met');
process.exit(pass ? 0 : 1);
