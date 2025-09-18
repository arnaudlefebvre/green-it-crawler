// greenit-kpi-runner-v2.js
// Node.js script to collect GreenIT / RWEB-inspired metrics on one or more pages using Playwright.
// - Saves HTML + detailed network log (status, headers, sizes)
// - Adds RWEB checks: lazy-load, images, cache-control, cookies, HSTS, fonts, etc.
// - Distinguishes transferred vs decoded bytes; compression only on compressible types (A)
// - Captures HTTP protocol (h1/h2/h3) via CDP (E) and JavaScript console errors (F)
// - Exports CSV/JSONL + composite KPI (weights/thresholds in config.yml)

import fs from 'fs';
import path from 'path';
import {
    fileURLToPath
}
from 'url';
import * as yaml from 'yaml';
import {
    chromium
}
from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- helpers ----------
function ensureDir(p) {
    if (!fs.existsSync(p))
        fs.mkdirSync(p, {
            recursive: true
        });
}
function nowIso() {
    return new Date().toISOString();
}
function safeName(s) {
    return (s || '').toString().replace(/\W+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
function pct(num, den) {
    return den > 0 ? Math.round((num / den) * 100) : 0;
}
function hostname(u) {
    try {
        return new URL(u).hostname;
    } catch {
        return 'unknown';
    }
}
function prettyBytes(n) {
    if (!n)
        return '0 B';
    const k = 1024,
    u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.max(0, Math.floor(Math.log(n) / Math.log(k))));
    return `${(n/Math.pow(k,i)).toFixed(2)} ${u[i]}`;
}
function isHttp(url) {
    return /^https?:\/\//i.test(url);
}
function isStatic(url) {
    return /\.(css|js|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|mp4|webm|avif)(\?|$)/i.test(url);
}
function isMinifiedName(url) {
    return /\.min\.(js|css)(\?|$)/i.test(url);
}
function isImageUrl(url) {
    return /\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i.test(url);
}
function isFontUrl(url) {
    return /\.(woff2?|ttf|otf)(\?|$)/i.test(url);
}
function isCompressible(ct, url) {
    const t = (ct || '').toLowerCase();
    return /(^text\/|javascript|json|xml|svg|font\/svg)/.test(t) || /\.(css|js|json|svg|xml|html?)(\?|$)/i.test(url);
}
function looksMinifiedContent(text) {
    if (!text)
        return false;
    const len = text.length;
    if (len < 2000)
        return false;
    const spaces = (text.match(/\s/g) || []).length;
    const ratio = spaces / len;
    const avgLine = len / (text.split('\n').length);
    return ratio < 0.15 && avgLine > 200;
}
function toCsvRow(obj, headers) {
    return headers.map(h => JSON.stringify(obj[h] ?? '')).join(',');
}
function parseCacheControl(cc) {
    if (!cc)
        return {
            maxAge: null,
            noStore: false,
            noCache: false,
            privateScope: false
        };
    const lower = cc.toLowerCase();
    const noStore = /no-store/.test(lower);
    const noCache = /no-cache/.test(lower);
    const isPrivate = /private/.test(lower);
    const m = lower.match(/max-age\s*=\s*(\d+)/);
    const maxAge = m ? parseInt(m[1], 10) : null;
    return {
        maxAge,
        noStore,
        noCache,
        privateScope: isPrivate
    };
}

// Image helpers
function isOptimizedImageResponse(r) {
    const ct = (r.responseHeaders?.['content-type'] || '').toLowerCase();
    return /\.(webp|avif|jxl)(\?|$)/i.test(r.url) || /image\/(webp|avif|jxl)/i.test(ct);
}
function isImageResponse(r) {
    return r.resourceType === 'image' || isImageUrl(r.url);
}

// Composite KPI (0..100) configurable
function normalizeLowerBetter(value, thresholds) {
    if (value <= thresholds[0])
        return 100;
    if (value <= thresholds[1])
        return 80;
    if (value <= thresholds[2])
        return 60;
    if (value <= thresholds[3])
        return 40;
    return 20;
}
function normalizeHigherBetter(value, thresholds) {
    if (value >= thresholds[3])
        return 100;
    if (value >= thresholds[2])
        return 80;
    if (value >= thresholds[1])
        return 60;
    if (value >= thresholds[0])
        return 40;
    return 20;
}
function gradeAE(score) {
    if (score >= 90)
        return 'A';
    if (score >= 80)
        return 'B';
    if (score >= 70)
        return 'C';
    if (score >= 60)
        return 'D';
    if (score >= 50)
        return 'E';
    if (score >= 40)
        return 'F';
    return 'G';
}
function evalKpiCond(m, expr) {
    try {
        return new Function('m', `with(m){ return (${expr}); }`)(m);
    } catch {
        return false;
    }
}
function computeScoreCeiling(metrics, kpiCfg) {
    const rules = (kpiCfg && kpiCfg.score_ceilings) || [];
    let max = 100;
    for (const r of rules) {
        if (!r || typeof r.max_score !== 'number' || !r.if)
            continue;
        if (evalKpiCond(metrics, r.if)) {
            const v = Math.max(0, Math.min(100, r.max_score));
            max = Math.min(max, v);
        }
    }
    return max;
}
function computeCompositeKpi(metrics, kpiCfg) {
    const W = kpiCfg?.weights || {};
    const T = kpiCfg?.thresholds || {};
    const weights = {
        requests: W.requests ?? 0.40,
        transferKB: W.transferKB ?? 0.25,
        domSize: W.domSize ?? 0.15,
        uniqueDomains: W.uniqueDomains ?? 0.10,
        compressedPct: W.compressedPct ?? 0.05,
        minifiedPct: W.minifiedPct ?? 0.05,
        inlineStyles: W.inlineStyles ?? 0.02,
        inlineScripts: W.inlineScripts ?? 0.02,
        cssFiles: W.cssFiles ?? 0.02,
        jsFiles: W.jsFiles ?? 0.02,
        resizedImages: W.resizedImages ?? 0.01,
        hiddenDownloadedImages: W.hiddenDownloadedImages ?? 0.01,
        staticWithCookies: W.staticWithCookies ?? 0.01,
        redirects: W.redirects ?? 0.01,
        errors: W.errors ?? 0.01,
        fontsExternal: W.fontsExternal ?? 0.01,
        belowFoldNoLazy: W.belowFoldNoLazy ?? 0.01,
        staticNoCache: W.staticNoCache ?? 0.01,
        imageLegacyPct: W.imageLegacyPct ?? 0.01,
        wastedImagePct: W.wastedImagePct ?? 0.01,
        hstsMissing: W.hstsMissing ?? 0.01,
        cookieHeaderAvg: W.cookieHeaderAvg ?? 0.01
    };
    const _sumW = Object.values(weights).reduce((a,b)=>a + (typeof b === 'number' ? b : 0), 0) || 1;
    const effW = Object.fromEntries(
      Object.entries(weights).map(([k,v]) => [k, (typeof v === 'number' ? v/_sumW : 0)])
    );
    const thr = {
        requests: T.requests ?? [27, 50, 80, 120],
        transferKB: T.transferKB ?? [300, 800, 1500, 2500],
        domSize: T.domSize ?? [800, 1500, 2500, 4000],
        uniqueDomains: T.uniqueDomains ?? [6, 10, 15, 20],
        compressedPct: T.compressedPct ?? [50, 70, 85, 95],
        minifiedPct: T.minifiedPct ?? [50, 70, 85, 95],
        inlineStyles: T.inlineStyles ?? [0, 1, 3, 6],
        inlineScripts: T.inlineScripts ?? [0, 1, 3, 6],
        cssFiles: T.cssFiles ?? [3, 6, 10, 14],
        jsFiles: T.jsFiles ?? [5, 10, 20, 35],
        resizedImages: T.resizedImages ?? [0, 1, 3, 6],
        hiddenDownloadedImages: T.hiddenDownloadedImages ?? [0, 1, 3, 6],
        staticWithCookies: T.staticWithCookies ?? [0, 1, 3, 6],
        redirects: T.redirects ?? [0, 1, 3, 6],
        errors: T.errors ?? [0, 1, 2, 4],
        belowFoldNoLazy: T.belowFoldNoLazy ?? [0, 1, 2, 4],
        staticNoCache: T.staticNoCache ?? [0, 1, 3, 6],
        imageLegacyPct: T.imageLegacyPct ?? [70, 60, 40, 20],
        wastedImagePct: T.wastedImagePct ?? [10, 8, 6, 5],
        cookieHeaderAvg: T.cookieHeaderAvg ?? [1024, 2048, 3072, 4096]
    };
  // Normalized metric scores (0..100) BEFORE weighting
  const norms = {};
  norms.requests = normalizeLowerBetter(metrics.requests, thr.requests);
  norms.transferKB = normalizeLowerBetter(metrics.transferKB, thr.transferKB);
  norms.domSize = normalizeLowerBetter(metrics.domSize, thr.domSize);
  norms.uniqueDomains = normalizeLowerBetter(metrics.uniqueDomains, thr.uniqueDomains);
  norms.compressedPct = normalizeHigherBetter(metrics.compressedPct, thr.compressedPct);
  norms.minifiedPct = normalizeHigherBetter(metrics.minifiedPct, thr.minifiedPct);
  norms.inlineStyles = normalizeLowerBetter(metrics.inlineStyles, thr.inlineStyles);
  norms.inlineScripts = normalizeLowerBetter(metrics.inlineScripts, thr.inlineScripts);
  norms.cssFiles = normalizeLowerBetter(metrics.cssFiles, thr.cssFiles);
  norms.jsFiles = normalizeLowerBetter(metrics.jsFiles, thr.jsFiles);
  norms.resizedImages = normalizeLowerBetter(metrics.resizedImages, thr.resizedImages);
  norms.hiddenDownloadedImages = normalizeLowerBetter(metrics.hiddenDownloadedImages, thr.hiddenDownloadedImages);
  norms.staticWithCookies = normalizeLowerBetter(metrics.staticWithCookies, thr.staticWithCookies);
  norms.redirects = normalizeLowerBetter(metrics.redirects, thr.redirects);
  norms.errors = normalizeLowerBetter(metrics.errors, thr.errors);
  norms.fontsExternal = (metrics.fontsExternal ? 40 : 100);
  norms.belowFoldNoLazy = normalizeLowerBetter(metrics.belowFoldNoLazy, thr.belowFoldNoLazy);
  norms.staticNoCache = normalizeLowerBetter(metrics.staticNoCache, thr.staticNoCache);
  norms.imageLegacyPct = normalizeLowerBetter(metrics.imageLegacyPct, thr.imageLegacyPct);
  norms.wastedImagePct = normalizeLowerBetter(metrics.wastedImagePct, thr.wastedImagePct);
  norms.hstsMissing = (metrics.hstsMissing ? 40 : 100);
  norms.cookieHeaderAvg = normalizeLowerBetter(metrics.cookieHeaderAvg, thr.cookieHeaderAvg);

  // Contributions BEFORE ceiling: norm * effW
  const parts = {};
  for (const k of Object.keys(effW)) parts[k] = (norms[k] ?? 0) * effW[k];

  // Apply numeric ceiling scaling
  const ceiling = computeScoreCeiling(metrics, kpiCfg);
  const scale = (ceiling < 100) ? (ceiling / 100) : 1;
  if (scale !== 1) for (const k of Object.keys(parts)) parts[k] = parts[k] * scale;

  let score = Object.values(parts).reduce((a,b)=>a+b,0);
  score = Math.round(score);
  score = Math.max(0, Math.min(ceiling < 100 ? ceiling : 100, score));

  //const normForGrade = Math.round((score / Math.max(1, ceiling < 100 ? ceiling : 100)) * 100);
  const grade = gradeAE(score);
  

  return { score, grade, breakdown: parts, norms, effW, ceilingApplied: (ceiling < 100 ? ceiling : 100), scale };
}

function round2(x) {
    return Math.round((x + Number.EPSILON) * 100) / 100;
}
function round4(x) {
    return Math.round((x + Number.EPSILON) * 10000) / 10000;
}
function estimateImpactsFromTransfer(bytes, opts = {}) {
    const GB = bytes / (1024 ** 3);
    const kWhPerGB = (opts.kWhPerGB ?? 0.81);
    const grid_g_per_kWh = (opts.grid_g_per_kWh ?? 442);
    const water_L_per_kWh = (opts.water_L_per_kWh ?? 1.9);
    const energy_kWh = GB * kWhPerGB;
    const co2_g = energy_kWh * grid_g_per_kWh;
    const water_cl = energy_kWh * water_L_per_kWh * 100;
    return {
        dataGB: GB,
        energy_kWh,
        co2_g,
        water_cl,
        model: 'swdm'
    };
}


// ---------- auth helpers ----------
async function performLogin(context, page, loginCfg, persistSession, authDir, productName){
  if (!loginCfg) return false;

  // selectors can be string or array of strings (engines allowed: css=, xpath=, text=, role=, etc.)
  const getArr = (v) => Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []);

  const timeoutMs = (typeof loginCfg.timeoutMs === 'number' ? loginCfg.timeoutMs : 45000);
  const { url, submitSelector, waitFor } = loginCfg;

  // Resolve credentials (per-product envs supported)
  const prodKey = (productName || 'default');
  const safeProd = safeName(prodKey).toUpperCase();
  const prefix = loginCfg.envPrefix || (`KPI_${safeProd}_`);
  const userEnvName = loginCfg.usernameEnv || (prefix + 'USER');
  const passEnvName = loginCfg.passwordEnv || (prefix + 'PASS');
  let user = loginCfg.username != null ? String(loginCfg.username) : process.env[userEnvName];
  let pass = loginCfg.password != null ? String(loginCfg.password) : process.env[passEnvName];

  // Build selector candidates, include deep-shadow variants for Vaadin-like fields
  const usernameSelectors = getArr(loginCfg.usernameSelector || loginCfg.usernameSelectors);
  const passwordSelectors = getArr(loginCfg.passwordSelector || loginCfg.passwordSelectors);
  const expandShadow = (sel) => {
    // If already has engine prefix or '>>>', keep as-is
    if (/^[a-z]+=/.test(sel) || sel.includes('>>>')) return [sel];
    // If ID or tag#id, add deep combinator as a fallback
    const out = [sel];
    out.push(`css=${sel} >>> input`);
    return out;
  };
  const userCandidates = usernameSelectors.flatMap(expandShadow);
  const passCandidates = passwordSelectors.flatMap(expandShadow);

  async function tryFill(selectorList, value, label){
    for (const s of selectorList) {
      try {
        console.log(`[login] waiting for ${label} selector: ${s}`);
        const loc = page.locator(s);
        await loc.waitFor({ state: 'visible', timeout: timeoutMs });
        await loc.fill(value, { timeout: timeoutMs });
        console.log(`[login] filled ${label} with selector: ${s}`);
        return true;
      } catch (e) {
        console.warn(`[login] attempt failed for ${label} selector: ${s} -> ${e?.message || e}`);
      }
    }
    return false;
  }

  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 30000) });
  }

  if (!user || !pass) {
    console.warn(`[login] Missing credentials for ${prodKey}. Expected envs: ${userEnvName}/${passEnvName}.`);
    return false;
  }

  // Try to fill username
  const userOk = await tryFill(userCandidates, user, 'username');
  // Try to fill password
  const passOk = await tryFill(passCandidates, pass, 'password');

  if (!userOk || !passOk) {
    console.error('[login] Could not locate login fields. Check selectors or use css=... >>> input for shadow DOM.');
    return false;
  }

  if (submitSelector) {
    try {
      const submitLoc = page.locator(submitSelector);
      await submitLoc.waitFor({ state: 'visible', timeout: timeoutMs });
      await submitLoc.click({ timeout: timeoutMs });
      console.log('[login] submit clicked');
    } catch (e) {
      console.warn(`[login] submit click failed: ${e?.message || e}`);
    }
  }

  try {
    await page.waitForLoadState(waitFor || 'networkidle', { timeout: timeoutMs });
  } catch (e) {
    console.warn(`[login] waitForLoadState(${waitFor || 'networkidle'}) timed out: ${e?.message || e}`);
  }

  if (persistSession) {
    const storagePath = (loginCfg.storageStatePath || path.join(authDir, safeName(prodKey) + '_storageState.json'));
    await context.storageState({ path: storagePath });
    console.log(`[session] Storage state persisted for ${prodKey} -> ${storagePath}`);
  }
  console.log(`[login] OK for ${prodKey}`);
  return true;
}

