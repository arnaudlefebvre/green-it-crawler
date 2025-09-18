import fs from 'fs'
import path from 'path'
import { safeName } from '../utils/file-helpers.js'

function _nextArg(args, flag) {
  const i = args.indexOf(flag)
  if (i === -1) return null
  const v = args[i+1]
  return (v && !String(v).startsWith('--')) ? v : null
}

function _sign(n) { 
  return n>0?`+${n}`:`${n}` 
}

function _pad(n) { 
  return (n!=null && !Number.isNaN(n)) ? n : '' 
}

function _gradeArrow(a,b) { 
  return a===b ? a : `${a} → ${b}` 
}

function _mapPagesBy(pages) {
  const map = new Map()
  ;(pages||[]).forEach(pg => {
    const k = (pg && (pg.name || pg.url || '')).toLowerCase()
    if (k) map.set(k, pg)
  })
  return map
}

function _metricDeltas(baseM, headM) {
  const keys = [
    'requests','transferKB','domSize','uniqueDomains','compressedPct','minifiedPct',
    'inlineStyles','inlineScripts','cssFiles','jsFiles','resizedImages','hiddenDownloadedImages',
    'belowFoldNoLazy','staticNoCache','staticShortCache','staticWithCookies',
    'imageLegacyPct','wastedImagePct','errors','redirects','cookieHeaderAvg'
  ]
  const out = {}
  keys.forEach(k => {
    const a = baseM ? baseM[k] : undefined
    const b = headM ? headM[k] : undefined
    if (typeof a === 'number' || typeof b === 'number') {
      out[k] = ((typeof b === 'number' ? b : 0) - (typeof a === 'number' ? a : 0))
    }
  })
  return out
}

function _topNChanges(deltaObj, n=5, dir='neg') {
  const entries = Object.entries(deltaObj).filter(([,v]) => typeof v === 'number')
  entries.sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))
  const neg = entries.filter(([,v])=>v<0).slice(0,n)
  const pos = entries.filter(([,v])=>v>0).slice(0,n)
  return dir==='neg' ? neg : pos
}

function _noteworthyMetrics(d, thresholds) {
  const thr = Object.assign({
    requests: 5, transferKB: 250, domSize: 200, uniqueDomains: 2,
    compressedPct: 5, minifiedPct: 5,
    staticNoCache: 2, staticShortCache: 2, staticWithCookies: 1,
    imageLegacyPct: 5, wastedImagePct: 5,
    errors: 1, redirects: 1
  }, thresholds||{})
  return Object.entries(d)
    .filter(([k,v]) => Math.abs(v||0) >= (thr[k] || Infinity))
    .sort((a,b)=>Math.abs(b[1]) - Math.abs(a[1]))
}

function _fileTsFromName(basename) {
  const m = String(basename).match(/_RUN_([0-9\-T]+)\.json$/)
  return m ? m[1] : ''
}

