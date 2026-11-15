// radar-4: a token launch radar whose price law is fitted, and then audited,
// on the snapshot's own record of launches that already happened.
//
// radar-3 (the previous model) priced a launch as TVL x a per-category median
// of the market-cap/TVL multiples of the 128 token-bearing protocols. radar-4
// starts from a measurement that model cannot express: on those 128 launches,
// market cap does not grow in proportion to TVL. A log-log fit gives
//
//     log(mcap) = 6.96 + 0.52 * log(TVL) + category offset
//
// so doubling TVL multiplies the expected cap by about 1.44, not 2: large
// protocols systematically launch at lower multiples, small ones at higher.
// radar-4 prices with that fitted law (per-category offsets shrunk toward
// zero with weight k = 6), then multiplies by the protocol's own growth,
// maturity and reach adjustments, and states a range instead of a point: the
// band is the model's own leave-one-out residual band for the category,
// shrunk toward the global band.
//
// The choice is not asserted, it is measured. looBacktest() below re-runs the
// exact leave-one-out audit of tools/backtest.mjs at build time: hide each of
// the 128 known caps, predict it with each method, and score the errors. The
// dashboard's Method and Comparables views print those live numbers, so the
// claim "this law prices launches better than a median multiple" is one the
// entry itself re-proves on the sealed snapshot every run.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

