import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Utils
import { ensureDir, nowIso, safeName, prettyBytes } from './utils/file-helpers.js'
import { loadConfig } from './utils/config-loader.js'

// Crawler
import { createBrowserContext, closeBrowserContext } from './crawler/browser-manager.js'
import { performLogin } from './crawler/auth-handler.js'
import { crawlPage } from './crawler/page-crawler.js'

// KPI
import { calculateMetrics } from './kpi/metrics-calculator.js'
import { computeCompositeKpi } from './kpi/kpi-scorer.js'
import { estimateImpactsFromTransfer } from './kpi/impact-estimator.js'

// Reporting
import { appendToHistory, appendToCsv } from './reporting/csv-exporter.js'
import { generateDetailedReport } from './reporting/report-generator.js'
import { compareLatestReports } from './reporting/diff-generator.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function gradeAE(score) {
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  if (score >= 50) return 'E'
  if (score >= 40) return 'F'
  return 'G'
}

async function run() {
  const args = process.argv.slice(2)
  const cfgPath = args.includes('--config') ? args[args.indexOf('--config') + 1] : path.join(__dirname, '..', 'config.yml')
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(__dirname, '..', 'out')
  const persistSession = args.includes('--persist-session')
  const compareLatestFor = args.includes('--compare-latest') ? (args[args.indexOf('--compare-latest') + 1] || 'all') : null

  ensureDir(outDir)
  const cfg = loadConfig(cfgPath)

  const pagesDir = path.join(outDir, 'pages')
  const logsDir = path.join(outDir, 'logs')
  const authDir = path.join(outDir, 'auth')
  ensureDir(pagesDir)
  ensureDir(logsDir)
  ensureDir(authDir)

  const historyPath = path.join(outDir, 'history.jsonl')
  const csvPath = path.join(outDir, 'history.csv')

  // Persistent user profile
  const userDataDir = cfg.runtime?.userDataDir || path.join(__dirname, '..', 'pw-profile')
  const { context, page } = await createBrowserContext(cfg, userDataDir)

  const productTotals = new Map()

  for (const target of (cfg.targets || [])) {
    try { 
      await context.clearCookies() 
    } catch {}

    // Per-product auth: run public pages first, then login and run private pages
    const productLoginCfg = target.login || cfg.login
    // Sort: public (no auth) first, then auth-required
    const _pagesOrdered = [...(target.pages || [])].sort((a,b)=>{
      const ar = !!(a.auth === 'required' || a.requiresAuth === true)
      const br = !!(b.auth === 'required' || b.requiresAuth === true)
      return (ar === br) ? 0 : (ar ? 1 : -1)
    })
    
    let _isLoggedIn = false
    for (const p of _pagesOrdered) {
      const needsAuth = (p.auth === 'required' || p.requiresAuth === true)
      if (needsAuth && !_isLoggedIn) {
        try { 
          await context.clearCookies() 
        } catch {}
        await performLogin(context, page, productLoginCfg, persistSession, authDir, target.product)
        _isLoggedIn = true
      }

      const ts = nowIso().replace(/[:.]/g, '-')
      const baseName = `${safeName(target.product)}_${safeName(p.name)}_${ts}`

      // Crawl the page
      const crawlResult = await crawlPage(page, p, cfg)
      const { responses, statusCounts, protoCounts, jsErrors, domInfo, net } = crawlResult

      // Save page HTML
      try {
        const html = await page.content()
        fs.writeFileSync(path.join(pagesDir, `${baseName}.html`), html)
      } catch {}

      // Calculate metrics
      const metrics = calculateMetrics(responses, domInfo, net, statusCounts, cfg)

      // Calculate KPI
      const kpi = computeCompositeKpi(metrics, cfg.kpi || {})

      // Calculate environmental impact
      const impacts = estimateImpactsFromTransfer(net.transferBytes, {
        kWhPerGB: cfg?.impact?.kWhPerGB,
        grid_g_per_kWh: cfg?.impact?.gridIntensity_g_per_kWh,
        water_L_per_kWh: cfg?.impact?.waterIntensity_L_per_kWh
      })

      const meta = {
        timestamp: nowIso(),
        product: target.product,
        pageName: p.name,
        url: p.url
      }

      const result = {
        ...meta,
        kpiScore: kpi.score,
        kpiGrade: kpi.grade,
        ...metrics,
        // Protocol counts
        http1Count: protoCounts['http/1.1'],
        h2Count: protoCounts['h2'],
        h3Count: protoCounts['h3'],
        httpOtherCount: protoCounts['other'],
        jsErrorCount: jsErrors.length,
        // Impact
        co2_g: impacts.co2_g,
        water_cl: impacts.water_cl,
        energy_kWh: impacts.energy_kWh,
        dataGB: impacts.dataGB,
        impactModel: impacts.model
      }

      // Persist history & CSV
      appendToHistory(historyPath, result)
      appendToCsv(csvPath, result)

      // Generate detailed report
      generateDetailedReport(outDir, meta, result, kpi, domInfo, responses, cfg)

      // Persist per-page network logs
      fs.writeFileSync(path.join(logsDir, `${baseName}_responses.json`), JSON.stringify({
        meta,
        responses,
        statusCounts,
        protoCounts
      }, null, 2))
      
      if (jsErrors.length) {
        fs.writeFileSync(path.join(logsDir, `${baseName}_jserrors.json`), JSON.stringify({
          meta,
          jsErrors
        }, null, 2))
      }

      // Console summary
      console.log(`\n[${target.product}] ${p.name}`)
      console.log(`  KPI: ${result.kpiGrade} (${result.kpiScore})` + (kpi.ceilingApplied < 100 ? ` | Ceiling: ${kpi.ceilingApplied}` : ''))

      // Per-page weight
      const pageWeight = (typeof p.weight === 'number' ? p.weight :
        ((cfg?.kpi?.page_weights && ((cfg.kpi.page_weights[target.product] && cfg.kpi.page_weights[target.product][p.name]) ?? cfg.kpi.page_weights[p.name])) ?? 1))
      
      // Aggregate product-level weighted score
      const keyProd = target.product
      if (!productTotals.has(keyProd)) {
        productTotals.set(keyProd, {
          sumWeightedScore: 0,
          sumWeights: 0,
          pages: []
        })
      }
      const agg = productTotals.get(keyProd)
      agg.sumWeightedScore += (kpi.score || 0) * pageWeight
      agg.sumWeights += pageWeight
      
      agg.pages.push({
        name: p.name,
        url: p.url,
        score: kpi.score || 0,
        grade: kpi.grade || '?',
        weight: pageWeight,
        metrics: {
          requests: result.requests, 
          transferKB: result.transferKB, 
          domSize: result.domSize, 
          uniqueDomains: result.uniqueDomains,
          compressedPct: result.compressedPct, 
          minifiedPct: result.minifiedPct, 
          inlineStyles: result.inlineStyles, 
          inlineScripts: result.inlineScripts,
          cssFiles: result.cssFiles, 
          jsFiles: result.jsFiles, 
          resizedImages: result.resizedImages, 
          hiddenDownloadedImages: result.hiddenDownloadedImages,
          belowFoldNoLazy: (domInfo.belowFoldNoLazyImages||0)+(domInfo.belowFoldNoLazyIframes||0),
          staticNoCache: result.staticNoCache, 
          staticShortCache: result.staticShortCache, 
          staticWithCookies: result.staticWithCookies,
          imageLegacyPct: result.imageLegacyPct, 
          wastedImagePct: result.wastedImagePct, 
          errors: result.errors, 
          redirects: result.redirects,
          cookieHeaderAvg: result.cookieHeaderAvg, 
          fontsExternal: result.fontsExternal, 
          hstsMissing: result.hstsMissing
        },
        norms: kpi.norms || null,
        breakdown: kpi.breakdown || null,
        effW: kpi.effW || null,
        ceilingApplied: kpi.ceilingApplied || 100,
        scale: kpi.scale || 1
      })

      console.log(`  DOM: ${result.domSize} | Requests: ${result.requests} | Transfer: ${prettyBytes(net.transferBytes)} | Decoded: ${prettyBytes(net.decodedBytes)} | Domains: ${result.uniqueDomains}`)
      console.log(`  Status 2xx/3xx/4xx/5xx: ${statusCounts['2xx']}/${statusCounts['3xx']}/${statusCounts['4xx']}/${statusCounts['5xx']} | Redirects: ${result.redirects}`)
      console.log(`  HTTP protocols: h1=${result.http1Count} h2=${result.h2Count} h3=${result.h3Count} other=${result.httpOtherCount} | JS errors: ${result.jsErrorCount}`)
      console.log(`  Lazy missing img/iframe: ${domInfo.belowFoldNoLazyImages}/${domInfo.belowFoldNoLazyIframes} | Responsive img: ${result.imageResponsivePct}%`)
      console.log(`  Legacy vs optimized images: ${result.imageLegacyCount}/${result.imageOptimizedCount} | Wasted ≈ ${result.wastedImageKB} KB (${result.wastedImagePct}%)`)
      console.log(`  Fonts: ${result.fontFileCount} files, ${prettyBytes(result.fontBytes)} | HSTS missing: ${result.hstsMissing}`)
      console.log(`  Static no-cache/short: ${result.staticNoCache}/${result.staticShortCache} | Static with cookies (domains): ${result.staticWithCookies} (${result.staticCookieDomains})`)
      console.log(`  Page size: ${result.pageKB_transfer} KB (${result.pageKB_decoded} KB décodé) | Compression (compressibles): ${result.compressedPct}%`)
      console.log(`  Impact (model=${impacts.model}): CO₂≈${result.co2_g} g | Eau≈${result.water_cl} cL | Énergie≈${result.energy_kWh} kWh | Données≈${result.dataGB} GB`)
    }
  }

  // Product-level summary
  for (const [prod, agg] of productTotals.entries()) {
    const totalW = agg.sumWeights || 0
    const score100 = totalW > 0 ? Math.round(agg.sumWeightedScore / totalW) : 0
    const grade = gradeAE(score100)
    const score5 = (score100 / 20).toFixed(1)
    console.log(`[${prod}] Global: ${grade} | ${score100}/100 | ${score5}/5`)

    // Write global report
    const ts = nowIso().replace(/[:.]/g, '-')
    const reportsDir = path.join(outDir, 'reports', safeName(prod))
    ensureDir(reportsDir)
    const reportPath = path.join(reportsDir, `${safeName(prod)}_GLOBAL_${ts}.md`)

    const header = `# Rapport global — ${prod}
**Date**: ${nowIso()}

## Note globale
- **Score**: ${score100}/100
- **Grade**: ${grade}
- **Score (/5)**: ${score5}

## Détail par page (pondéré)
| Page | Poids | Score (/100) | Grade |
|---|---:|---:|:--|
`

    const lines = (agg.pages || []).map(p => {
      const w = (typeof p.weight === 'number') ? p.weight : 1
      const s = Math.round(p.score || 0)
      const g = p.grade || '?'
      const page = p.name || '(sans nom)'
      return `| ${page} | ${w} | ${s} | ${g} |`
    }).join('\n')

    const footer = `

### Méthode
La note produit est la moyenne pondérée des scores des pages :
(∑(poids × score)) / (∑ poids) = ${totalW > 0 ? (agg.sumWeightedScore / totalW).toFixed(2) : '0.00'}.

> Les poids peuvent être définis dans :
> - targets[].pages[].weight, ou
> - kpi.page_weights[<Produit>][<Page>] (fallback).
`

    try {
      fs.writeFileSync(reportPath, header + lines + footer, 'utf8')
      console.log(`  Global report: ${reportPath}`)
      
      // Write per-product JSON snapshot for diffing
      const snapshot = {
        product: prod,
        date: nowIso(),
        score100: score100,
        grade: grade,
        score5: score5,
        weights: (cfg && cfg.kpi && cfg.kpi.weights) ? cfg.kpi.weights : null,
        thresholds: (cfg && cfg.kpi && cfg.kpi.thresholds) ? cfg.kpi.thresholds : null,
        pages: agg.pages
      }
      const jsonPath = path.join(reportsDir, `${safeName(prod)}_RUN_${ts}.json`)
      fs.writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2), 'utf8')
      console.log(`  Global snapshot: ${jsonPath}`)
    } catch(e) {
      console.error('[global report] write failed:', e)
    }
  }

  // Compare latest reports if requested
  compareLatestReports(outDir, productTotals, compareLatestFor)

  await closeBrowserContext(context)
}

run().catch(e => {
  console.error(e)
  process.exit(1)
})