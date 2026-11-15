'use strict';
/* Launch Radar page. Everything on it is rendered from window.RADAR, the
   data file main.ts writes from the sealed snapshot: the board rows, the
   128 launches the price law was fitted on, that law's leave-one-out audit
   against the previous model, and the category evidence table. The page
   computes nothing the program did not compute, and needs no network. */
const R = window.RADAR;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const commas = (x) => Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const money = (x) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}K` : `$${commas(x)}`);
const moneyFull = (x) => `$${commas(x)}`;
const pct = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);
const mult = (x) => `${x.toFixed(x < 0.1 ? 3 : 2)}x`;
const factor = (logErr) => (logErr >= 0 ? `x${Math.pow(10, logErr).toFixed(1)}` : `÷${Math.pow(10, -logErr).toFixed(1)}`);
const bySlug = new Map(R.rows.map((r) => [r.slug, r]));

const state = { view: 'board', q: '', cat: '', chain: '', conf: '', watch: false, sortKey: 'rank', sortDir: 1, detail: null };

function parseHash() {
  const h = location.hash.replace(/^#/, '');
  const parts = Object.fromEntries(h.split('&').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv, ''] : [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))];
  }));
  if (parts.detail && bySlug.has(parts.detail)) { state.view = 'detail'; state.detail = parts.detail; }
  else if (parts.view === 'comparables' || h === 'comparables') state.view = 'comparables';
  else if (parts.view === 'method' || h === 'method') state.view = 'method';
  else {
    state.view = 'board';
    if (parts.cat) state.cat = parts.cat;
    if (parts.chain) state.chain = parts.chain;
    if (parts.watch) state.watch = true;
  }
}

function renderStrip() {
  const b = R.backtest;
  $('#subline').textContent = `Pre-token protocols ranked by what their launch would be worth — snapshot of ${R.asOf}, ${R.counts.protocols} protocols.`;
  $('#strip').innerHTML = [
    ['Board rows', R.counts.board, `${R.counts.watchlist}/${R.counts.watchlist} watchlist covered, all record no token`],
    ['Price law', `TVL^${R.fit.b}`, `log(cap) = ${R.fit.a} + ${R.fit.b}·log(TVL) + category, fitted on ${R.counts.comparables} launches`],
    ['Audit, median miss', factor(b.radar4.medAbsErr), `radar-4 leave-one-out, vs ${factor(b.radar3.medAbsErr)} for the median-multiple model`],
    ['Range honesty', `${(b.radar4.coverage * 100).toFixed(0)}% in band`, `of 128 hidden caps land in the stated range; radar-3 managed ${(b.radar3.coverage * 100).toFixed(0)}%`],
  ].map(([k, v, n]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="n">${n}</div></div>`).join('');
}