const DAY_MS = 86_400_000;
export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export function ageDays(p: Protocol, asOf: string): number {
  if (!p.listed_at) return 0;
  const t = new Date(`${p.listed_at}T00:00:00Z`).getTime();
  const a = new Date(`${asOf}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((a - t) / DAY_MS));
}

export const catOf = (p: Protocol): string => p.category ?? '(none)';

/** Type-7 quantile of an ascending-sorted array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  return sorted[lo]! + (h - lo) * (sorted[lo + 1]! - sorted[lo]!);
}

export function quantiles(values: number[]): { p25: number; med: number; p75: number } {
  const s = [...values].sort((a, b) => a - b);
  return { p25: quantile(s, 0.25), med: quantile(s, 0.5), p75: quantile(s, 0.75) };
}

/** Percentile of v inside xs: share of the field at or below v, 0..100. */
export function percentile(xs: number[], v: number): number {
  if (xs.length === 0) return 50;
  let less = 0, equal = 0;
  for (const x of xs) {
    if (x < v) less++;
    else if (x === v) equal++;
  }
  return ((less + 0.5 * equal) / xs.length) * 100;
}

// ---------------------------------------------------------------------------
// The adjustments both radar-3 and radar-4 apply on top of the price law:
// the protocol's own seven-day growth, its maturity, and its chain reach.
// The leave-one-out audit finds them roughly neutral for prediction; they are
// kept because they are the signals the bounty names, they are small, and
// every card prints them, so a reader can divide them back out.
// ---------------------------------------------------------------------------
export interface Adjustments { growth: number; maturity: number; reach: number; total: number }

export function adjustments(p: Protocol, asOf: string): Adjustments {
  const growth = 1 + 0.6 * (clamp(p.change_7d ?? 0, -50, 150) / 100);
  const maturity = 0.78 + 0.40 * (Math.min(ageDays(p, asOf), 1460) / 1460);
  const reach = 1 + 0.04 * Math.min(Math.max(p.chains.length - 1, 0), 4);
  return { growth, maturity, reach, total: growth * maturity * reach };
}

// ---------------------------------------------------------------------------
// The fitted law (radar-4's pricing core).
// ---------------------------------------------------------------------------
export interface CompRow { p: Protocol; mult: number }

export function comparablesOf(snap: Snapshot): CompRow[] {
  return snap.protocols
    .filter((p) => p.mcap_usd != null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => ({ p, mult: p.mcap_usd! / p.tvl_usd }));
}

export interface ElasticityFit {
  a: number;
  b: number;
  offsetOf: (category: string) => number;
  offsetN: (category: string) => number;
  /** Shrunk residual band (log space) for a category: the range multipliers. */
  bandOf: (category: string) => { lo: number; hi: number };
  globalBand: { lo: number; hi: number };
  n: number;
}

const SHRINK_K = 6;

export function fitElasticity(train: CompRow[]): ElasticityFit {
  const xs = train.map((t) => Math.log(t.p.tvl_usd));
  const ys = train.map((t) => Math.log(t.p.mcap_usd!));
  const n = train.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let cov = 0, varx = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i]! - mx) * (ys[i]! - my); varx += (xs[i]! - mx) ** 2; }
  const b = varx > 0 ? cov / varx : 1;
  const a = my - b * mx;

  const offSum = new Map<string, number>(), offN = new Map<string, number>();
  train.forEach((t, i) => {
    const c = catOf(t.p);
    offSum.set(c, (offSum.get(c) ?? 0) + (ys[i]! - (a + b * xs[i]!)));
    offN.set(c, (offN.get(c) ?? 0) + 1);
  });
  const offsetOf = (c: string): number => {
    const cnt = offN.get(c) ?? 0;
    if (cnt === 0) return 0;
    return (offSum.get(c)! / cnt) * (cnt / (cnt + SHRINK_K));
  };

  const residByCat = new Map<string, number[]>();
  const allResid: number[] = [];
  train.forEach((t, i) => {
    const r = ys[i]! - (a + b * xs[i]! + offsetOf(catOf(t.p)));
    allResid.push(r);
    const c = catOf(t.p);
    if (!residByCat.has(c)) residByCat.set(c, []);
    residByCat.get(c)!.push(r);
  });
  const gq = quantiles(allResid);
  const globalBand = { lo: gq.p25, hi: gq.p75 };
  const bandOf = (c: string): { lo: number; hi: number } => {
    const cell = residByCat.get(c);
    const cnt = cell ? cell.length : 0;
    if (!cell || cnt === 0) return globalBand;
    const own = quantiles(cell);
    return {
      lo: (cnt * own.p25 + SHRINK_K * gq.p25) / (cnt + SHRINK_K),
      hi: (cnt * own.p75 + SHRINK_K * gq.p75) / (cnt + SHRINK_K),
    };
  };
  return { a, b, offsetOf, offsetN: (c) => offN.get(c) ?? 0, bandOf, globalBand, n };
}

export interface Prediction { base: number; low: number; high: number; multiple: number }

export function predict(fit: ElasticityFit, p: Protocol, asOf: string): Prediction {
  const adj = adjustments(p, asOf).total;
  const baseLog = fit.a + fit.b * Math.log(p.tvl_usd) + fit.offsetOf(catOf(p));
  const band = fit.bandOf(catOf(p));
  const base = Math.exp(baseLog) * adj;
  return {
    base,
    low: Math.exp(baseLog + band.lo) * adj,
    high: Math.exp(baseLog + band.hi) * adj,
    multiple: base / p.tvl_usd,
  };
}

// ---------------------------------------------------------------------------
// Leave-one-out audit. For each token-bearing protocol: hide its cap, fit
// each method on the other 127, predict, and score. radar-3 is implemented
// exactly as its report specifies (clamped per-category shrunk quantiles,
// range widened x0.90 / x1.10); radar-4's range in each fold comes from an
// inner leave-one-out over the fold's training rows, so its band is as
// honest as the quantile method's, which excludes the target by construction.
// ---------------------------------------------------------------------------
export interface BacktestStats {
  medAbsErr: number;
  meanAbsErr: number;
  bias: number;
  coverage: number;
  width: number;
  winkler: number;
}

export interface BacktestRow {
  slug: string;
  actual: number;
  predBase: number;
  predLow: number;
  predHigh: number;
}

function scoreBacktest(rows: BacktestRow[]): BacktestStats {
  const errs: number[] = [], biases: number[] = [], widths: number[] = [], winklers: number[] = [];
  let covered = 0;
  for (const r of rows) {
    const e = Math.log10(r.predBase / r.actual);
    errs.push(Math.abs(e));
    biases.push(e);
    const la = Math.log10(r.actual), ll = Math.log10(r.predLow), lh = Math.log10(r.predHigh);
    if (r.actual >= r.predLow && r.actual <= r.predHigh) covered++;
    widths.push(lh - ll);
    let w = lh - ll;
    if (la < ll) w += 4 * (ll - la);
    if (la > lh) w += 4 * (la - lh);
    winklers.push(w);
  }
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const med = (xs: number[]) => quantile([...xs].sort((x, y) => x - y), 0.5);
  return {
    medAbsErr: med(errs), meanAbsErr: mean(errs), bias: med(biases),
    coverage: covered / rows.length, width: mean(widths), winkler: mean(winklers),
  };
}

/** radar-3's multiple estimator, as specified in its report. */
function radar3Multiples(train: CompRow[], target: Protocol): { low: number; base: number; high: number } {
  const cl = (m: number) => clamp(m, 0.005, 6);
  const gq = quantiles(train.map((t) => cl(t.mult)));
  const own = train.filter((t) => catOf(t.p) === catOf(target));
  const n = own.length;
  const oq = n > 0 ? quantiles(own.map((t) => cl(t.mult))) : gq;
  const used = {
    p25: (n * oq.p25 + 6 * gq.p25) / (n + 6),
    med: (n * oq.med + 6 * gq.med) / (n + 6),
    p75: (n * oq.p75 + 6 * gq.p75) / (n + 6),
  };
  return { low: used.p25 * 0.9, base: used.med, high: used.p75 * 1.1 };
}

/** A launched protocol of the kind the board prices (not a custodial product). */
export function isBoardLikeLaunched(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((e) => p.name === e || p.name.startsWith(`${e} `))) return false;
  return true;
}

export function looBacktest(universe: CompRow[], asOf: string): {
  radar3: BacktestStats;
  radar4: BacktestStats;
  radar3BoardLike: BacktestStats;
  radar4BoardLike: BacktestStats;
  boardLikeN: number;
  radar4Rows: BacktestRow[];
} {
  const rows3: BacktestRow[] = [];
  const rows4: BacktestRow[] = [];
  for (let i = 0; i < universe.length; i++) {
    const target = universe[i]!;
    const train = universe.filter((_, j) => j !== i);
    const adj = adjustments(target.p, asOf).total;
    const actual = target.p.mcap_usd!;

    const m3 = radar3Multiples(train, target.p);
    rows3.push({
      slug: target.p.slug, actual,
      predBase: target.p.tvl_usd * m3.base * adj,
      predLow: target.p.tvl_usd * m3.low * adj,
      predHigh: target.p.tvl_usd * m3.high * adj,
    });

    // radar-4 fold: fit on the 127, and calibrate the band by an inner
    // leave-one-out over those 127 so the target never touches its own band.
    const fit = fitElasticity(train);
    const innerResid: number[] = [];
    const innerByCat = new Map<string, number[]>();
    for (let j = 0; j < train.length; j++) {
      const inner = train.filter((_, k) => k !== j);
      const f = fitElasticity(inner);
      const tj = train[j]!;
      const r = Math.log(tj.p.mcap_usd!) - (f.a + f.b * Math.log(tj.p.tvl_usd) + f.offsetOf(catOf(tj.p)));
      innerResid.push(r);
      const c = catOf(tj.p);
      if (!innerByCat.has(c)) innerByCat.set(c, []);
      innerByCat.get(c)!.push(r);
    }
    const gq = quantiles(innerResid);
    const cell = innerByCat.get(catOf(target.p));
    const cnt = cell ? cell.length : 0;
    const own = cell ? quantiles(cell) : gq;
    const band = {
      lo: (cnt * own.p25 + SHRINK_K * gq.p25) / (cnt + SHRINK_K),
      hi: (cnt * own.p75 + SHRINK_K * gq.p75) / (cnt + SHRINK_K),
    };
    const baseLog = fit.a + fit.b * Math.log(target.p.tvl_usd) + fit.offsetOf(catOf(target.p));
    rows4.push({
      slug: target.p.slug, actual,
      predBase: Math.exp(baseLog) * adj,
      predLow: Math.exp(baseLog + band.lo) * adj,
      predHigh: Math.exp(baseLog + band.hi) * adj,
    });
  }
  const like = new Set(universe.filter((t) => isBoardLikeLaunched(t.p)).map((t) => t.p.slug));
  return {
    radar3: scoreBacktest(rows3),
    radar4: scoreBacktest(rows4),
    radar3BoardLike: scoreBacktest(rows3.filter((r) => like.has(r.slug))),
    radar4BoardLike: scoreBacktest(rows4.filter((r) => like.has(r.slug))),
    boardLikeN: like.size,
    radar4Rows: rows4,
  };
}

// ---------------------------------------------------------------------------
// Board eligibility. A row must record no token and must not be a wrapped,
// staked, bridged or exchange product of a token that already trades: those
// are not launches waiting to happen. The filter is the house watchlist rule
// plus the bridge categories (a bridge's "launch" is its parent asset's
// price, not its own), and it keeps every one of the 40 watchlist protocols.
// ---------------------------------------------------------------------------
const EXCLUDED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Cross Chain Bridge',
  'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

export function isBoardEligible(p: Protocol): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((e) => p.name === e || p.name.startsWith(`${e} `))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Audit score. Rank follows implied value; the score exists so a reader can
// audit the rank. Six percentiles measured inside the ranked universe:
// scale, momentum, maturity, reach, category premium (the fitted offset),
// and calibration (a narrow honest band scores high: the model is sure).
// ---------------------------------------------------------------------------
export interface AuditCard {
  score: number;
  confidence: 'A' | 'B' | 'C';
  components: { key: string; label: string; value: number; weight: number }[];
  reasons: string[];
  risks: string[];
  multiple: number;
  categoryN: number;
  categoryOffset: number;
  widthLog10: number;
}

const money = (x: number): string => {
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(0)}K`;
  return `$${Math.round(x)}`;
};

// ---------------------------------------------------------------------------
// Farm plans. Eight steps, specialised by category family, each carrying an
// explicit cost and time. The figures are planning estimates from the
// protocol's own record (TVL tier sets the capital band, chain count sets
// the weekly minutes); the plan says so, and its second step warns when no
// points or eligibility program can be confirmed from the record.
// ---------------------------------------------------------------------------
type Family = 'lending' | 'trade' | 'yield' | 'rwa' | 'chain' | 'payments' | 'default';

function familyOf(category: string | null): Family {
  switch (category) {
    case 'Lending': case 'CDP': case 'CDP Manager': case 'Uncollateralized Lending':
    case 'Collateral Markets': case 'Collateral Management':
      return 'lending';
    case 'Dexs': case 'Derivatives': case 'Interest Rate Derivatives': case 'Options':
      return 'trade';
    case 'Yield': case 'Yield Aggregator': case 'Risk Curators': case 'Onchain Capital Allocator':
    case 'Liquidity Manager': case 'Basis Trading': case 'Leveraged Farming': case 'Farm':
      return 'yield';
    case 'RWA': case 'Indexes':
      return 'rwa';
    case 'Chain':
      return 'chain';
    case 'Payments': case 'Crypto Card Issuer':
      return 'payments';
    default:
      return 'default';
  }
}

const PRIMARY_ACTION: Record<Family, (name: string) => string> = {
  lending: (n) => `Supply a blue-chip collateral asset (ETH or a major stablecoin) on ${n} and borrow a small, safe amount against it, keeping the health factor above 2.0 so both sides of the market see the wallet`,
  trade: (n) => `Provide two-sided liquidity to a core pool on ${n} inside a tight range, and place real swaps through the same account so the wallet shows both maker and taker history`,
  yield: (n) => `Deposit into ${n}'s flagship vault or strategy and leave the position untouched for a full week so the deposit ages past any same-day snapshot filters`,
  rwa: (n) => `Complete ${n}'s onboarding or KYC if it asks for it, then mint or buy a small position in its flagship real-world asset so the wallet holds the asset itself`,
  chain: (n) => `Bridge a small amount to ${n} and deploy one trivial contract (a counter or a token) so the wallet has deployment history, not just transfers`,
  payments: (n) => `Route real small payments through ${n} — pay an invoice or a card charge you would have made anyway — so the wallet shows genuine payment volume, not test dust`,
  default: (n) => `Use ${n}'s flagship product end to end once (deposit, act, withdraw a part) so the wallet completes the full user journey a snapshot would measure`,
};

const SECOND_ACTION: Record<Family, string> = {
  lending: 'Open a second, different market on the same account (a different collateral or a stablecoin borrow) so the wallet is active in two markets, not one',
  trade: 'Trade a second pair or a second pool tier, and leave one limit-style order resting for a day if the venue supports it',
  yield: 'Split a second deposit into a different vault or strategy of the same protocol, so two independent positions age in parallel',
  rwa: 'Add a second, smaller position in a different asset or maturity on the same account, and hold both through a full distribution or reporting date',
  chain: 'Interact with two native dApps on the chain (a swap and a lending market) so the wallet has application-level history on top of the deployment',
  payments: 'Make the payment habit weekly: one real payment a week through the same route, and keep the receipts the service issues',
  default: 'Repeat the flagship action from a second angle the product offers (a second market, vault, pool or module) so activity is not a single touch',
};

export interface PlanTotals { capitalLow: number; capitalHigh: number; weeklyMinutes: number; holdDays: number }

export function planTotals(p: Protocol, asOf: string): PlanTotals {
  const tvl = p.tvl_usd;
  const band = tvl >= 1e9 ? [500, 2500] : tvl >= 5e8 ? [400, 2000] : tvl >= 2.5e8 ? [300, 1500]
    : tvl >= 1e8 ? [200, 1000] : tvl >= 5e7 ? [100, 750] : [50, 400];
  const age = ageDays(p, asOf);
  return {
    capitalLow: band[0]!, capitalHigh: band[1]!,
    weeklyMinutes: 20 + 5 * Math.min(p.chains.length, 4),
    holdDays: age < 180 ? 120 : age < 540 ? 90 : 60,
  };
}

export function buildFarmPlan(p: Protocol, asOf: string, totals: PlanTotals): string[] {
  const fam = familyOf(p.category);
  const chain0 = p.chains[0] ?? 'Ethereum';
  const multi = p.chains.length > 1;
  const hold = totals.holdDays;
  const cap = `$${totals.capitalLow}–$${totals.capitalHigh}`;
  const steps: string[] = [
    `Set up one fresh wallet for ${p.name} alone and fund it with ${cap} plus gas money on ${chain0}. Cost: about $5 in funding gas. Time: 20 minutes, once. A dedicated wallet keeps this farm separable from your main accounts.`,
    `Reconnaissance first: read ${p.name}'s own docs, app and social channels for a points, season or eligibility program and note its exact rules and snapshot hints. Cost: $0. Time: 30 minutes. If no program can be confirmed, farm only the steps you would do anyway — the record alone cannot prove one exists.`,
    `${PRIMARY_ACTION[fam](p.name)}. Cost: the ${cap} capital, locked while the position runs, plus roughly $8–25 in gas and fees. Time: about 30 minutes to open carefully.`,
    `${SECOND_ACTION[fam]}. Cost: $0–10 in gas, no new capital if you split the first position. Time: 20 minutes. Two surfaces of activity read as a real user, not a single scripted touch.`,
    multi
      ? `Extend to a second chain: ${p.name} records TVL on ${p.chains.length} chains (${p.chains.slice(0, 3).join(', ')}). Repeat the primary action with a small amount on one more chain. Cost: $10–30 in bridge and gas fees. Time: 30 minutes.`
      : `Deepen instead of spreading: ${p.name} records TVL on ${chain0} only, so add a second deposit tranche to the main position after two weeks rather than opening dust elsewhere. Cost: $5–10 in gas. Time: 15 minutes.`,
    `Hold a weekly cadence for ${hold} days: one genuine interaction a week (claim and restake rewards, rebalance, or a small top-up), about ${totals.weeklyMinutes} minutes a week. Cost: $2–8 a week in gas. Log every action with its date and transaction hash in a spreadsheet as you go.`,
    `Watch the exit-early signals while you hold: leave early if ${p.name}'s TVL falls four weeks in a row, if the team announces a token whose snapshot already passed, or if a confirmed program's rules exclude your route. Cost: $0 to watch. Time: 5 minutes a week alongside the cadence step.`,
    `Exit in two tranches if a token launches: claim in the first week, sell half of the claim within that week, and work the rest out over the following month instead of dumping into listing-day volatility. Cost: claim gas plus swap fees, roughly $10–40. Time: 1 hour across the month.`,
  ];
  return steps.map((s) => s.trim());
}

// ---------------------------------------------------------------------------
// The board.
// ---------------------------------------------------------------------------
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  low_usd: number;
  high_usd: number;
  multiple: number;
  score: number;
  confidence: 'A' | 'B' | 'C';
  watchlist: boolean;
  components: Record<string, number>;
  reasons: string[];
  risks: string[];
  evidence: string;
  plan: PlanTotals;
}

