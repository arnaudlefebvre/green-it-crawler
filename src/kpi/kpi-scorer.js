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

import { scoreEnvironmentalImpact } from './impact-estimator.js'

function normalizeLowerBetter(value, thresholds) {
  if (value <= thresholds[0]) return 100
  if (value <= thresholds[1]) return 75
  if (value <= thresholds[2]) return 50
  if (value <= thresholds[3]) return 25
  return 0
}

function normalizeHigherBetter(value, thresholds) {
  if (value >= thresholds[3]) return 100
  if (value >= thresholds[2]) return 75
  if (value >= thresholds[1]) return 50
  if (value >= thresholds[0]) return 25
  return 0
}

function gradeAE(score) {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  if (score >= 45) return 'D'
  if (score >= 30) return 'E'
  if (score >= 15) return 'F'
  return 'G'
}

function evalKpiCond(m, expr) {
  try {
    return new Function('m', `with(m){ return (${expr}); }`)(m)
  } catch {
    return false
  }
}

function computeScoreCeiling(metrics, kpiCfg) {
  const rules = (kpiCfg && kpiCfg.score_ceilings) || []
  let max = 100
  for (const r of rules) {
    if (!r || typeof r.max_score !== 'number' || !r.if) continue
    if (evalKpiCond(metrics, r.if)) {
      const v = Math.max(0, Math.min(100, r.max_score))
      max = Math.min(max, v)
    }
  }
  return max
}

export function computeCompositeKpi(metrics, kpiCfg, impacts = null) {
  const W = kpiCfg?.weights || {}
  const T = kpiCfg?.thresholds || {}
  
  // Include environmental impact weights (default to 10% total)
  const weights = {
    requests: W.requests ?? 0.35,
    transferKB: W.transferKB ?? 0.20,
    domSize: W.domSize ?? 0.15,
    uniqueDomains: W.uniqueDomains ?? 0.08,
    compressedPct: W.compressedPct ?? 0.04,
    minifiedPct: W.minifiedPct ?? 0.04,
    inlineStyles: W.inlineStyles ?? 0.02,
    inlineScripts: W.inlineScripts ?? 0.02,
    cssFiles: W.cssFiles ?? 0.015,
    jsFiles: W.jsFiles ?? 0.015,
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
    cookieHeaderAvg: W.cookieHeaderAvg ?? 0.01,
    // Environmental impact weights
    co2Impact: W.co2Impact ?? 0.04,
    energyImpact: W.energyImpact ?? 0.03,
    waterImpact: W.waterImpact ?? 0.02,
    dataImpact: W.dataImpact ?? 0.01
  }
  
  const _sumW = Object.values(weights).reduce((a,b)=>a + (typeof b === 'number' ? b : 0), 0) || 1
  const effW = Object.fromEntries(
    Object.entries(weights).map(([k,v]) => [k, (typeof v === 'number' ? v/_sumW : 0)])
  )
  
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
    cookieHeaderAvg: T.cookieHeaderAvg ?? [1024, 2048, 3072, 4096],
    // Environmental impact thresholds (French context)
    co2_g: T.co2_g ?? [0.5, 1.0, 2.0, 4.0],
    energy_kWh: T.energy_kWh ?? [0.0006, 0.0012, 0.0025, 0.005],
    water_cl: T.water_cl ?? [0.05, 0.1, 0.2, 0.4],
    dataGB: T.dataGB ?? [0.0005, 0.001, 0.002, 0.004]
  }

  // Normalized metric scores (0..100) BEFORE weighting
  const norms = {}
  norms.requests = normalizeLowerBetter(metrics.requests, thr.requests)
  norms.transferKB = normalizeLowerBetter(metrics.transferKB, thr.transferKB)
  norms.domSize = normalizeLowerBetter(metrics.domSize, thr.domSize)
  norms.uniqueDomains = normalizeLowerBetter(metrics.uniqueDomains, thr.uniqueDomains)
  norms.compressedPct = normalizeHigherBetter(metrics.compressedPct, thr.compressedPct)
  norms.minifiedPct = normalizeHigherBetter(metrics.minifiedPct, thr.minifiedPct)
  norms.inlineStyles = normalizeLowerBetter(metrics.inlineStyles, thr.inlineStyles)
  norms.inlineScripts = normalizeLowerBetter(metrics.inlineScripts, thr.inlineScripts)
  norms.cssFiles = normalizeLowerBetter(metrics.cssFiles, thr.cssFiles)
  norms.jsFiles = normalizeLowerBetter(metrics.jsFiles, thr.jsFiles)
  norms.resizedImages = normalizeLowerBetter(metrics.resizedImages, thr.resizedImages)
  norms.hiddenDownloadedImages = normalizeLowerBetter(metrics.hiddenDownloadedImages, thr.hiddenDownloadedImages)
  norms.staticWithCookies = normalizeLowerBetter(metrics.staticWithCookies, thr.staticWithCookies)
  norms.redirects = normalizeLowerBetter(metrics.redirects, thr.redirects)
  norms.errors = normalizeLowerBetter(metrics.errors, thr.errors)
  norms.fontsExternal = (metrics.fontsExternal ? 40 : 100)
  norms.belowFoldNoLazy = normalizeLowerBetter(metrics.belowFoldNoLazy, thr.belowFoldNoLazy)
  norms.staticNoCache = normalizeLowerBetter(metrics.staticNoCache, thr.staticNoCache)
  norms.imageLegacyPct = normalizeLowerBetter(metrics.imageLegacyPct, thr.imageLegacyPct)
  norms.wastedImagePct = normalizeLowerBetter(metrics.wastedImagePct, thr.wastedImagePct)
  norms.hstsMissing = (metrics.hstsMissing ? 40 : 100)
  norms.cookieHeaderAvg = normalizeLowerBetter(metrics.cookieHeaderAvg, thr.cookieHeaderAvg)

  // Environmental impact scores
  if (impacts) {
    const impactScores = scoreEnvironmentalImpact(impacts, {
      co2_g: thr.co2_g,
      energy_kWh: thr.energy_kWh,
      water_cl: thr.water_cl,
      dataGB: thr.dataGB
    })
    norms.co2Impact = impactScores.co2Score
    norms.energyImpact = impactScores.energyScore
    norms.waterImpact = impactScores.waterScore
    norms.dataImpact = impactScores.dataScore
  } else {
    // If no impacts provided, use neutral scores
    norms.co2Impact = 60
    norms.energyImpact = 60
    norms.waterImpact = 60
    norms.dataImpact = 60
  }

  // Contributions BEFORE ceiling: norm * effW
  const parts = {}
  for (const k of Object.keys(effW)) parts[k] = (norms[k] ?? 0) * effW[k]

  // Apply numeric ceiling scaling
  const ceiling = computeScoreCeiling(metrics, kpiCfg)
  const scale = (ceiling < 100) ? (ceiling / 100) : 1
  if (scale !== 1) for (const k of Object.keys(parts)) parts[k] = parts[k] * scale

  let score = Object.values(parts).reduce((a,b)=>a+b,0)
  score = Math.round(score)
  score = Math.max(0, Math.min(ceiling < 100 ? ceiling : 100, score))

  const grade = gradeAE(score)

  return { 
    score, 
    grade, 
    breakdown: parts, 
    norms, 
    effW, 
    ceilingApplied: (ceiling < 100 ? ceiling : 100), 
    scale 
  }
}