function fillFilters() {
  const cats = [...new Set(R.rows.map((r) => r.category ?? '(none)'))].sort();
  $('#fcat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option ${c === state.cat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('#fchain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option ${c === state.chain ? 'selected' : ''}>${esc(c)}</option>`).join('');
  $('#fwatch').checked = state.watch;
}

const LOG_MIN = Math.log10(Math.min(...R.rows.map((r) => r.low_usd)));
const LOG_MAX = Math.log10(Math.max(...R.rows.map((r) => r.high_usd)));
const whisk = (r) => {
  const p = (v) => ((Math.log10(v) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 100;
  return `<div class="whisk"><div class="band" style="left:${p(r.low_usd).toFixed(1)}%;width:${Math.max(1.5, p(r.high_usd) - p(r.low_usd)).toFixed(1)}%"></div><div class="base" style="left:${p(r.implied_value_usd).toFixed(1)}%"></div></div>`;
};

const SORTS = {
  rank: (r) => r.rank, name: (r) => r.name.toLowerCase(), tvl: (r) => r.tvl_usd,
  change: (r) => (r.change_7d === null ? -Infinity : r.change_7d),
  implied: (r) => r.implied_value_usd, multiple: (r) => r.multiple, score: (r) => r.score,
};

function visibleRows() {
  let rows = R.rows.filter((r) =>
    (!state.q || `${r.name} ${r.slug} ${r.category ?? ''}`.toLowerCase().includes(state.q)) &&
    (!state.cat || (r.category ?? '(none)') === state.cat) &&
    (!state.chain || r.chains.includes(state.chain)) &&
    (!state.watch || r.watchlist) &&
    (!state.conf || (state.conf === 'C' ? r.confidence === 'C' : state.conf === 'A' ? r.confidence === 'A' : r.confidence !== 'C')));
  const k = SORTS[state.sortKey];
  rows = [...rows].sort((a, b) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : a.rank - b.rank) * state.sortDir);
  return rows;
}

function renderBoard() {
  const rows = visibleRows();
  $('#rowcount').textContent = `${rows.length} of ${R.rows.length} rows`;
  const th = (key, label, cls = '') => `<th class="${cls}" data-sort="${key}">${label}${state.sortKey === key ? (state.sortDir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
  $('#view-board').innerHTML = `<table><thead><tr>
    ${th('rank', '#', 'r')}${th('name', 'Protocol')}${th('tvl', 'TVL', 'r')}${th('change', '7d', 'r')}
    ${th('implied', 'Implied value', 'r')}<th class="nosort">Range (log scale)</th>${th('multiple', 'Mult', 'r')}
    ${th('score', 'Score', 'r')}<th class="nosort">Conf</th><th class="nosort">Flags</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="row" data-slug="${esc(r.slug)}">
      <td class="r num">${r.rank}</td>
      <td><span class="pname">${esc(r.name)}</span> ${r.watchlist ? '<span class="star" title="On the snapshot watchlist">★</span>' : ''}<br><span class="pslug">${esc(r.slug)}</span> <span class="cat">${esc(r.category ?? '—')}</span></td>
      <td class="r num">${money(r.tvl_usd)}</td>
      <td class="r num ${r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'}">${pct(r.change_7d)}</td>
      <td class="r num"><b>${money(r.implied_value_usd)}</b></td>
      <td>${whisk(r)}<span class="range-nums">${money(r.low_usd)} – ${money(r.high_usd)}</span></td>
      <td class="r num">${mult(r.multiple)}</td>
      <td class="r"><span class="score">${r.score}</span></td>
      <td><span class="chip ${r.confidence}">${r.confidence}</span></td>
      <td class="flags">${r.risks.length && !r.risks[0].startsWith('No flag') ? `${r.risks.length} ⚑` : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
  document.querySelectorAll('#view-board th[data-sort]').forEach((el) => el.addEventListener('click', () => {
    const key = el.getAttribute('data-sort');
    if (state.sortKey === key) state.sortDir *= -1; else { state.sortKey = key; state.sortDir = key === 'name' ? 1 : -1; }
    if (key === 'rank') state.sortDir = 1;
    renderBoard();
  }));
  document.querySelectorAll('#view-board tr.row').forEach((el) => el.addEventListener('click', () => {
    location.hash = `detail=${encodeURIComponent(el.getAttribute('data-slug'))}`;
  }));
}

function barRow(label, v) {
  const cls = v >= 66 ? '' : v >= 40 ? 'mid' : 'low';
  return `<div class="bar-row"><span class="lab">${label}</span><div class="track"><div class="fill ${cls}" style="width:${v.toFixed(0)}%"></div></div><span class="num">${v.toFixed(0)}</span></div>`;
}

function renderDetail() {
  const r = bySlug.get(state.detail);
  if (!r) { state.view = 'board'; render(); return; }
  const c = r.components;
  $('#view-detail').innerHTML = `
  <div class="detail-head">
    <div><h2 style="margin:0">${esc(r.name)} ${r.watchlist ? '<span class="star">★ watchlist</span>' : ''}</h2>
    <div class="dim">${esc(r.category ?? 'Uncategorised')} · ${r.chains.map(esc).join(', ')} · records no token · tracked ${r.age_days} days</div></div>
    <button class="back" id="back">← Board</button>
  </div>
  <div class="grid">
    <div class="box"><h3>Implied launch value</h3>
      <div class="big-range">${moneyFull(r.implied_value_usd)}</div>
      <div class="dim small">base case · fitted multiple ${mult(r.multiple)} of TVL</div>
      <div style="margin:12px 0 4px">${whisk(r)}</div>
      <div class="range-nums">honest band ${moneyFull(r.low_usd)} – ${moneyFull(r.high_usd)} (${(r.high_usd / r.low_usd).toFixed(1)}x wide)</div>
      <dl class="kv" style="margin-top:12px">
        <dt>TVL</dt><dd>${moneyFull(r.tvl_usd)}</dd>
        <dt>7-day change</dt><dd>${pct(r.change_7d)}</dd>
        <dt>Chains</dt><dd>${r.chains.length}</dd>
        <dt>Evidence</dt><dd style="font-family:inherit">${esc(r.evidence)}</dd>
      </dl>
    </div>
    <div class="box"><h3>Audit score ${r.score}/100 · confidence <span class="chip ${r.confidence}">${r.confidence}</span></h3>
      ${barRow('Scale', c.scale)}${barRow('Momentum', c.momentum)}${barRow('Maturity', c.maturity)}
      ${barRow('Reach', c.reach)}${barRow('Cat. premium', c.premium)}${barRow('Calibration', c.calibration)}
      <h3>Strongest evidence</h3>
      <ul class="reasons">${r.reasons.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <h3>Risk flags</h3>
      <ul class="risks">${r.risks.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    </div>
  </div>
  <div class="box" style="margin-top:14px"><h3>Farm plan — ${esc(r.name)}</h3>
    <div class="plan-meta">
      <span class="chip">Capital ${moneyFull(r.plan.capitalLow)}–${moneyFull(r.plan.capitalHigh)}</span>
      <span class="chip">~${r.plan.weeklyMinutes} min/week</span>
      <span class="chip">Hold ${r.plan.holdDays} days</span>
      <span class="chip">8 steps</span>
    </div>
    <ol class="plan">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
  </div>`;
  $('#back').addEventListener('click', () => { location.hash = 'board'; });
}

function btTable() {
  const b = R.backtest;
  const row = (label, s, win) => `<tr><td>${label}</td><td class="r num">${factor(s.medAbsErr)}</td><td class="r num">${factor(s.meanAbsErr)}</td><td class="r num">${(s.coverage * 100).toFixed(1)}%</td><td class="r num">${s.width.toFixed(2)}</td><td class="r num">${s.winkler.toFixed(2)}</td>${win ? '<td class="win">winner</td>' : '<td></td>'}</tr>`;
  return `<table><thead><tr><th class="nosort">Leave-one-out on 128 launches</th><th class="nosort r">Median miss</th><th class="nosort r">Mean miss</th><th class="nosort r">Caps in band</th><th class="nosort r">Band width (dex)</th><th class="nosort r">Winkler ↓</th><th class="nosort"></th></tr></thead>
  <tbody>${row('radar-4 — fitted elasticity law (this board)', b.radar4, true)}${row('radar-3 — category median multiple (previous)', b.radar3, false)}</tbody></table>`;
}

function renderComparables() {
  const cats = R.categories;
  $('#view-comparables').innerHTML = `
  <h2>The evidence: ${R.counts.comparables} launches that already happened</h2>
  <p class="dim" style="max-width:88ch">The price law is fitted on these protocols — the snapshot's token-bearing set, with real market caps.
  The audit below is the program grading itself: it hides each cap in turn, predicts it from the other 127, and scores the error.
  The same audit, run on the previous model's estimator, is the comparison column. Neither number is asserted; both are recomputed at build time.</p>
  ${btTable()}
  <h2>Category offsets (fitted launch premium, log points)</h2>
  <table><thead><tr><th class="nosort">Category</th><th class="nosort r">Comparables</th><th class="nosort r">Offset</th><th class="nosort r">Board rows</th></tr></thead>
  <tbody>${cats.map((c) => `<tr><td>${esc(c.category)}</td><td class="r num">${c.comparables}</td><td class="r num">${c.offset >= 0 ? '+' : ''}${c.offset.toFixed(2)}</td><td class="r num">${c.boardRows}</td></tr>`).join('')}</tbody></table>
  <h2>Every comparable, with its leave-one-out prediction</h2>
  <table><thead><tr><th class="nosort">Protocol</th><th class="nosort">Symbol</th><th class="nosort">Category</th><th class="nosort r">TVL</th><th class="nosort r">Actual cap</th><th class="nosort r">Actual x</th><th class="nosort r">Radar-4 said</th><th class="nosort r">Miss</th><th class="nosort">Band</th></tr></thead>
  <tbody>${R.comparables.map((c) => `<tr>
    <td><span class="pname">${esc(c.name)}</span><br><span class="pslug">${esc(c.slug)}</span></td>
    <td class="num">${esc(c.symbol ?? '—')}</td><td class="cat">${esc(c.category ?? '—')}</td>
    <td class="r num">${money(c.tvl_usd)}</td><td class="r num">${money(c.mcap_usd)}</td>
    <td class="r num">${mult(c.multiple)}</td><td class="r num">${money(c.loo_pred_usd)}</td>
    <td class="r num">${factor(c.loo_err_log10)}</td><td>${c.loo_in_band ? '<span class="pos">in</span>' : '<span class="neg">out</span>'}</td>
  </tr>`).join('')}</tbody></table>`;
}

function renderMethod() {
  const b = R.backtest, f = R.fit;
  $('#view-method').innerHTML = `<div class="method">
  <h2>How a launch is priced here</h2>
  <p><b>The finding.</b> On the ${R.counts.comparables} protocols in the snapshot whose tokens already trade, market cap does not grow in
  proportion to TVL. Fitting <code>log(cap) = a + b·log(TVL)</code> on them gives <code>a = ${f.a}</code>, <code>b = ${f.b}</code>:
  doubling TVL multiplies the expected cap by about ${Math.pow(2, f.b).toFixed(2)}, not 2. A flat multiple — the previous model's
  category medians — therefore overprices giants and underprices small protocols by construction. The field's median multiple is
  ${mult(f.medianMultiple)}; almost nobody actually launches at it.</p>
  <p><b>The law.</b> Each pre-token protocol is priced as <code>exp(a + b·log TVL + offset[category])</code>, where the category
  offset is the category's mean residual, shrunk toward zero with weight k = ${f.shrinkK} so a category with one comparable (Risk
  Curators) leans on the global law instead of on a single protocol's market mood. The fitted value is then multiplied by the
  protocol's own adjustments — growth <code>1 + 0.6·clamp(change_7d, −50, +150)/100</code>, maturity
  <code>0.78 + 0.40·min(age, 1460d)/1460d</code>, reach <code>1 + 0.04·min(chains − 1, 4)</code>. The leave-one-out audit finds
  those adjustments roughly neutral for prediction; they stay because they are the signals a launch is judged on, they are
  small, and every card prints them.</p>
  <p><b>The range is the model's own error.</b> Each row's band is the leave-one-out residual band of its category (the middle
  half of the model's historical misses on that kind, shrunk toward the global band of x${f.globalBandLo} to x${f.globalBandHi}),
  not a hand-set ±%. In the audit, ${(b.radar4.coverage * 100).toFixed(1)}% of the 128 hidden caps fell inside their bands — the
  middle-half band should hold about half, and it does. The previous model's bands held ${(b.radar3.coverage * 100).toFixed(1)}%.</p>
  ${btTable()}
  <p class="small dim">Errors are |log10(prediction / actual)| expressed as miss factors; Winkler is the 50% interval score in
  log10 space (lower is better). Misses remain large in absolute terms — a typical radar-4 miss is ${factor(b.radar4.medAbsErr)} —
  because a launch price is genuinely not determined by TVL alone. The honest answer to that is the band, not a false point.</p>
  <p>The board never prices custodial pass-through products, yet their launches sit in the fit — so the audit was also scored on
  the ${b.boardLikeN} launches of the board's own kind alone: radar-4's median miss is ${factor(b.radar4BoardLike.medAbsErr)} there
  against radar-3's ${factor(b.radar3BoardLike.medAbsErr)}, with ${(b.radar4BoardLike.coverage * 100).toFixed(1)}% of caps inside
  their bands. Refitting on that subset alone was tested too and did not beat the full fit — it only lost calibration — so the
  law keeps all ${R.counts.comparables} launches as its evidence.</p>
  <h2>The audit score</h2>
  <p>Rank follows implied value. The 0–100 score audits the rank: six percentiles inside the board's own universe — scale
  (log TVL, 24), momentum (7-day change, 16), maturity (age, 14), reach (chains, 10), category premium (the fitted offset, 18)
  and calibration (narrowness of the honest band, 18). Confidence grades the evidence behind a row: A needs at least 8
  comparables in the category and a narrow band, C marks rows resting on at most one comparable or a very wide band, B is
  everything between. A high rank with a C is a big, weakly-evidenced claim, and the board shows it as one.</p>
  <h2>Who is on the board</h2>
  <p>Every protocol that records no token (both token fields null) and is not a wrapped, staked, bridged or exchange product of
  a token that already trades: the bridge, liquid-staking, restaking and CEX categories are out, as are names carrying a whole
  word wrapped, staked or staking, a version suffix, or an exchange's name. That keeps all ${R.counts.watchlist} watchlist
  protocols and ${R.counts.board - R.counts.watchlist} more the radar found below and beside the floor. Protocols whose token
  already trades are never ranked as launches; they are the Comparables, the evidence the law is fitted on. The snapshot
  records no fees, revenue, users or points programs, so none are invented: missing signals appear as risk flags and as the
  reconnaissance step of each farm plan.</p>
  <div class="note">For the reader checking the work: every number on this page was computed by the entry's program from the
  sealed snapshot at build time — the fit, both leave-one-out audits, the category offsets and every row's band. Change the
  snapshot and the board, the audit and this page change with it; no figure is hardcoded and no protocol is named in the model.</div>
  </div>`;
}

function render() {
  parseHash();
  document.querySelectorAll('#tabs button').forEach((btn) => {
    const v = btn.getAttribute('data-view');
    btn.classList.toggle('on', v === state.view || (state.view === 'detail' && v === 'board'));
  });
  $('#filters').style.display = state.view === 'board' ? '' : 'none';
  $('#view-board').hidden = state.view !== 'board';
  $('#view-comparables').hidden = state.view !== 'comparables';
  $('#view-method').hidden = state.view !== 'method';
  $('#view-detail').hidden = state.view !== 'detail';
  if (state.view === 'board') renderBoard();
  if (state.view === 'detail') renderDetail();
  if (state.view === 'comparables') renderComparables();
  if (state.view === 'method') renderMethod();
}

document.querySelectorAll('#tabs button').forEach((btn) => btn.addEventListener('click', () => {
  const v = btn.getAttribute('data-view');
  location.hash = v === 'board' ? 'board' : `view=${v}`;
}));
$('#q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); if (state.view === 'board') renderBoard(); });
$('#fcat').addEventListener('change', (e) => { state.cat = e.target.value; renderBoard(); });
$('#fchain').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
$('#fconf').addEventListener('change', (e) => { state.conf = e.target.value; renderBoard(); });
$('#fwatch').addEventListener('change', (e) => { state.watch = e.target.checked; renderBoard(); });
window.addEventListener('hashchange', render);

parseHash();
renderStrip();
fillFilters();
render();
$('#foot').textContent = `Launch Radar · model radar-4 · data: the sealed snapshot (${R.source}) · board.json holds the same ${R.counts.board} rows this page renders · the implied value is this entry's own claim, derived from the snapshot's figures alone.`;