export interface CategoryEvidence {
  category: string;
  comparables: number;
  offset: number;
  boardRows: number;
}

export interface ComparableRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
  loo_pred_usd: number;
  loo_err_log10: number;
  loo_in_band: boolean;
}

export interface Radar {
  asOf: string;
  source: string;
  floorUsd: number;
  counts: { protocols: number; watchlist: number; board: number; comparables: number };
  fit: { a: number; b: number; shrinkK: number; globalBandLo: number; globalBandHi: number; medianMultiple: number };
  backtest: { radar3: BacktestStats; radar4: BacktestStats; radar3BoardLike: BacktestStats; radar4BoardLike: BacktestStats; boardLikeN: number };
  categories: CategoryEvidence[];
  comparables: ComparableRow[];
  rows: BoardRow[];
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const round1 = (x: number): number => Math.round(x * 10) / 10;

function riskFlags(p: Protocol, asOf: string, fit: ElasticityFit, pred: Prediction, floor: number): string[] {
  const risks: string[] = [];
  const age = ageDays(p, asOf);
  const n = fit.offsetN(catOf(p));
  const width = Math.log10(pred.high / pred.low);
  if (p.change_7d !== null && p.change_7d <= -15) risks.push(`TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in seven days — the record is shrinking, not building toward a launch.`);
  if (p.change_7d === null) risks.push('Seven-day change is unreported, so momentum cannot be checked either way.');
  if (p.change_7d !== null && p.change_7d >= 100) risks.push(`TVL rose ${p.change_7d.toFixed(0)}% in seven days — a move that large is usually one deposit, not a trend; the growth adjustment may overpay it.`);
  if (p.listed_at === null) risks.push('Listing date is unreported, so the protocol\u2019s age cannot be verified.');
  else if (age < 90) risks.push(`Tracked for only ${age} days — a short record, and young protocols reprice or vanish more often.`);
  if (p.chains.length === 1) risks.push(`Single chain (${p.chains[0] ?? 'unknown'}): no second deployment to spread execution or snapshot risk.`);
  if (n === 0) risks.push(`${catOf(p)} has no tokenised comparable in the snapshot, so this row is priced by the global law alone, with no category evidence.`);
  else if (n === 1) risks.push(`Category evidence rests on a single tokenised comparable — one protocol's market mood moves this row's price.`);
  else if (n <= 4) risks.push(`Thin category evidence: only ${n} tokenised comparables anchor the category offset.`);
  if (pred.multiple < 0.1) risks.push(`The fitted multiple is ${pred.multiple.toFixed(3)}x — protocols of this kind and size have launched cheap; the prize may be smaller than the TVL suggests.`);
  if (width >= 1.3) risks.push(`The honest band is ${(pred.high / pred.low).toFixed(0)}x wide — the model's own error history on this kind is broad, so treat the base value as the centre of a wide range.`);
  if (p.tvl_usd < floor) risks.push(`Below the ${money(floor)} watchlist floor: early scale, where records are shortest and failure is commonest.`);
  return risks;
}

export function buildRadar(snap: Snapshot): { board: BoardRow[]; radar: Radar } {
  const asOf = snap.as_of;
  const universe = comparablesOf(snap);
  const fit = fitElasticity(universe);
  const bt = looBacktest(universe, asOf);
  const looBySlug = new Map(bt.radar4Rows.map((r) => [r.slug, r]));

  const watch = new Set(snap.watchlist);
  const candidates = snap.protocols.filter(isBoardEligible);

  // Percentile fields over the board universe.
  const logTvls = candidates.map((p) => Math.log(p.tvl_usd));
  const changes = candidates.map((p) => p.change_7d).filter((x): x is number => x !== null);
  const ages = candidates.map((p) => ageDays(p, asOf));
  const chainCounts = candidates.map((p) => p.chains.length);
  const boardCats = [...new Set(candidates.map((p) => catOf(p)))];
  const catOffsets = boardCats.map((c) => fit.offsetOf(c));

  interface Draft {
    p: Protocol;
    pred: Prediction;
    implied: number;
    totals: PlanTotals;
  }
  const drafts: Draft[] = candidates.map((p) => {
    const pred = predict(fit, p, asOf);
    return { p, pred, implied: Math.max(1, Math.round(pred.base)), totals: planTotals(p, asOf) };
  });
  drafts.sort((x, y) => (y.implied - x.implied) || (x.p.slug < y.p.slug ? -1 : 1));
  // Ranks must carry strictly non-increasing, distinct implied values.
  for (let i = 1; i < drafts.length; i++) {
    if (drafts[i]!.implied >= drafts[i - 1]!.implied) drafts[i]!.implied = drafts[i - 1]!.implied - 1;
  }

  const board: BoardRow[] = drafts.map((d, i) => {
    const p = d.p;
    const cat = catOf(p);
    const n = fit.offsetN(cat);
    const widthLog10 = Math.log10(d.pred.high / d.pred.low);
    const comp = {
      scale: round1(percentile(logTvls, Math.log(p.tvl_usd))),
      momentum: round1(p.change_7d === null ? 50 : percentile(changes, p.change_7d)),
      maturity: round1(percentile(ages, ageDays(p, asOf))),
      reach: round1(percentile(chainCounts, p.chains.length)),
      premium: round1(percentile(catOffsets, fit.offsetOf(cat))),
      calibration: round1(100 - percentile(drafts.map((x) => Math.log10(x.pred.high / x.pred.low)), widthLog10)),
    };
    const weights: Record<string, number> = { scale: 24, momentum: 16, maturity: 14, reach: 10, premium: 18, calibration: 18 };
    const score = Math.max(1, Math.min(99, Math.round(
      (comp.scale * 24 + comp.momentum * 16 + comp.maturity * 14 + comp.reach * 10 + comp.premium * 18 + comp.calibration * 18) / 100,
    )));
    const confidence: 'A' | 'B' | 'C' = n >= 8 && widthLog10 <= 1.05 ? 'A' : n <= 1 || widthLog10 >= 1.3 ? 'C' : 'B';
    const age = ageDays(p, asOf);
    const reasonText: Record<string, string> = {
      scale: `Scale, ${comp.scale.toFixed(0)}th percentile: ${money(p.tvl_usd)} of TVL, and the fitted law prices size before anything else.`,
      momentum: p.change_7d === null
        ? `Momentum unscored at the midpoint: the seven-day change is unreported.`
        : `Momentum, ${comp.momentum.toFixed(0)}th percentile: TVL moved ${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}% in seven days.`,
      maturity: `Maturity, ${comp.maturity.toFixed(0)}th percentile: tracked ${age} days with no token recorded — a long pre-token record.`,
      reach: `Reach, ${comp.reach.toFixed(0)}th percentile: live on ${p.chains.length} chain${p.chains.length === 1 ? '' : 's'} (${p.chains.slice(0, 3).join(', ')}).`,
      premium: `Category premium, ${comp.premium.toFixed(0)}th percentile: ${cat} launches carry a fitted offset of ${fit.offsetOf(cat) >= 0 ? '+' : ''}${fit.offsetOf(cat).toFixed(2)} log points, from ${n} comparable${n === 1 ? '' : 's'}.`,
      calibration: `Calibration, ${comp.calibration.toFixed(0)}th percentile: the honest band is ${(d.pred.high / d.pred.low).toFixed(1)}x wide, narrower than most of the board.`,
    };
    const reasons = Object.keys(comp)
      .sort((x, y) => comp[y]! * weights[y]! - comp[x]! * weights[x]!)
      .slice(0, 3)
      .map((k) => reasonText[k]!);
    const risks = riskFlags(p, asOf, fit, d.pred, snap.floor_usd);
    const low = Math.max(1, Math.min(Math.floor(d.pred.low), d.implied));
    const high = Math.max(Math.ceil(d.pred.high), d.implied);
    return {
      slug: p.slug,
      name: p.name,
      rank: i + 1,
      implied_value_usd: d.implied,
      farm_steps: buildFarmPlan(p, asOf, d.totals),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: age,
      low_usd: low,
      high_usd: high,
      multiple: round4(d.implied / p.tvl_usd),
      score,
      confidence,
      watchlist: watch.has(p.slug),
      components: comp,
      reasons,
      risks: risks.length > 0 ? risks : ['No flag fires on the snapshot\u2019s record for this protocol.'],
      evidence: `Elasticity law on ${universe.length} launches: category offset ${fit.offsetOf(cat) >= 0 ? '+' : ''}${fit.offsetOf(cat).toFixed(2)} log points from ${n} comparable${n === 1 ? '' : 's'}; residual band x${Math.exp(fit.bandOf(cat).lo).toFixed(2)} to x${Math.exp(fit.bandOf(cat).hi).toFixed(2)}.`,
      plan: d.totals,
    };
  });

  const categories: CategoryEvidence[] = boardCats
    .map((c) => ({
      category: c,
      comparables: fit.offsetN(c),
      offset: round4(fit.offsetOf(c)),
      boardRows: board.filter((r) => (r.category ?? '(none)') === c).length,
    }))
    .sort((x, y) => y.offset - x.offset);

  const comparables: ComparableRow[] = universe
    .map((t) => {
      const loo = looBySlug.get(t.p.slug);
      return {
        slug: t.p.slug,
        name: t.p.name,
        symbol: t.p.symbol,
        category: t.p.category,
        tvl_usd: t.p.tvl_usd,
        mcap_usd: t.p.mcap_usd!,
        multiple: round4(t.mult),
        loo_pred_usd: loo ? Math.round(loo.predBase) : 0,
        loo_err_log10: loo ? round4(Math.log10(loo.predBase / loo.actual)) : 0,
        loo_in_band: loo ? t.p.mcap_usd! >= loo.predLow && t.p.mcap_usd! <= loo.predHigh : false,
      };
    })
    .sort((x, y) => y.mcap_usd - x.mcap_usd);

  const allMults = universe.map((t) => t.mult).sort((a, b) => a - b);
  const radar: Radar = {
    asOf,
    source: snap.source,
    floorUsd: snap.floor_usd,
    counts: { protocols: snap.protocols.length, watchlist: snap.watchlist.length, board: board.length, comparables: universe.length },
    fit: {
      a: round4(fit.a), b: round4(fit.b), shrinkK: SHRINK_K,
      globalBandLo: round4(Math.exp(fit.globalBand.lo)), globalBandHi: round4(Math.exp(fit.globalBand.hi)),
      medianMultiple: round4(quantile(allMults, 0.5)),
    },
    backtest: {
      radar3: {
        medAbsErr: round4(bt.radar3.medAbsErr), meanAbsErr: round4(bt.radar3.meanAbsErr), bias: round4(bt.radar3.bias),
        coverage: round4(bt.radar3.coverage), width: round4(bt.radar3.width), winkler: round4(bt.radar3.winkler),
      },
      radar4: {
        medAbsErr: round4(bt.radar4.medAbsErr), meanAbsErr: round4(bt.radar4.meanAbsErr), bias: round4(bt.radar4.bias),
        coverage: round4(bt.radar4.coverage), width: round4(bt.radar4.width), winkler: round4(bt.radar4.winkler),
      },
      radar3BoardLike: {
        medAbsErr: round4(bt.radar3BoardLike.medAbsErr), meanAbsErr: round4(bt.radar3BoardLike.meanAbsErr), bias: round4(bt.radar3BoardLike.bias),
        coverage: round4(bt.radar3BoardLike.coverage), width: round4(bt.radar3BoardLike.width), winkler: round4(bt.radar3BoardLike.winkler),
      },
      radar4BoardLike: {
        medAbsErr: round4(bt.radar4BoardLike.medAbsErr), meanAbsErr: round4(bt.radar4BoardLike.meanAbsErr), bias: round4(bt.radar4BoardLike.bias),
        coverage: round4(bt.radar4BoardLike.coverage), width: round4(bt.radar4BoardLike.width), winkler: round4(bt.radar4BoardLike.winkler),
      },
      boardLikeN: bt.boardLikeN,
    },
    categories,
    comparables,
    rows: board,
  };
  return { board, radar };
}

/** The gate's shape, checked before anything is written. Null means valid. */
export function boardIssue(board: BoardRow[], snap: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(snap.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Number.POSITIVE_INFINITY;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (!slugs.has(r.slug)) return `row ${i + 1}: slug ${r.slug} is not in the snapshot`;
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (r.rank !== i + 1) return `row ${i + 1}: rank is ${r.rank}`;
    if (!(r.implied_value_usd >= 1) || r.implied_value_usd > 1e14) return `row ${i + 1}: implied value out of range`;
    if (r.implied_value_usd > prev) return `row ${i + 1}: implied value rises as rank ascends`;
    prev = r.implied_value_usd;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${i + 1}: ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim().length;
      if (t < 20 || t > 600) return `row ${i + 1}: a farm step is ${t} characters once trimmed`;
    }
  }
  for (const slug of snap.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data, written beside the page as data.js. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};\n`;
}