// ---------- diff helpers ----------
function _nextArg(args, flag){
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const v = args[i+1];
  return (v && !String(v).startsWith('--')) ? v : null;
}
function _sign(n){ return n>0?`+${n}`:`${n}`; }
function _pad(n){ return (n!=null && !Number.isNaN(n)) ? n : ''; }
function _gradeArrow(a,b){ return a===b ? a : `${a} → ${b}`; }
function _mapPagesBy(pages){
  const map = new Map();
  (pages||[]).forEach(pg => {
    const k = (pg && (pg.name || pg.url || '')).toLowerCase();
    if (k) map.set(k, pg);
  });
  return map;
}
function _metricDeltas(baseM, headM){
  const keys = [
    'requests','transferKB','domSize','uniqueDomains','compressedPct','minifiedPct',
    'inlineStyles','inlineScripts','cssFiles','jsFiles','resizedImages','hiddenDownloadedImages',
    'belowFoldNoLazy','staticNoCache','staticShortCache','staticWithCookies',
    'imageLegacyPct','wastedImagePct','errors','redirects','cookieHeaderAvg'
  ];
  const out = {};
  keys.forEach(k => {
    const a = baseM ? baseM[k] : undefined;
    const b = headM ? headM[k] : undefined;
    if (typeof a === 'number' || typeof b === 'number'){
      out[k] = ((typeof b === 'number' ? b : 0) - (typeof a === 'number' ? a : 0));
    }
  });
  return out;
}
function _topNChanges(deltaObj, n=5, dir='neg'){
  const entries = Object.entries(deltaObj).filter(([,v]) => typeof v === 'number');
  entries.sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
  const neg = entries.filter(([,v])=>v<0).slice(0,n);
  const pos = entries.filter(([,v])=>v>0).slice(0,n);
  return dir==='neg' ? neg : pos;
}
function _noteworthyMetrics(d, thresholds){
  const thr = Object.assign({
    requests: 5, transferKB: 250, domSize: 200, uniqueDomains: 2,
    compressedPct: 5, minifiedPct: 5,
    staticNoCache: 2, staticShortCache: 2, staticWithCookies: 1,
    imageLegacyPct: 5, wastedImagePct: 5,
    errors: 1, redirects: 1
  }, thresholds||{});
  return Object.entries(d)
    .filter(([k,v]) => Math.abs(v||0) >= (thr[k] || Infinity))
    .sort((a,b)=>Math.abs(b[1]) - Math.abs(a[1]));
}
function _fileTsFromName(basename){
  const m = String(basename).match(/_RUN_([0-9\-T]+)\.json$/);
  return m ? m[1] : '';
}
function _buildDiffMd(product, base, head, baseName, headName){
  const prodDelta = Math.round((head.score100||0) - (base.score100||0));
  const prodGrade = _gradeArrow(base.grade||'?', head.grade||'?');

  const mb = _mapPagesBy(base.pages||[]);
  const mh = _mapPagesBy(head.pages||[]);
  const keys = new Set([...mb.keys(), ...mh.keys()]);

  let md = `# Diff KPI — ${product}
**Base**: ${_fileTsFromName(baseName)} — **Head**: ${_fileTsFromName(headName)}

## Global
- **Score produit**: ${_pad(base.score100)}/${_pad(head.score100)} (${_sign(prodDelta)})
- **Grade**: ${prodGrade}

`;
  md += `## Pages — résumé
| Page | Score (base→head) | Δ | Grade (base→head) | Poids (head) |
|---|---:|---:|:--|---:|
`;
  const pageSummaries = [];
  for (const k of keys){
    const a = mb.get(k);
    const b = mh.get(k);
    const name = (b && b.name) || (a && a.name) || k;
    const baseScore = a ? Math.round(a.score||0) : null;
    const headScore = b ? Math.round(b.score||0) : null;
    const d = (headScore!=null && baseScore!=null) ? (headScore - baseScore) : (headScore!=null ? headScore : (baseScore!=null ? -baseScore : 0));
    const g = _gradeArrow(a ? (a.grade||'?') : '—', b ? (b.grade||'?') : '—');
    const w = b && typeof b.weight === 'number' ? b.weight : (a && typeof a.weight === 'number' ? a.weight : 1);
    pageSummaries.push({ name, baseScore, headScore, d, g, w, a, b });
  }
  pageSummaries.sort((x,y)=> (x.d - y.d));
  pageSummaries.forEach(p => {
    md += `| ${p.name} | ${_pad(p.baseScore)}→${_pad(p.headScore)} | ${_sign(p.d)} | ${p.g} | ${p.w} |
`;
  });

  for (const p of pageSummaries){
    md += `
### ${p.name}
- **Score**: ${_pad(p.baseScore)} → ${_pad(p.headScore)} (${_sign(p.d)})  
- **Grade**: ${p.g}  
`;
    if (p.a && p.b && typeof p.a.ceilingApplied === 'number' && typeof p.b.ceilingApplied === 'number' && p.a.ceilingApplied !== p.b.ceilingApplied){
      md += `- **Plafond**: ${p.a.ceilingApplied} → ${p.b.ceilingApplied}
`;
    }
    const baseBreak = (p.a && p.a.breakdown) || {};
    const headBreak = (p.b && p.b.breakdown) || {};
    const allK = new Set([...Object.keys(baseBreak), ...Object.keys(headBreak)]);
    const deltaContrib = {};
    allK.forEach(k => {
      const a = typeof baseBreak[k] === 'number' ? baseBreak[k] : 0;
      const b = typeof headBreak[k] === 'number' ? headBreak[k] : 0;
      deltaContrib[k] = Math.round(b - a);
    });
    const worst = _topNChanges(deltaContrib, 5, 'neg');
    const best  = _topNChanges(deltaContrib, 5, 'pos');
    if (worst.length){
      md += `
**Principales régressions (Δ contribution)**
`;
      worst.forEach(([k,v]) => md += `- ${k}: ${v}
`);
    }
    if (best.length){
      md += `
**Principales améliorations (Δ contribution)**
`;
      best.forEach(([k,v]) => md += `- ${k}: +${v}
`);
    }
    const deltas = _metricDeltas(p.a && p.a.metrics, p.b && p.b.metrics);
    const noteworthy = _noteworthyMetrics(deltas);
    if (noteworthy.length){
      md += `
**Changements de métriques notables**
| Métrique | Base | Head | Δ |
|---|---:|---:|---:|
`;
      noteworthy.forEach(([k,v]) => {
        const baseVal = p.a && p.a.metrics ? p.a.metrics[k] : '';
        const headVal = p.b && p.b.metrics ? p.b.metrics[k] : '';
        md += `| ${k} | ${_pad(baseVal)} | ${_pad(headVal)} | ${_sign(Math.round(v))} |
`;
      });
    }
  }
  return md;
}
// ---------- main ----------
async function run() {
    const args = process.argv.slice(2);
    const cfgPath = args.includes('--config') ? args[args.indexOf('--config') + 1] : path.join(__dirname, 'config.yml');
    const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(__dirname, 'out');
    const persistSession = args.includes('--persist-session');
    const compareLatestFor = args.includes('--compare-latest') ? (_nextArg(args, '--compare-latest') || 'all') : null;


    ensureDir(outDir);
    const cfgText = fs.readFileSync(cfgPath, 'utf8');
    const cfg = yaml.parse(cfgText) || {};

    const minCacheSeconds = cfg?.cache?.minSeconds ?? 60 * 60 * 24 * 7; // 7 days

    const pagesDir = path.join(outDir, 'pages');
    const logsDir = path.join(outDir, 'logs');
    const authDir = path.join(outDir, 'auth');
    ensureDir(pagesDir);
    ensureDir(logsDir);
    ensureDir(authDir);

    const historyPath = path.join(outDir, 'history.jsonl');
    const csvPath = path.join(outDir, 'history.csv');

    // Persistent user profile (replicates real browser cookies if desired)
    const userDataDir = cfg.runtime?.userDataDir || path.join(__dirname, 'pw-profile');
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: cfg.runtime?.headless !== false,
        ignoreHTTPSErrors: !!cfg.runtime?.ignoreHTTPSErrors,
    });
    const page = context.pages()[0] || await context.newPage();
    if (cfg.runtime?.navigationTimeoutMs)
        page.setDefaultNavigationTimeout(cfg.runtime.navigationTimeoutMs);

    // optional login (form-fill) — you can also capture a session with capture-session.js
    if (cfg.login) {
        const {
            url,
            usernameSelector,
            passwordSelector,
            submitSelector,
            usernameEnv,
            passwordEnv,
            waitFor
        } = cfg.login;
        const user = process.env[usernameEnv];
        const pass = process.env[passwordEnv];
        if (url && usernameSelector && passwordSelector && submitSelector && user && pass) {
            await page.goto(url, {
                waitUntil: 'domcontentloaded'
            });
            await page.fill(usernameSelector, user);
            await page.fill(passwordSelector, pass);
            await page.click(submitSelector);
            await page.waitForLoadState(waitFor || 'networkidle');
            if (persistSession) {
                await context.storageState({
                    path: cfg.login.storageStatePath || path.join(authDir, 'storageState.json')
                });
                console.log(`[session] Storage state persisted.`);
            }
        }
    }
    const productTotals = new Map();
    for (const target of(cfg.targets || [])) {
        try { await context.clearCookies(); } catch {}

        
        // Per-product auth: run public pages first, then login and run private pages
        const productLoginCfg = target.login || cfg.login;
        // Sort: public (no auth) first, then auth-required
        const _pagesOrdered = [...(target.pages || [])].sort((a,b)=>{
          const ar = !!(a.auth === 'required' || a.requiresAuth === true);
          const br = !!(b.auth === 'required' || b.requiresAuth === true);
          return (ar === br) ? 0 : (ar ? 1 : -1);
        });
        let _isLoggedIn = false;
        for (const p of _pagesOrdered) {
          const needsAuth = (p.auth === 'required' || p.requiresAuth === true);
          if (needsAuth && !_isLoggedIn) {
            try { await context.clearCookies(); } catch {}
            await performLogin(context, page, productLoginCfg, persistSession, authDir, target.product);
            _isLoggedIn = true;
          }

            const ts = nowIso().replace(/[:.]/g, '-');
            const baseName = `${safeName(target.product)}_${safeName(p.name)}_${ts}`;

            const responses = [];
            const statusCounts = {
                '2xx': 0,
                '3xx': 0,
                '4xx': 0,
                '5xx': 0
            };
            const imagesByUrl = new Map();
            const net = {
                transferBytes: 0,
                decodedBytes: 0,
                totalReq: 0,
                errors: 0,
                redirects: 0,
                domains: new Set(),
                compressibleCount: 0,
                compressedCompressible: 0,
                staticWithCookies: 0,
                minifiedCount: 0,
                minifyEligible: 0,
                cssFiles: 0,
                jsFiles: 0,
                fontFileCount: 0,
                fontBytes: 0,
                imageCount: 0,
                imageBytes: 0,
                imageOptimizedCount: 0,
                imageLegacyCount: 0,
                staticNoCache: 0,
                staticShortCache: 0,
                staticCookieDomains: new Set(),
                cookieHeaderLens: []
            };

            // (E) HTTP protocol via CDP — must be set up BEFORE navigation
            const cdp = await context.newCDPSession(page);
            await cdp.send('Network.enable');
            const protoCounts = {
                'http/1.1': 0,
                'h2': 0,
                'h3': 0,
                'other': 0
            };
            cdp.on('Network.responseReceived', e => {
                const proto = (e.response?.protocol || '').toLowerCase();
                if (proto.includes('http/1.1'))
                    protoCounts['http/1.1']++;
                else if (proto.includes('h2'))
                    protoCounts['h2']++;
                else if (proto.includes('h3'))
                    protoCounts['h3']++;
                else
                    protoCounts['other']++;
            });

            // (F) JavaScript console errors — set before navigation
            const jsErrors = [];
            page.removeAllListeners('console');
            page.on('console', msg => {
                if (msg.type() === 'error')
                    jsErrors.push(msg.text());
            });

            page.removeAllListeners('response');
            page.on('response', async(resp) => {
                try {
                    const req = resp.request();
                    const url = req.url();
                    const status = resp.status();
                    const headers = resp.headers();
                    const rType = req.resourceType?.() || 'unknown';

                    const bucket = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
                    statusCounts[bucket] += 1;

                    net.totalReq += 1;
                    if (status >= 400)
                        net.errors += 1;
                    if (req.redirectedFrom())
                        net.redirects += 1;
                    if (isHttp(url))
                        net.domains.add(hostname(url));

                    const ct = (headers['content-type'] || '').toLowerCase();
                    const enc = headers['content-encoding'];
                    const compressed = !!enc && /(gzip|br|deflate)/i.test(enc);

                    // transferred vs decoded sizes (A)
                    let transferred = 0;
                    let decoded = 0;
                    if (headers['content-length'])
                        transferred = parseInt(headers['content-length'], 10) || 0;
                    else {
                        try {
                            const buf = await resp.body();
                            transferred = buf.length;
                        } catch {}
                    }
                    try {
                        const buf = await resp.body();
                        decoded = buf.length;
                    } catch {
                        decoded = transferred;
                    }
                    net.transferBytes += transferred;
                    net.decodedBytes += decoded;

                    // Compression tracking — compressible types only (A)
                    if (isCompressible(ct, url)) {
                        net.compressibleCount += 1;
                        if (compressed)
                            net.compressedCompressible += 1;
                    }

                    // Cookie header length (request)
                    const reqCookie = req.headers()['cookie'];
                    if (reqCookie)
                        net.cookieHeaderLens.push(Buffer.byteLength(reqCookie, 'utf8'));

                    // Static policy
                    if (isStatic(url)) {
                        const reqHeaders = req.headers();
                        if (reqHeaders['cookie']) {
                            net.staticWithCookies += 1;
                            net.staticCookieDomains.add(hostname(url));
                        }
                        const cc = parseCacheControl(headers['cache-control']);
                        if (!cc.maxAge || cc.noStore || cc.noCache) {
                            net.staticNoCache += 1;
                        } else if (cc.maxAge < minCacheSeconds) {
                            net.staticShortCache += 1;
                        }
                    }

                    // Minification (CSS/JS) — name + content
                    if (/\.(css|js)(\?|$)/i.test(url)) {
                        net.minifyEligible += 1;
                        let looksMin = isMinifiedName(url);
                        if (!looksMin) {
                            try {
                                const body = await resp.body();
                                const sample = body.slice(0, 96 * 1024).toString('utf8');
                                if (looksMinifiedContent(sample))
                                    looksMin = true;
                            } catch {}
                        }
                        if (looksMin)
                            net.minifiedCount += 1;
                    }
                    if (/\.css(\?|$)/i.test(url))
                        net.cssFiles += 1;
                    if (/\.js(\?|$)/i.test(url))
                        net.jsFiles += 1;

                    // Fonts
                    if (rType === 'font' || isFontUrl(url)) {
                        net.fontFileCount += 1;
                        net.fontBytes += decoded;
                    }

                    // Images
                    if (rType === 'image' || isImageUrl(url)) {
                        net.imageCount += 1;
                        net.imageBytes += decoded;
                        const optimized = /image\/(webp|avif|jxl)/.test(ct) || /\.(webp|avif|jxl)(\?|$)/i.test(url);
                        if (optimized)
                            net.imageOptimizedCount += 1;
                        else
                            net.imageLegacyCount += 1;
                        imagesByUrl.set(url.split('#')[0], decoded);
                    }

                    // Log response (no body, to keep logs light)
                    responses.push({
                        url,
                        status,
                        method: req.method(),
                        resourceType: rType,
                        redirected: !!req.redirectedFrom(),
                        requestHeaders: req.headers(),
                        responseHeaders: headers,
                        contentLength: decoded
                    });
                } catch { /* ignore per-response errors */
                }
            });

            // Navigate
            await page.goto(p.url, {
                waitUntil: 'domcontentloaded'
            });
            await page.waitForTimeout(cfg.runtime?.settleAfterMs ?? 2500);

            // Save page HTML
            try {
                const html = await page.content();
                fs.writeFileSync(path.join(pagesDir, `${baseName}.html`), html);
            } catch {}

            // DOM + lazy loading checks
            const domInfo = await page.evaluate(() => {
                const vh = window.innerHeight || 800;
                const toImg = Array.from(document.images).map(img => ({
                            src: img.currentSrc || img.src,
                            naturalW: img.naturalWidth,
                            naturalH: img.naturalHeight,
                            clientW: img.clientWidth,
                            clientH: img.clientHeight,
                            loading: img.getAttribute('loading') || '',
                            hasSrcset: !!img.getAttribute('srcset'),
                            hasSizes: !!img.getAttribute('sizes'),
                            top: img.getBoundingClientRect().top,
                            display: getComputedStyle(img).display,
                            visibility: getComputedStyle(img).visibility
                        }));
                const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
                            loading: f.getAttribute('loading') || '',
                            top: f.getBoundingClientRect().top
                        }));
                const belowFoldNoLazyImages = toImg.filter(i => i.top >= vh && i.loading.toLowerCase() !== 'lazy').length;
                const belowFoldNoLazyIframes = iframes.filter(f => f.top >= vh && f.loading.toLowerCase() !== 'lazy').length;
                return {
                    domSize: document.getElementsByTagName('*').length,
                    inlineStyles: Array.from(document.querySelectorAll('style')).length,
                    inlineScripts: Array.from(document.querySelectorAll('script:not([src])')).length,
                    cssLinks: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).length,
                    printCss: !!document.querySelector('link[rel="stylesheet"][media~="print"]'),
                    socialButtons: !!document.querySelector('[class*="facebook"], [class*="twitter"], [class*="linkedin"], [data-network]'),
                    images: toImg,
                    iframes,
                    belowFoldNoLazyImages,
                    belowFoldNoLazyIframes,
                    cookieLength: (document.cookie || '').length,
                    userAgent: navigator.userAgent,
                    viewportH: vh
                };
            });

            // Derived DOM-based image metrics
            const resizedImgs = domInfo.images.filter(i => i.naturalW && i.naturalH && i.clientW && i.clientH && (i.clientW < i.naturalW || i.clientH < i.naturalH));
            const hiddenDownloaded = domInfo.images.filter(i => i.naturalW > 0 && (i.display === 'none' || i.visibility === 'hidden' || i.clientW === 0 || i.clientH === 0));
            let wastedImageBytes = 0;
            let oversizedCount = 0;
            for (const i of resizedImgs) {
                if (i.clientW > 0 && i.clientH > 0) {
                    const displayedArea = i.clientW * i.clientH;
                    const naturalArea = i.naturalW * i.naturalH;
                    if (displayedArea > 0 && naturalArea > displayedArea) {
                        const oversizeFactor = naturalArea / displayedArea;
                        if (oversizeFactor > 1.5)
                            oversizedCount += 1;
                        const size = imagesByUrl.get((i.src || '').split('#')[0]) || 0;
                        wastedImageBytes += Math.round(size * (1 - 1 / Math.max(1, oversizeFactor)));
                    }
                }
            }

            // Aggregates
            const pageKB_transfer = Math.round((net.transferBytes || 0) / 1024);
            const pageKB_decoded = Math.round((net.decodedBytes || 0) / 1024);
            const transferKB = pageKB_transfer; // KPI uses transferred bytes
            const uniqueDomains = net.domains.size;
            const compressedPct = pct(net.compressedCompressible || 0, net.compressibleCount || 1);
            const minifiedPct = pct(net.minifiedCount || 0, net.minifyEligible || 1);
            const fontsExternal = responses.some(r => isFontUrl(r.url));

            const totalImageResponses = responses.filter(isImageResponse);
            const optimizedImageResponses = totalImageResponses.filter(isOptimizedImageResponse);
            const legacyImageResponses = totalImageResponses.filter(r => !isOptimizedImageResponse(r));
            const imageLegacyPct = pct(legacyImageResponses.length, totalImageResponses.length || 1);
            const totalImageBytes = totalImageResponses.reduce((s, r) => s + (r.contentLength || 0), 0);
            const wastedImagePct = pct(wastedImageBytes, totalImageBytes || 1);

            // (A) impacts — based on transferred bytes over the wire
            const impacts = estimateImpactsFromTransfer(net.transferBytes, {
                kWhPerGB: cfg?.impact?.kWhPerGB,
                grid_g_per_kWh: cfg?.impact?.gridIntensity_g_per_kWh,
                water_L_per_kWh: cfg?.impact?.waterIntensity_L_per_kWh
            });

            // HSTS (document responses over HTTPS)
            const hstsMissing = responses.some(r => r.resourceType === 'document' && /^https:/i.test(r.url) && !Object.keys(r.responseHeaders || {}).some(h => h.toLowerCase() === 'strict-transport-security'));

            // Cookies — compute over requests that actually carry a Cookie header.