function _buildDiffMd(product, base, head, baseName, headName) {
  const prodDelta = Math.round((head.score100||0) - (base.score100||0))
  const prodGrade = _gradeArrow(base.grade||'?', head.grade||'?')

  const mb = _mapPagesBy(base.pages||[])
  const mh = _mapPagesBy(head.pages||[])
  const keys = new Set([...mb.keys(), ...mh.keys()])

  let md = `# Diff KPI — ${product}
**Base**: ${_fileTsFromName(baseName)} — **Head**: ${_fileTsFromName(headName)}

## Global
- **Score produit**: ${_pad(base.score100)}/${_pad(head.score100)} (${_sign(prodDelta)})
- **Grade**: ${prodGrade}

`
  md += `## Pages — résumé
| Page | Score (base→head) | Δ | Grade (base→head) | Poids (head) |
|---|---:|---:|:--|---:|
`
  const pageSummaries = []
  for (const k of keys) {
    const a = mb.get(k)
    const b = mh.get(k)
    const name = (b && b.name) || (a && a.name) || k
    const baseScore = a ? Math.round(a.score||0) : null
    const headScore = b ? Math.round(b.score||0) : null
    const d = (headScore!=null && baseScore!=null) ? (headScore - baseScore) : (headScore!=null ? headScore : (baseScore!=null ? -baseScore : 0))
    const g = _gradeArrow(a ? (a.grade||'?') : '—', b ? (b.grade||'?') : '—')
    const w = b && typeof b.weight === 'number' ? b.weight : (a && typeof a.weight === 'number' ? a.weight : 1)
    pageSummaries.push({ name, baseScore, headScore, d, g, w, a, b })
  }
  pageSummaries.sort((x,y)=> (x.d - y.d))
  pageSummaries.forEach(p => {
    md += `| ${p.name} | ${_pad(p.baseScore)}→${_pad(p.headScore)} | ${_sign(p.d)} | ${p.g} | ${p.w} |
`
  })

  for (const p of pageSummaries) {
    md += `
### ${p.name}
- **Score**: ${_pad(p.baseScore)} → ${_pad(p.headScore)} (${_sign(p.d)})  
- **Grade**: ${p.g}  
`
    if (p.a && p.b && typeof p.a.ceilingApplied === 'number' && typeof p.b.ceilingApplied === 'number' && p.a.ceilingApplied !== p.b.ceilingApplied) {
      md += `- **Plafond**: ${p.a.ceilingApplied} → ${p.b.ceilingApplied}
`
    }
    const baseBreak = (p.a && p.a.breakdown) || {}
    const headBreak = (p.b && p.b.breakdown) || {}
    const allK = new Set([...Object.keys(baseBreak), ...Object.keys(headBreak)])
    const deltaContrib = {}
    allK.forEach(k => {
      const a = typeof baseBreak[k] === 'number' ? baseBreak[k] : 0
      const b = typeof headBreak[k] === 'number' ? headBreak[k] : 0
      deltaContrib[k] = Math.round(b - a)
    })
    const worst = _topNChanges(deltaContrib, 5, 'neg')
    const best  = _topNChanges(deltaContrib, 5, 'pos')
    if (worst.length) {
      md += `
**Principales régressions (Δ contribution)**
`
      worst.forEach(([k,v]) => md += `- ${k}: ${v}
`)
    }
    if (best.length) {
      md += `
**Principales améliorations (Δ contribution)**
`
      best.forEach(([k,v]) => md += `- ${k}: +${v}
`)
    }
    const deltas = _metricDeltas(p.a && p.a.metrics, p.b && p.b.metrics)
    const noteworthy = _noteworthyMetrics(deltas)
    if (noteworthy.length) {
      md += `
**Changements de métriques notables**
| Métrique | Base | Head | Δ |
|---|---:|---:|---:|
`
      noteworthy.forEach(([k,v]) => {
        const baseVal = p.a && p.a.metrics ? p.a.metrics[k] : ''
        const headVal = p.b && p.b.metrics ? p.b.metrics[k] : ''
        md += `| ${k} | ${_pad(baseVal)} | ${_pad(headVal)} | ${_sign(Math.round(v))} |
`
      })
    }
  }
  return md
}

export function compareLatestReports(outDir, productTotals, compareLatestFor) {
  if (!compareLatestFor) return

  const want = String(compareLatestFor).toLowerCase()
  for (const [prod] of productTotals.entries()) {
    if (want !== 'all' && prod.toLowerCase() !== want) continue
    const reportsDir = path.join(outDir, 'reports', safeName(prod))
    try {
      const files = fs.readdirSync(reportsDir).filter(f => /_RUN_.*\.json$/.test(f)).sort()
      if (files.length < 2) { 
        console.warn(`[diff] Not enough snapshots for ${prod} in ${reportsDir}`)
        continue 
      }
      const baseName = files[files.length - 2]
      const headName = files[files.length - 1]
      const base = JSON.parse(fs.readFileSync(path.join(reportsDir, baseName), 'utf8'))
      const head = JSON.parse(fs.readFileSync(path.join(reportsDir, headName), 'utf8'))
      const md = _buildDiffMd(prod, base, head, baseName, headName)
      const outName = `DIFF_${safeName(prod)}_${baseName.replace(/\.json$/, '')}_vs_${headName.replace(/\.json$/, '')}.md`
      const outPath = path.join(reportsDir, outName)
      fs.writeFileSync(outPath, md, 'utf8')
      console.log(`[diff] Latest compared for ${prod}: ${outPath}`)
    } catch (e) {
      console.error('[diff] compare-latest failed:', e)
    }
  }
}