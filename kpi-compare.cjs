/*
 * Copyright 2025 Arnaud Lefebvre
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv){
  const args = { _: [] };
  for (let i=2;i<argv.length;i++){
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--head') args.head = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else args._.push(a);
  }
  return args;
}

function loadJson(p){
  try { return JSON.parse(fs.readFileSync(p,'utf8')); }
  catch(e){ throw new Error(`Failed to read JSON ${p}: ${e.message}`); }
}

function gradeArrow(a,b){ return a===b ? a : `${a} → ${b}`; }
function sign(n){ return n>0?`+${n}`:`${n}`; }
function pad(n){ return (n!=null && !Number.isNaN(n)) ? n : ''; }

function mapPagesBy(pages){
  const map = new Map();
  (pages||[]).forEach(pg => {
    const k = (pg && (pg.name || pg.url || '')).toLowerCase();
    if (k) map.set(k, pg);
  });
  return map;
}

function topNChanges(deltaObj, n=5, direction='neg'){
  const entries = Object.entries(deltaObj).filter(([,v]) => typeof v === 'number');
  entries.sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]));
  const neg = entries.filter(([,v])=>v<0).slice(0,n);
  const pos = entries.filter(([,v])=>v>0).slice(0,n);
  return direction==='neg' ? neg : pos;
}

function metricDeltas(baseM, headM){
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
      out[k] = ( (typeof b === 'number' ? b : 0) - (typeof a === 'number' ? a : 0) );
    }
  });
  return out;
}

function noteworthyMetrics(d, thresholds){
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

function fileTs(p){
  const m = String(path.basename(p)).match(/(\d{4}-\d{2}-\d{2}T[^_]+?)/);
  return m ? m[1] : '';
}

function main(){
  const args = parseArgs(process.argv);
  if (!args.base || !args.head){
    console.error('Usage: node kpi-compare.js --base old.json --head new.json [--out outDir]');
    process.exit(2);
  }
  const base = loadJson(args.base);
  const head = loadJson(args.head);
  const product = head.product || base.product || '(inconnu)';
  const outDir = args.out || path.dirname(args.head);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Global deltas
  const prodDelta = Math.round((head.score100||0) - (base.score100||0));
  const prodGrade = gradeArrow(base.grade||'?', head.grade||'?');

  // Page maps
  const mb = mapPagesBy(base.pages||[]);
  const mh = mapPagesBy(head.pages||[]);
  const keys = new Set([...mb.keys(), ...mh.keys()]);

  let md = `# Diff KPI — ${product}
**Base**: ${fileTs(args.base)} — **Head**: ${fileTs(args.head)}

## Global
- **Score produit**: ${pad(base.score100)}/${pad(head.score100)} (${sign(prodDelta)})
- **Grade**: ${prodGrade}

`;

  // Per-page summary table
  md += `## Pages — résumé\n| Page | Score (base→head) | Δ | Grade (base→head) | Poids (head) |\n|---|---:|---:|:--|---:|\n`;
  const pageSummaries = [];
  for (const k of keys){
    const a = mb.get(k);
    const b = mh.get(k);
    const name = (b && b.name) || (a && a.name) || k;
    const baseScore = a ? Math.round(a.score||0) : null;
    const headScore = b ? Math.round(b.score||0) : null;
    const d = (headScore!=null && baseScore!=null) ? (headScore - baseScore) : (headScore!=null ? headScore : (baseScore!=null ? -baseScore : 0));
    const g = gradeArrow(a ? (a.grade||'?') : '—', b ? (b.grade||'?') : '—');
    const w = b && typeof b.weight === 'number' ? b.weight : (a && typeof a.weight === 'number' ? a.weight : 1);
    pageSummaries.push({ name, baseScore, headScore, d, g, w, a, b });
  }
  // sort by largest negative delta first
  pageSummaries.sort((x,y)=> (x.d - y.d));
  pageSummaries.forEach(p => {
    md += `| ${p.name} | ${pad(p.baseScore)}→${pad(p.headScore)} | ${sign(p.d)} | ${p.g} | ${p.w} |\n`;
  });

  // Detailed sections
  for (const p of pageSummaries){
    md += `\n### ${p.name}\n`;
    md += `- **Score**: ${pad(p.baseScore)} → ${pad(p.headScore)} (${sign(p.d)})  \n`;
    md += `- **Grade**: ${p.g}  \n`;
    if (p.a && p.b && typeof p.a.ceilingApplied === 'number' && typeof p.b.ceilingApplied === 'number' && p.a.ceilingApplied !== p.b.ceilingApplied){
      md += `- **Plafond**: ${p.a.ceilingApplied} → ${p.b.ceilingApplied}\n`;
    }

    // Contributions delta
    const baseBreak = (p.a && p.a.breakdown) || {};
    const headBreak = (p.b && p.b.breakdown) || {};
    const allK = new Set([...Object.keys(baseBreak), ...Object.keys(headBreak)]);
    const deltaContrib = {};
    allK.forEach(k => {
      const a = typeof baseBreak[k] === 'number' ? baseBreak[k] : 0;
      const b = typeof headBreak[k] === 'number' ? headBreak[k] : 0;
      deltaContrib[k] = Math.round(b - a);
    });
    const worst = topNChanges(deltaContrib, 5, 'neg');
    const best  = topNChanges(deltaContrib, 5, 'pos');

    if (worst.length){
      md += `\n**Principales régressions (Δ contribution)**\n`;
      worst.forEach(([k,v]) => md += `- ${k}: ${v}\n`);
    }
    if (best.length){
      md += `\n**Principales améliorations (Δ contribution)**\n`;
      best.forEach(([k,v]) => md += `- ${k}: +${v}\n`);
    }

    // Noteworthy metric changes
    const deltas = metricDeltas(p.a && p.a.metrics, p.b && p.b.metrics);
    const noteworthy = noteworthyMetrics(deltas);
    if (noteworthy.length){
      md += `\n**Changements de métriques notables**\n| Métrique | Base | Head | Δ |\n|---|---:|---:|---:|\n`;
      noteworthy.forEach(([k,v]) => {
        const baseVal = p.a && p.a.metrics ? p.a.metrics[k] : '';
        const headVal = p.b && p.b.metrics ? p.b.metrics[k] : '';
        md += `| ${k} | ${pad(baseVal)} | ${pad(headVal)} | ${sign(Math.round(v))} |\n`;
      });
    }
  }

  const outName = `DIFF_${(head.product||'product').replace(/\\s+/g,'_')}_${fileTs(args.base)}_vs_${fileTs(args.head)}.md`;
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`Diff written: ${outPath}`);
}

main();