// Prefer first-party (same hostname or subdomain), fallback to global.
const baseHost = (() => { try { return new URL(meta.url).hostname; } catch { return ''; } })();
const isSameSite = (u) => {
  try {
    const h = new URL(u).hostname;
    return h === baseHost || (!!baseHost && h.endsWith('.' + baseHost));
  } catch { return false; }
};
const cookieLensAll = responses
  .filter(r => r.requestHeaders && typeof r.requestHeaders.cookie === 'string')
  .map(r => Buffer.byteLength(r.requestHeaders.cookie, 'utf8'));
const cookieLensSame = responses
  .filter(r => isSameSite(r.url) && r.requestHeaders && typeof r.requestHeaders.cookie === 'string')
  .map(r => Buffer.byteLength(r.requestHeaders.cookie, 'utf8'));
const avgBytes = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0) / arr.length) : 0;

const cookieHeaderAvgAll  = avgBytes(cookieLensAll);
const cookieHeaderAvgSame = avgBytes(cookieLensSame);
const cookieHeaderAvg = cookieHeaderAvgSame || cookieHeaderAvgAll;
const cookieHeaderMax = (cookieLensSame.length ? cookieLensSame : cookieLensAll).reduce((m,v)=>Math.max(m,v), 0);

const imageResponsivePct = 
pct(domInfo.images.filter(i => i.hasSrcset).length, domInfo.images.length || 1);

            // Composite KPI
            const kpi = computeCompositeKpi({
                domSize: domInfo.domSize,
                requests: responses.length,
                transferKB,
                uniqueDomains,
                errors: statusCounts['4xx'] + statusCounts['5xx'],
                redirects: statusCounts['3xx'],
                inlineStyles: domInfo.inlineStyles,
                inlineScripts: domInfo.inlineScripts,
                cssFiles: responses.filter(r => /\.css(\?|$)/i.test(r.url)).length,
                jsFiles: responses.filter(r => /\.js(\?|$)/i.test(r.url)).length,
                resizedImages: resizedImgs.length,
                hiddenDownloadedImages: hiddenDownloaded.length,
                staticWithCookies: responses.filter(r => isStatic(r.url) && r.requestHeaders?.cookie).length,
                compressedPct,
                minifiedPct,
                fontsExternal,
                belowFoldNoLazy: domInfo.belowFoldNoLazyImages + domInfo.belowFoldNoLazyIframes,
                staticNoCache: responses.filter(r => isStatic(r.url) && (!parseCacheControl(r.responseHeaders['cache-control'] || '').maxAge || /no-(cache|store)/i.test(r.responseHeaders['cache-control'] || ''))).length,
                imageLegacyPct,
                wastedImagePct,
                hstsMissing,
                cookieHeaderAvg
            }, cfg.kpi || {});

            const meta = {
                timestamp: nowIso(),
                product: target.product,
                pageName: p.name,
                url: p.url
            };
            const classifiedImgs =
                (legacyImageResponses ? legacyImageResponses.length : 0) +
            (optimizedImageResponses ? optimizedImageResponses.length : 0);

            const result = {
                ...meta,
                kpiScore: kpi.score,
                kpiGrade: kpi.grade,
                minifiedPct,
                imageLegacyPct,
                // Core
                domSize: domInfo.domSize,
                requests: responses.length,
                transferKB,
                uniqueDomains,
                errors: statusCounts['4xx'] + statusCounts['5xx'],
                redirects: statusCounts['3xx'],
                inlineStyles: domInfo.inlineStyles,
                inlineScripts: domInfo.inlineScripts,
                cssFiles: responses.filter(r => /\.css(\?|$)/i.test(r.url)).length,
                jsFiles: responses.filter(r => /\.js(\?|$)/i.test(r.url)).length,
                printCss: domInfo.printCss,
                socialButtons: domInfo.socialButtons,
                // Images
                imageResponsivePct,
                resizedImages: resizedImgs.length,
                hiddenDownloadedImages: hiddenDownloaded.length,
                imageLegacyCount: legacyImageResponses.length,
                imageOptimizedCount: optimizedImageResponses.length,
                oversizedImageCount: oversizedCount,
                wastedImageKB: Math.round(wastedImageBytes / 1024),
                wastedImagePct,
                // Static/cache/cookies
                staticWithCookies: responses.filter(r => isStatic(r.url) && r.requestHeaders?.cookie).length,
                staticNoCache: responses.filter(r => isStatic(r.url) && (!parseCacheControl(r.responseHeaders['cache-control'] || '').maxAge || /no-(cache|store)/i.test(r.responseHeaders['cache-control'] || ''))).length,
                staticShortCache: responses.filter(r => isStatic(r.url) && parseCacheControl(r.responseHeaders['cache-control'] || '').maxAge && parseCacheControl(r.responseHeaders['cache-control'] || '').maxAge < (cfg?.cache?.minSeconds ?? 60 * 60 * 24 * 7)).length,
                staticCookieDomains: (new Set(responses.filter(r => isStatic(r.url) && r.requestHeaders?.cookie).map(r => hostname(r.url)))).size,
                cookieHeaderAvg,
                cookieHeaderMax,
                // Fonts
                fontsExternal: responses.some(r => isFontUrl(r.url)),
                fontFileCount: responses.filter(r => isFontUrl(r.url) || r.resourceType === 'font').length,
                fontBytes: responses.filter(r => isFontUrl(r.url) || r.resourceType === 'font').reduce((s, r) => s + r.contentLength, 0),
                // Security / proto / JS errors
                hstsMissing,
                http1Count: protoCounts['http/1.1'],
                h2Count: protoCounts['h2'],
                h3Count: protoCounts['h3'],
                httpOtherCount: protoCounts['other'],
                jsErrorCount: jsErrors.length,
                // Bytes / compression (A)
                pageKB_transfer,
                pageKB_decoded,
                compressedPct,
                // Cookies & UA
                cookieLength: domInfo.cookieLength,
                userAgent: domInfo.userAgent,
                // Impact
                co2_g: round2(impacts.co2_g),
                water_cl: round2(impacts.water_cl),
                energy_kWh: round4(impacts.energy_kWh),
                dataGB: round4(impacts.dataGB),
                impactModel: impacts.model
            };

            // Persist history & CSV (dynamic header)
            fs.appendFileSync(historyPath, JSON.stringify(result) + '\n');
            const headers = Object.keys(result);
            if (!fs.existsSync(csvPath) || fs.readFileSync(csvPath, 'utf8').trim() === '')
                fs.writeFileSync(csvPath, headers.join(',') + '\n');
            fs.appendFileSync(csvPath, toCsvRow(result, headers) + '\n');

            // Persist per-page network + proto + js errors
            fs.writeFileSync(path.join(logsDir, `${baseName}_responses.json`), JSON.stringify({
                    meta,
                    responses,
                    statusCounts,
                    protoCounts
                }, null, 2));
            if (jsErrors.length)
                fs.writeFileSync(path.join(logsDir, `${baseName}_jserrors.json`), JSON.stringify({
                        meta,
                        jsErrors
                    }, null, 2));

            // Console summary
            console.log(`\n[${target.product}] ${p.name}`);
            console.log(`  KPI: ${result.kpiGrade} (${result.kpiScore})` + (kpi.ceilingApplied < 100 ? ` | Ceiling: ${kpi.ceilingApplied}` : ''));

            // Per-page weight: p.weight overrides, else fallback to config (kpi.page_weights)
            const pageWeight =
                (typeof p.weight === 'number' ? p.weight :
                ((cfg?.kpi?.page_weights && ((cfg.kpi.page_weights[target.product] && cfg.kpi.page_weights[target.product][p.name]) ?? cfg.kpi.page_weights[p.name])) ?? 1));
            // Aggregate product-level weighted score
            const keyProd = target.product;
            if (!productTotals.has(keyProd))
                productTotals.set(keyProd, {
                    sumWeightedScore: 0,
                    sumWeights: 0,
                    pages: []
                });
            const agg = productTotals.get(keyProd);
            agg.sumWeightedScore += (kpi.score || 0) * pageWeight;
            agg.sumWeights += pageWeight;
            
agg.pages.push({
  name: p.name,
  url: p.url,
  score: kpi.score || 0,
  grade: kpi.grade || '?',
  weight: pageWeight,
  // Useful for diffs
  metrics: {
    requests: result.requests, transferKB: result.transferKB, domSize: result.domSize, uniqueDomains: result.uniqueDomains,
    compressedPct: result.compressedPct, minifiedPct: result.minifiedPct, inlineStyles: result.inlineStyles, inlineScripts: result.inlineScripts,
    cssFiles: result.cssFiles, jsFiles: result.jsFiles, resizedImages: result.resizedImages, hiddenDownloadedImages: result.hiddenDownloadedImages,
    belowFoldNoLazy: (domInfo.belowFoldNoLazyImages||0)+(domInfo.belowFoldNoLazyIframes||0),
    staticNoCache: result.staticNoCache, staticShortCache: result.staticShortCache, staticWithCookies: result.staticWithCookies,
    imageLegacyPct: result.imageLegacyPct, wastedImagePct: result.wastedImagePct, errors: result.errors, redirects: result.redirects,
    cookieHeaderAvg: result.cookieHeaderAvg, fontsExternal: result.fontsExternal, hstsMissing: result.hstsMissing
  },
  norms: kpi.norms || null,
  breakdown: kpi.breakdown || null,
  effW: kpi.effW || null,
  ceilingApplied: kpi.ceilingApplied || 100,
  scale: kpi.scale || 1
});

            console.log(`  DOM: ${result.domSize} | Requests: ${result.requests} | Transfer: ${prettyBytes(net.transferBytes)} | Decoded: ${prettyBytes(net.decodedBytes)} | Domains: ${uniqueDomains}`);
            console.log(`  Status 2xx/3xx/4xx/5xx: ${statusCounts['2xx']}/${statusCounts['3xx']}/${statusCounts['4xx']}/${statusCounts['5xx']} | Redirects: ${result.redirects}`);
            console.log(`  HTTP protocols: h1=${result.http1Count} h2=${result.h2Count} h3=${result.h3Count} other=${result.httpOtherCount} | JS errors: ${result.jsErrorCount}`);
            console.log(`  Lazy missing img/iframe: ${domInfo.belowFoldNoLazyImages}/${domInfo.belowFoldNoLazyIframes} | Responsive img: ${result.imageResponsivePct}%`);
            console.log(`  Legacy vs optimized images: ${result.imageLegacyCount}/${result.imageOptimizedCount} | Wasted ≈ ${result.wastedImageKB} KB (${result.wastedImagePct}%)`);
            console.log(`  Fonts: ${result.fontFileCount} files, ${prettyBytes(result.fontBytes)} | HSTS missing: ${result.hstsMissing}`);
            console.log(`  Static no-cache/short: ${result.staticNoCache}/${result.staticShortCache} | Static with cookies (domains): ${result.staticWithCookies} (${result.staticCookieDomains})`);
            console.log(`  Page size: ${pageKB_transfer} KB (${pageKB_decoded} KB décodé) | Compression (compressibles): ${compressedPct}%`);
            console.log(`  Impact (model=${impacts.model}): CO₂≈${result.co2_g} g | Eau≈${result.water_cl} cL | Énergie≈${result.energy_kWh} kWh | Données≈${result.dataGB} GB`);

            // ---------- Detailed Markdown Report ----------
            try {
                function lowerBetterStatus(value, thr) {
                    if (!Array.isArray(thr) || thr.length < 4)
                        return {
                            label: 'ℹ️ N/A',
                            level: 'na'
                        };
                    if (value <= thr[0])
                        return {
                            label: '✅ Excellent',
                            level: 'excellent'
                        };
                    if (value <= thr[1])
                        return {
                            label: '✅ Bon',
                            level: 'good'
                        };
                    if (value <= thr[2])
                        return {
                            label: '🟡 À surveiller',
                            level: 'ok'
                        };
                    if (value <= thr[3])
                        return {
                            label: '🟠 À améliorer',
                            level: 'poor'
                        };
                    return {
                        label: '🔴 Critique',
                        level: 'critical'
                    };
                }
                function higherBetterStatus(value, thr) {
                    if (!Array.isArray(thr) || thr.length < 4)
                        return {
                            label: 'ℹ️ N/A',
                            level: 'na'
                        };
                    if (value >= thr[3])
                        return {
                            label: '✅ Excellent',
                            level: 'excellent'
                        };
                    if (value >= thr[2])
                        return {
                            label: '✅ Bon',
                            level: 'good'
                        };
                    if (value >= thr[1])
                        return {
                            label: '🟡 À surveiller',
                            level: 'ok'
                        };
                    if (value >= thr[0])
                        return {
                            label: '🟠 À améliorer',
                            level: 'poor'
                        };
                    return {
                        label: '🔴 Critique',
                        level: 'critical'
                    };
                }
                function mdTable(rows) {
                    if (!rows || !rows.length)
                        return '_Aucun élément._\n';
                    const headers = Object.keys(rows[0]);
                    const head = '| ' + headers.join(' | ') + ' |\n| ' + headers.map(() => '---').join(' | ') + ' |\n';
                    const body = rows.map(r => '| ' + headers.map(h => String(r[h] ?? '')).join(' | ') + ' |').join('\n');
                    return head + body + '\n';
                }
                function topN(arr, n) {
                    return (arr || []).slice(0, n);
                }

                const kpiCfg = cfg.kpi || {};
                const T = kpiCfg.thresholds || {};
                const thr = {
                    requests: T.requests || [27, 50, 80, 120],
                    transferKB: T.transferKB || [300, 800, 1500, 2500],
                    domSize: T.domSize || [800, 1500, 2500, 4000],
                    uniqueDomains: T.uniqueDomains || [6, 10, 15, 20],
                    compressedPct: T.compressedPct || [50, 70, 85, 95],
                    minifiedPct: T.minifiedPct || [50, 70, 85, 95],
                    inlineStyles: T.inlineStyles || [0, 1, 3, 6],
                    inlineScripts: T.inlineScripts || [0, 1, 3, 6],
                    cssFiles: T.cssFiles || [3, 6, 10, 14],
                    jsFiles: T.jsFiles || [5, 10, 20, 35],
                    resizedImages: T.resizedImages || [0, 1, 3, 6],
                    hiddenDownloadedImages: T.hiddenDownloadedImages || [0, 1, 3, 6],
                    belowFoldNoLazy: T.belowFoldNoLazy || [0, 1, 2, 4],
                    staticNoCache: T.staticNoCache || [0, 1, 3, 6],
                    staticShortCache: T.staticShortCache || (T.staticNoCache || [0, 1, 3, 6]),
                    staticWithCookies: T.staticWithCookies || [0, 1, 3, 6],
                    imageLegacyPct: T.imageLegacyPct || [70, 60, 40, 20],
                    wastedImagePct: T.wastedImagePct || [10, 8, 6, 5],
                    errors: T.errors || [0, 1, 2, 4],
                    redirects: T.redirects || [0, 1, 3, 6],
                    cookieHeaderAvg: T.cookieHeaderAvg || [1024, 2048, 3072, 4096]
                };

                // Build issues lists safely (no optional chaining)
                function get(h, k) {
                    return h && h[k] ? h[k] : '';
                }
                function bytesOfCookie(h) {
                    const c = (h && h.cookie) || '';
                    try {
                        return Buffer.byteLength(c, 'utf8')
                    } catch {
                        return (c ? c.length : 0)
                    }
                }
                function parseCC(h) {
                    const v = get(h, 'cache-control').toLowerCase();
                    const out = {
                        noCache: false,
                        noStore: false,
                        maxAge: null
                    };
                    if (!v)
                        return out;
                    if (/no-cache/.test(v))
                        out.noCache = true;
                    if (/no-store/.test(v))
                        out.noStore = true;
                    const m = v.match(/max-age\s*=\s*(\d+)/);
                    if (m)
                        out.maxAge = parseInt(m[1], 10);
                    return out;
                }
                function isCompressible(ct, url) {
                    if (/^(text\/|application\/(javascript|json|xml)|image\/svg\+xml|font\/svg)/i.test(ct))
                        return true;
                    return /\.(css|js|json|svg|xml|html?)(\?|$)/i.test(url || '');
                }
                function isImageUrl(u) {
                    return /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(u || '');
                }
                function isFontUrl(u) {
                    return /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(u || '');
                }
                function isStatic(u) {
                    return /\.(?:css|js|png|jpe?g|webp|avif|svg|gif|woff2?|ttf|otf|eot)(\?|$)/i.test(u || '');
                }

                const minCacheSeconds = (cfg && cfg.cache && typeof cfg.cache.minSeconds === 'number') ? cfg.cache.minSeconds : (60 * 60 * 24 * 7);

                const badCompressibles = responses.filter(r => {
                    const ct = String(get(r.responseHeaders, 'content-type')).toLowerCase();
                    const enc = String(get(r.responseHeaders, 'content-encoding'));
                    const compressible = isCompressible(ct, r.url);
                    const compressed = /(gzip|br|deflate)/i.test(enc);
                    return compressible && !compressed;
                }).map(r => ({
                            url: r.url,
                            'content-type': get(r.responseHeaders, 'content-type') || '',
                            encoding: get(r.responseHeaders, 'content-encoding') || '(none)'
                        }));

                const nonMinified = responses.filter(r => /\.(css|js)(\?|$)/i.test(r.url) && !/\.min\.(js|css)(\?|$)/i.test(r.url))
                    .map(r => ({
                            url: r.url,
                            type: /\.css(\?|$)/i.test(r.url) ? 'css' : 'js'
                        }));

                const staticNoCacheList = responses.filter(r => {
                    if (!isStatic(r.url))
                        return false;
                    const cc = parseCC(r.responseHeaders);
                    return !cc.maxAge || cc.noStore || cc.noCache;
                }).map(r => ({
                            url: r.url,
                            'cache-control': get(r.responseHeaders, 'cache-control') || '(none)'
                        }));

                const staticShortCacheList = responses.filter(r => {
                    if (!isStatic(r.url))
                        return false;
                    const cc = parseCC(r.responseHeaders);
                    return !!cc.maxAge && cc.maxAge < minCacheSeconds;
                }).map(r => {
                    const cc = parseCC(r.responseHeaders);
                    return {
                        url: r.url,
                        'max-age': (cc.maxAge != null ? cc.maxAge : null)
                    };
                });

                const staticWithCookiesList = responses.filter(r => isStatic(r.url) && !!(r.requestHeaders && r.requestHeaders.cookie))
                    .map(r => ({
                            url: r.url,
                            'cookie-len': bytesOfCookie(r.requestHeaders)
                        }));

                const errorList = responses.filter(r => r.status >= 400).map(r => ({
                            status: r.status,
                            url: r.url
                        }));
                const redirectList = responses.filter(r => (r.status >= 300 && r.status < 400) || r.redirected).map(r => ({
                            status: r.status,
                            url: r.url
                        }));

                const belowFoldNoLazyList = (domInfo.images || [])
                .filter(i => (i.top || 0) >= (domInfo.viewportH || 0) && String(i.loading || '').toLowerCase() !== 'lazy')
                .map(i => ({
                        src: i.src,
                        top: Math.round(i.top || 0)
                    }));

                // recompute resized details + wasted
                const resizedDetails = [];
                (domInfo.images || []).forEach(i => {
                    if (i.naturalW && i.naturalH && i.clientW && i.clientH && (i.clientW < i.naturalW || i.clientH < i.naturalH)) {
                        const displayedArea = i.clientW * i.clientH;
                        const naturalArea = i.naturalW * i.naturalH;
                        if (displayedArea > 0 && naturalArea > displayedArea) {
                            const oversizeFactor = naturalArea / displayedArea;
                            const size = imagesByUrl.get((i.src || '').split('#')[0]) || 0;
                            const wastedBytes = Math.round(size * (1 - 1 / Math.max(1, oversizeFactor)));
                            resizedDetails.push({
                                src: i.src,
                                natural: `${i.naturalW}x${i.naturalH}`,
                                displayed: `${i.clientW}x${i.clientH}`,
                                factor: oversizeFactor.toFixed(2),
                                wastedKB: Math.round(wastedBytes / 1024)
                            });
                        }
                    }
                });

                const legacyImgList = responses.filter(r => {
                    const url = r.url || '';
                    const ct = String(get(r.responseHeaders, 'content-type')).toLowerCase();
                    const isImg = (r.resourceType === 'image') || isImageUrl(url);
                    const modernByCT = /image\/(webp|avif|jxl)/i.test(ct);
                    const modernByURL = /\.(webp|avif|jxl)(\?|$)/i.test(url);
                    return isImg && !(modernByCT || modernByURL);
                }).map(r => ({
                            url: r.url,
                            'content-type': get(r.responseHeaders, 'content-type') || '(unknown)',
                            sizeKB: Math.round((r.contentLength || 0) / 1024)
                        }));

                const fontList = responses.filter(r => (r.resourceType === 'font' || isFontUrl(r.url)))
                    .map(r => ({
                            url: r.url,
                            sizeKB: Math.round((r.contentLength || 0) / 1024)
                        }));

                const cookieHeaderTop = responses.filter(r => r.requestHeaders && r.requestHeaders.cookie)
                    .map(r => ({
                            url: r.url,
                            bytes: bytesOfCookie(r.requestHeaders)
                        }))
                    .sort((a, b) => b.bytes - a.bytes);

                const hstsDocs = responses.filter(r => r.resourceType === 'document' && /^https:/i.test(r.url))
                    .filter(r => {
                        const keys = Object.keys(r.responseHeaders || {}).map(k => k.toLowerCase());
                        return !keys.includes('strict-transport-security');
                    }).map(r => ({
                            url: r.url
                        }));

                const belowFoldCount = (domInfo.belowFoldNoLazyImages || 0) + (domInfo.belowFoldNoLazyIframes || 0);

                function whyAndHow(key) {
                    const map = {
                        requests: {
                            why: "Moins de requêtes réduit latence et données chargées.",
                            how: ["Concaténer/regrouper assets critiques.", "Éliminer requêtes inutiles.", "HTTP/2+HTTP/3."]
                        },
                        transferKB: {
                            why: "Chaque Ko a un coût CO2/eau/énergie.",
                            how: ["Compression gzip/br sur types textuels.", "Réduire JS/CSS, supprimer code mort.", "Optimiser images (AVIF/WebP)."]
                        },
                        domSize: {
                            why: "DOM trop gros = parsing lent + augementation consommation mémoire.",
                            how: ["Limiter nœuds générés.", "Virtualiser listes, paginer.", "Nettoyer templates."]
                        },
                        uniqueDomains: {
                            why: "Chaque domaine ajoute DNS/TLS.",
                            how: ["Réduire domaines tiers.", "Self-host quand possible."]
                        },
                        compressedPct: {
                            why: "Compression textuelle = gros gain de temps de chargement.",
                            how: ["Activer gzip/br côté serveur/CDN.", "Vérifier proxies."]
                        },
                        minifiedPct: {
                            why: "Minifier JS/CSS réduit taille de la requête.",
                            how: ["Terser/CSSNano en build.", "Servir *.min.* en prod."]
                        },
                        inlineStyles: {
                            why: "Styles inline empêchent la mise en cache du style.",
                            how: ["Externaliser en feuilles.", "Limiter au CSS critique."]
                        },
                        inlineScripts: {
                            why: "Scripts inline compliquent l'application des CSP et empêchent la mise en cache.",
                            how: ["Externaliser + utiliser defer/async."]
                        },
                        cssFiles: {
                            why: "Trop d'inclusion de CSS multiplie les requêtes web.",
                            how: ["Fusionner et dédupliquer."]
                        },
                        jsFiles: {
                            why: "Trop de JS nuit mutiplie les requêtes web.",
                            how: ["Code-splitting, lazy-load, enlever deps."]
                        },
                        resizedImages: {
                            why: "Surdimension = octets gaspillés.",
                            how: ["Exporter aux dimensions affichées.", "srcset/sizes + AVIF/WebP."]
                        },
                        hiddenDownloadedImages: {
                            why: "Télécharger les images non-visible augmente le nombre de requête et diminue les perfs.",
                            how: ["Lazy-load et éviter display:none pour images."]
                        },
                        belowFoldNoLazy: {
                            why: "Lazy loading évite de télécharger inutilement des resources.",
                            how: ["Ajouter loading='lazy' sur `<img>/<iframe>`."]
                        },
                        staticNoCache: {
                            why: "Sans cache, tout est re-téléchargé.",
                            how: ["Cache-Control: max-age, immutable (assets versionnés)."]
                        },
                        staticShortCache: {
                            why: "Cache trop court réduit le hit-ratio.",
                            how: ["Augmenter max-age (>=7j) pour assets statiques."]
                        },
                        staticWithCookies: {
                            why: "Cookies bloquent le cache et alourdissent.",
                            how: ["Servir via domaine sans cookies.", "Ne pas envoyer de cookies sur /static."]
                        },
                        imageLegacyPct: {
                            why: "Formats d'image legacy pèsent plus lourd et impactent le temps de chargement.",
                            how: ["Préférer format AVIF/WebP + fallback.", "Automatiser via image CDN."]
                        },
                        wastedImagePct: {
                            why: "Une image redimensionné est plus lourde que nécessaire : Octets perdus = empreinte inutile.",
                            how: ["Générer variantes adaptées à la bonne taille(responsive)."]
                        },
                        errors: {
                            why: "4xx/5xx dégradent UX/SEO et augmentent le nombre de requêtes.",
                            how: ["Corriger endpoints cassés, liens morts.", "Mettre en place l'alerting."]
                        },
                        redirects: {
                            why: "Chaînes 3xx allongent TTFB.",
                            how: ["Réécrire liens vers URL finale.", "Réduire redirections."]
                        },
                        cookieHeaderAvg: {
                            why: "Cookies lourds alourdissent chaque requête.",
                            how: ["Nettoyer cookies inutiles.", "Scoper par domaine/chemin."]
                        },
                        fontsExternal: {
                            why: "Les polices tierces ajoutent des latences de chargement.",
                            how: ["Self-host WOFF2.", "Précharger si critique."]
                        },
                        hstsMissing: {
                            why: "HSTS renforce la sécurité.",
                            how: ["Ajouter Strict-Transport-Security."]
                        }
                    };
                    return map[key] || {
                        why: "",
                        how: []
                    };
                }

                function lb(v, key) {
                    return lowerBetterStatus(v, thr[key]).label;
                }
                function hb(v, key) {
                    return higherBetterStatus(v, thr[key]).label;
                }

                const header = `# Rapport GreenIT / RWEB détaillé
**Produit**: ${meta.product}
**Page**: ${meta.pageName}
**URL**: ${meta.url}
**Date**: ${meta.timestamp}

**KPI Composite**: **${result.kpiGrade} (${result.kpiScore})**

`;

                const resume = `## Résumé – Chiffres clés
| Indicateur | Valeur | Statut |
|---|---:|:--|
| Requêtes | ${result.requests} | ${lb(result.requests,'requests')} |
| Transfert | ${result.transferKB} KB | ${lb(result.transferKB,'transferKB')} |
| DOM size | ${result.domSize} | ${lb(result.domSize,'domSize')} |
| Domaines uniques | ${result.uniqueDomains} | ${lb(result.uniqueDomains,'uniqueDomains')} |
| Compression (compressibles) | ${result.compressedPct}% | ${hb(result.compressedPct,'compressedPct')} |
| Minification CSS/JS | ${result.minifiedPct}% | ${hb(result.minifiedPct,'minifiedPct')} |
| Scripts inline | ${result.inlineScripts} | ${lb(result.inlineScripts,'inlineScripts')} |
| Styles inline | ${result.inlineStyles} | ${lb(result.inlineStyles,'inlineStyles')} |
| Fichiers CSS | ${result.cssFiles} | ${lb(result.cssFiles,'cssFiles')} |
| Fichiers JS | ${result.jsFiles} | ${lb(result.jsFiles,'jsFiles')} |
| Images redimensionnées | ${result.resizedImages} | ${lb(result.resizedImages,'resizedImages')} |
| Images cachées/téléchargées | ${result.hiddenDownloadedImages} | ${lb(result.hiddenDownloadedImages,'hiddenDownloadedImages')} |
| Images sous la ligne de flottaison sans lazy | ${(domInfo.belowFoldNoLazyImages||0)+(domInfo.belowFoldNoLazyIframes||0)} | ${lb((domInfo.belowFoldNoLazyImages||0)+(domInfo.belowFoldNoLazyIframes||0),'belowFoldNoLazy')} |
| Assets statiques sans cache | ${result.staticNoCache} | ${lb(result.staticNoCache,'staticNoCache')} |
| Cache statique trop court | ${result.staticShortCache} | ${lb(result.staticShortCache,'staticShortCache')} |
| Assets statiques avec cookies | ${result.staticWithCookies} | ${lb(result.staticWithCookies,'staticWithCookies')} |
| % images legacy | ${result.imageLegacyPct}% | ${lb(result.imageLegacyPct,'imageLegacyPct')} |
| % octets images gaspillés | ${result.wastedImagePct}% | ${lb(result.wastedImagePct,'wastedImagePct')} |
| Erreurs 4xx/5xx | ${result.errors} | ${lb(result.errors,'errors')} |
| Redirections 3xx | ${result.redirects} | ${lb(result.redirects,'redirects')} |
| Taille moyenne Cookie header | ${result.cookieHeaderAvg} B | ${lb(result.cookieHeaderAvg,'cookieHeaderAvg')} |
| HSTS manquant | ${result.hstsMissing ? "Oui" : "Non"} | ${result.hstsMissing ? "🔴 Critique" : "✅ Bon"} |
| HTTP1/H2/H3 | ${result.http1Count}/${result.h2Count}/${result.h3Count} |  |
`;

                function section(key, value) {
                    const tips = whyAndHow(key);
                    const label = (key === 'compressedPct' || key === 'minifiedPct') ? hb(value, key) :
                    (key === 'fontsExternal' || key === 'hstsMissing') ? (key === 'fontsExternal' ? (result.fontsExternal ? '🟠 À améliorer' : '✅ Bon') : (result.hstsMissing ? '🔴 Critique' : '✅ Bon')) :
                    lb(value, key);
                    let s = `\n\n### ${key}
**Valeur**: ${value} — **Statut**: ${label}

**Pourquoi c'est important**: ${tips.why}

**Actions**
${(tips.how||[]).map(a=>`- ${a}`).join('')}`;          return s;        }

                let advice = '## Conseils par indicateur';
                const belowFoldCountZ = (domInfo.belowFoldNoLazyImages || 0) + (domInfo.belowFoldNoLazyIframes || 0);
                advice += section('requests', result.requests);
                advice += section('transferKB', result.transferKB);
                advice += section('domSize', result.domSize);
                advice += section('uniqueDomains', result.uniqueDomains);
                advice += section('compressedPct', result.compressedPct);
                advice += section('minifiedPct', result.minifiedPct);
                advice += section('inlineStyles', result.inlineStyles);
                advice += section('inlineScripts', result.inlineScripts);
                advice += section('cssFiles', result.cssFiles);
                advice += section('jsFiles', result.jsFiles);
                advice += section('resizedImages', result.resizedImages);
                advice += section('hiddenDownloadedImages', result.hiddenDownloadedImages);
                advice += section('belowFoldNoLazy', belowFoldCountZ);
                advice += section('staticNoCache', result.staticNoCache);
                advice += section('staticShortCache', result.staticShortCache);
                advice += section('staticWithCookies', result.staticWithCookies);
                advice += section('imageLegacyPct', result.imageLegacyPct);
                advice += section('wastedImagePct', result.wastedImagePct);
                advice += section('errors', result.errors);
                advice += section('redirects', result.redirects);
                advice += section('cookieHeaderAvg', result.cookieHeaderAvg);
                advice += `\n\n### fontsExternal
**Valeur**: ${result.fontsExternal? '1 (vrai)' : '0 (faux)'} — **Statut**: ${result.fontsExternal ? '🟠 À améliorer' : '✅ Bon'}

**Pourquoi c'est important**: Les polices tierces ajoutent de la latence et des dépendances externes.
**Actions**
- Héberger les polices en WOFF2 sur votre domaine.
- Précharger (preload) les polices critiques si nécessaire.
`;
				        // Detailed calculation section
			let calcMd = '## Détail du calcul\n';
			try {
			  const calcKeys = [
				'requests','transferKB','domSize','uniqueDomains','compressedPct','minifiedPct','inlineStyles','inlineScripts',
				'cssFiles','jsFiles','resizedImages','hiddenDownloadedImages','belowFoldNoLazy','staticNoCache','staticWithCookies',
				'imageLegacyPct','wastedImagePct','errors','redirects','cookieHeaderAvg','fontsExternal','hstsMissing'
			  ];
			  const kpiDebug = (typeof kpi === 'object' && kpi && kpi.norms && kpi.effW) ? kpi : null;

			  
			  if (kpiDebug) {
				calcMd += '| Critère | Valeur | Score (0-100) | Poids | Contribution |\n|---|---:|---:|---:|---:|\n';
				const valOf = (key) => {
				  if (key in result) return result[key];
				  if (key === 'belowFoldNoLazy') return (domInfo.belowFoldNoLazyImages||0)+(domInfo.belowFoldNoLazyIframes||0);
				  return '';
				};
				let sumContrib = 0;
				for (const key of calcKeys) {
				  const val = valOf(key);
				  const score100 = kpiDebug.norms[key] ?? '';
				  const w = (kpiDebug.effW[key] != null) ? kpiDebug.effW[key] : '';
				  const contrib = (typeof score100 === 'number' && typeof w === 'number') ? Math.round(score100 * w * (kpiDebug.scale || 1)) : '';
				  if (typeof contrib === 'number') sumContrib += contrib;
				  calcMd += `| ${key} | ${val} | ${score100} | ${w} | ${contrib} |\n`;
				}
				calcMd += `| **Total** |  |  |  | **${Math.round(sumContrib)}** |\n`;
				if ((kpiDebug.ceilingApplied || 100) < 100) {
				  calcMd += `\n> Plafond appliqué: **${kpiDebug.ceilingApplied}**. Contributions × **${(kpiDebug.scale||1).toFixed(2)}**.\n`;
				}
			  } else {
				calcMd += '_(Données détaillées indisponibles dans cette exécution.)_\n';
			  }
			  //resources = calcMd + '\n' + resources;
			} catch(e) {
			  console.error('[report] calc section failed:', e);
			}
                let resources = '\n## Ressources concernées';
                resources += "\n### Erreurs (4xx/5xx)\n" + mdTable(topN(errorList, 100));
                resources += "\n### Redirections (3xx)\n" + mdTable(topN(redirectList, 100));
                resources += "\n### Ressources compressibles non compressées\n" + mdTable(topN(badCompressibles, 100));
                resources += "\n### CSS/JS non minifiés (heuristique .min.*)\n" + mdTable(topN(nonMinified, 100));
                resources += "\n### Assets statiques sans cache\n" + mdTable(topN(staticNoCacheList, 200));
                resources += "\n### Cache statique trop court\n" + mdTable(topN(staticShortCacheList, 200));
                resources += "\n### Assets statiques envoyés avec cookies\n" + mdTable(topN(staticWithCookiesList, 200));
                resources += "\n### Images sous la ligne de flottaison sans lazy\n" + mdTable(topN(belowFoldNoLazyList, 200));
                resources += "\n### Images redimensionnées / surdimensionnées\n" + mdTable(topN(resizedDetails, 200));
                resources += "\n### Images en formats legacy\n" + mdTable(topN(legacyImgList, 200));
                resources += "\n### Polices\n" + mdTable(topN(fontList, 200));
                resources += "\n### Cookies — top 20 par taille d'en-tête\n" + mdTable(topN(cookieHeaderTop, 20));
                resources += "\n### Documents sans HSTS\n" + mdTable(topN(hstsDocs, 50));

                const reportMd = header + resume + "\n" + advice + "\n" + calcMd + '\n'+ resources;

                const reportsDir = path.join(outDir, 'reports', safeName(meta.product));
                ensureDir(reportsDir);
                const reportPath = path.join(reportsDir, `${baseName}_report.md`);
                fs.writeFileSync(reportPath, reportMd, 'utf8');
                console.log(`  Report: ${reportPath}`);

            } catch (err) {
                console.error('[report] generation failed:', err);
            }

        }
    }
    // ===== Product-level summary (RUN ONCE, after all pages) =====
    for (const [prod, agg] of productTotals.entries()) {
        const totalW = agg.sumWeights || 0;
        const score100 = totalW > 0 ? Math.round(agg.sumWeightedScore / totalW) : 0;
        const grade = gradeAE(score100);
        const score5 = (score100 / 20).toFixed(1);
        console.log(`[${prod}] Global: ${grade} | ${score100}/100 | ${score5}/5`);

        // Un seul fichier GLOBAL par produit
        const ts = nowIso().replace(/[:.]/g, '-');
        const reportsDir = path.join(outDir, 'reports', safeName(prod));
        ensureDir(reportsDir);
        const reportPath = path.join(reportsDir, `${safeName(prod)}_GLOBAL_${ts}.md`);

        const header = `# Rapport global — ${prod}
**Date**: ${nowIso()}

## Note globale
- **Score**: ${score100}/100
- **Grade**: ${grade}
- **Score (/5)**: ${score5}

## Détail par page (pondéré)
| Page | Poids | Score (/100) | Grade |
|---|---:|---:|:--|
`;

        const lines = (agg.pages || []).map(p => {
            const w = (typeof p.weight === 'number') ? p.weight : 1;
            const s = Math.round(p.score || 0);
            const g = p.grade || '?';
            const page = p.name || '(sans nom)';
            return `| ${page} | ${w} | ${s} | ${g} |`;
        }).join('\n');

        const footer = `

### Méthode
La note produit est la moyenne pondérée des scores des pages :
(∑(poids × score)) / (∑ poids) = ${totalW > 0 ? (agg.sumWeightedScore / totalW).toFixed(2) : '0.00'}.

> Les poids peuvent être définis dans :
> - targets[].pages[].weight, ou
> - kpi.page_weights[<Produit>][<Page>] (fallback).
`;

        try {
            fs.writeFileSync(reportPath, header + lines + footer, 'utf8');
            console.log(`  Global report: ${reportPath}`);
    // Write per-product JSON snapshot for diffing
    try {
      const snapshot = {
        product: prod,
        date: nowIso(),
        score100: score100,
        grade: grade,
        score5: score5,
        weights: (cfg && cfg.kpi && cfg.kpi.weights) ? cfg.kpi.weights : null,
        thresholds: (cfg && cfg.kpi && cfg.kpi.thresholds) ? cfg.kpi.thresholds : null,
        pages: agg.pages
      };
      const jsonPath = path.join(reportsDir, `${safeName(prod)}_RUN_${ts}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), 'utf8');
      console.log(`  Global snapshot: ${jsonPath}`);
    } catch(e) {
      console.error('[global snapshot] write failed:', e);
    }

        } catch (e) {
            console.error('[global report] write failed:', e);
        }
    }
    

// ------ compare-latest (optional) ------
if (compareLatestFor) {
    const want = String(compareLatestFor).toLowerCase();
    for (const [prod] of productTotals.entries()) {
        if (want !== 'all' && prod.toLowerCase() !== want) continue;
        const reportsDir = path.join(outDir, 'reports', safeName(prod));
        try {
            const files = fs.readdirSync(reportsDir).filter(f => /_RUN_.*\.json$/.test(f)).sort();
            if (files.length < 2) { console.warn(`[diff] Not enough snapshots for ${prod} in ${reportsDir}`); continue; }
            const baseName = files[files.length - 2];
            const headName = files[files.length - 1];
            const base = JSON.parse(fs.readFileSync(path.join(reportsDir, baseName), 'utf8'));
            const head = JSON.parse(fs.readFileSync(path.join(reportsDir, headName), 'utf8'));
            const md = _buildDiffMd(prod, base, head, baseName, headName);
            const outName = `DIFF_${safeName(prod)}_${baseName.replace(/\.json$/, '')}_vs_${headName.replace(/\.json$/, '')}.md`;
            const outPath = path.join(reportsDir, outName);
            fs.writeFileSync(outPath, md, 'utf8');
            console.log(`[diff] Latest compared for ${prod}: ${outPath}`);
        } catch (e) {
            console.error('[diff] compare-latest failed:', e);
        }
    }
}
await context.close();
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});

/* --------------------------------------------------------
config.yml (example)
---------------------------------------------------------
login:
# Either reuse a captured session:
storageStatePath: "out/auth/storageState.json"
# Or enable form-fill (optional):
# url: "https://example.com/login"
# usernameSelector: "#username"
# passwordSelector: "#password"
# submitSelector: "button[type=submit]"
# usernameEnv: "KPI_USER"
# passwordEnv: "KPI_PASS"
# waitFor: "networkidle"

runtime:
headless: true
ignoreHTTPSErrors: false
navigationTimeoutMs: 60000
settleAfterMs: 2500
# userDataDir: "./pw-profile"  # persistent profile to replicate cookies from a real session

cache:
minSeconds: 604800     # 7 days min cache for static assets

impact:
kWhPerGB: 0.81
gridIntensity_g_per_kWh: 442
waterIntensity_L_per_kWh: 1.9

kpi:
weights: {}
thresholds: {}

targets:
- product: "MySanteClair Web"
pages:
- name: "Home"
url: "https://services.integration.santeclair.fr/pu/mysanteclair"
- name: "Géoloc"
url: "https://services.integration.santeclair.fr/pu/mysanteclair/trouver_un_partenaire/resultats?domain=OPTIQUE&speciality=OPTICIEN&latitude=47.218371&longitude=-1.553621"
*/
