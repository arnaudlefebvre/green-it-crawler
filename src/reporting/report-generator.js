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

import fs from 'fs'
import path from 'path'
import { ensureDir, safeName, nowIso } from '../utils/file-helpers.js'
import { gradeEnvironmentalImpact, getImpactStatus } from '../kpi/impact-estimator.js'

function lowerBetterStatus(value, thr) {
  if (!Array.isArray(thr) || thr.length < 4) return { label: 'ℹ️ N/A', level: 'na' }
  if (value <= thr[0]) return { label: '✅ Excellent', level: 'excellent' }
  if (value <= thr[1]) return { label: '✅ Bon', level: 'good' }
  if (value <= thr[2]) return { label: '🟡 À surveiller', level: 'ok' }
  if (value <= thr[3]) return { label: '🟠 À améliorer', level: 'poor' }
  return { label: '🔴 Critique', level: 'critical' }
}

function higherBetterStatus(value, thr) {
  if (!Array.isArray(thr) || thr.length < 4) return { label: 'ℹ️ N/A', level: 'na' }
  if (value >= thr[3]) return { label: '✅ Excellent', level: 'excellent' }
  if (value >= thr[2]) return { label: '✅ Bon', level: 'good' }
  if (value >= thr[1]) return { label: '🟡 À surveiller', level: 'ok' }
  if (value >= thr[0]) return { label: '🟠 À améliorer', level: 'poor' }
  return { label: '🔴 Critique', level: 'critical' }
}

function mdTable(rows) {
  if (!rows || !rows.length) return '_Aucun élément._\n'
  const headers = Object.keys(rows[0])
  const head = '| ' + headers.join(' | ') + ' |\n| ' + headers.map(() => '---').join(' | ') + ' |\n'
  const body = rows.map(r => '| ' + headers.map(h => String(r[h] ?? '')).join(' | ') + ' |').join('\n')
  return head + body + '\n'
}

function topN(arr, n) {
  return (arr || []).slice(0, n)
}

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
  }
  return map[key] || { why: "", how: [] }
}

export function generateDetailedReport(outDir, meta, result, kpi, domInfo, responses, cfg, impacts) {
  try {
    const kpiCfg = cfg.kpi || {}
    const T = kpiCfg.thresholds || {}
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
    }

    function lb(v, key) {
      return lowerBetterStatus(v, thr[key]).label
    }
    function hb(v, key) {
      return higherBetterStatus(v, thr[key]).label
    }

    const header = `# Rapport GreenIT / RWEB détaillé
**Produit**: ${meta.product}
**Page**: ${meta.pageName}
**URL**: ${meta.url}
**Date**: ${meta.timestamp}

**KPI Composite**: **${result.kpiGrade} (${result.kpiScore})**

## 🌱 Impact Environnemental (Mix énergétique français)
${impacts ? `
**Grade environnemental**: **${gradeEnvironmentalImpact(impacts, cfg.kpi?.thresholds)}**

| Indicateur | Valeur | Statut | Équivalence |
|---|---:|:--|:--|
| CO₂ | ${impacts.co2_g} g | ${getImpactStatus(impacts.co2_g, cfg.kpi?.thresholds?.co2_g || [0.5, 1.0, 2.0, 4.0], 'co2').emoji} ${getImpactStatus(impacts.co2_g, cfg.kpi?.thresholds?.co2_g || [0.5, 1.0, 2.0, 4.0], 'co2').label} | ${(impacts.co2_g / 4.6 * 1000).toFixed(0)}m en voiture |
| Énergie | ${impacts.energy_kWh} kWh | ${getImpactStatus(impacts.energy_kWh, cfg.kpi?.thresholds?.energy_kWh || [0.0006, 0.0012, 0.0025, 0.005], 'energy').emoji} ${getImpactStatus(impacts.energy_kWh, cfg.kpi?.thresholds?.energy_kWh || [0.0006, 0.0012, 0.0025, 0.005], 'energy').label} | ${(impacts.energy_kWh * 60).toFixed(1)}min d'ampoule LED |
| Eau | ${impacts.water_cl} cL | ${getImpactStatus(impacts.water_cl, cfg.kpi?.thresholds?.water_cl || [0.05, 0.1, 0.2, 0.4], 'water').emoji} ${getImpactStatus(impacts.water_cl, cfg.kpi?.thresholds?.water_cl || [0.05, 0.1, 0.2, 0.4], 'water').label} | ${(impacts.water_cl / 25).toFixed(2)} verres d'eau |
| Données | ${impacts.dataGB} GB | ${getImpactStatus(impacts.dataGB, cfg.kpi?.thresholds?.dataGB || [0.0005, 0.001, 0.002, 0.004], 'data').emoji} ${getImpactStatus(impacts.dataGB, cfg.kpi?.thresholds?.dataGB || [0.0005, 0.001, 0.002, 0.004], 'data').label} | ${(impacts.dataGB * 1024).toFixed(1)} MB transférés |

> **Modèle**: ${impacts.model} - Mix énergétique français 2023 (79g CO₂/kWh)
` : '_Données d\'impact non disponibles._'}

`

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
`

    function section(key, value) {
      const tips = whyAndHow(key)
      const label = (key === 'compressedPct' || key === 'minifiedPct') ? hb(value, key) :
        (key === 'fontsExternal' || key === 'hstsMissing') ? (key === 'fontsExternal' ? (result.fontsExternal ? '🟠 À améliorer' : '✅ Bon') : (result.hstsMissing ? '🔴 Critique' : '✅ Bon')) :
        lb(value, key)
      let s = `\n\n### ${key}
**Valeur**: ${value} — **Statut**: ${label}

**Pourquoi c'est important**: ${tips.why}

**Actions**
${(tips.how||[]).map(a=>`- ${a}`).join('\n')}`
      return s
    }

    let advice = '## Conseils par indicateur'
    const belowFoldCountZ = (domInfo.belowFoldNoLazyImages || 0) + (domInfo.belowFoldNoLazyIframes || 0)
    advice += section('requests', result.requests)
    advice += section('transferKB', result.transferKB)
    advice += section('domSize', result.domSize)
    advice += section('uniqueDomains', result.uniqueDomains)
    advice += section('compressedPct', result.compressedPct)
    advice += section('minifiedPct', result.minifiedPct)
    advice += section('inlineStyles', result.inlineStyles)
    advice += section('inlineScripts', result.inlineScripts)
    advice += section('cssFiles', result.cssFiles)
    advice += section('jsFiles', result.jsFiles)
    advice += section('resizedImages', result.resizedImages)
    advice += section('hiddenDownloadedImages', result.hiddenDownloadedImages)
    advice += section('belowFoldNoLazy', belowFoldCountZ)
    advice += section('staticNoCache', result.staticNoCache)
    advice += section('staticShortCache', result.staticShortCache)
    advice += section('staticWithCookies', result.staticWithCookies)
    advice += section('imageLegacyPct', result.imageLegacyPct)
    advice += section('wastedImagePct', result.wastedImagePct)
    advice += section('errors', result.errors)
    advice += section('redirects', result.redirects)
    advice += section('cookieHeaderAvg', result.cookieHeaderAvg)
    advice += `\n\n### fontsExternal
**Valeur**: ${result.fontsExternal? '1 (vrai)' : '0 (faux)'} — **Statut**: ${result.fontsExternal ? '🟠 À améliorer' : '✅ Bon'}

**Pourquoi c'est important**: Les polices tierces ajoutent de la latence et des dépendances externes.
**Actions**
- Héberger les polices en WOFF2 sur votre domaine.
- Précharger (preload) les polices critiques si nécessaire.
`

    // Detailed calculation section
    let calcMd = '## Détail du calcul\n'
    try {
      const calcKeys = [
        'requests','transferKB','domSize','uniqueDomains','compressedPct','minifiedPct','inlineStyles','inlineScripts',
        'cssFiles','jsFiles','resizedImages','hiddenDownloadedImages','belowFoldNoLazy','staticNoCache','staticWithCookies',
        'imageLegacyPct','wastedImagePct','errors','redirects','cookieHeaderAvg','fontsExternal','hstsMissing',
        'co2Impact','energyImpact','waterImpact','dataImpact'
      ]
      const kpiDebug = (typeof kpi === 'object' && kpi && kpi.norms && kpi.effW) ? kpi : null

      if (kpiDebug) {
        calcMd += '| Critère | Valeur | Score (0-100) | Poids | Contribution |\n|---|---:|---:|---:|---:|\n'
        const valOf = (key) => {
          if (key in result) return result[key]
          if (key === 'belowFoldNoLazy') return (domInfo.belowFoldNoLazyImages||0)+(domInfo.belowFoldNoLazyIframes||0)
          if (key === 'co2Impact' && impacts) return `${impacts.co2_g}g CO₂`
          if (key === 'energyImpact' && impacts) return `${impacts.energy_kWh}kWh`
          if (key === 'waterImpact' && impacts) return `${impacts.water_cl}cL`
          if (key === 'dataImpact' && impacts) return `${impacts.dataGB}GB`
          return ''
        }
        let sumContrib = 0
        for (const key of calcKeys) {
          const val = valOf(key)
          const score100 = kpiDebug.norms[key] ?? ''
          const w = (kpiDebug.effW[key] != null) ? kpiDebug.effW[key] : ''
          const contrib = (typeof score100 === 'number' && typeof w === 'number') ? Math.round(score100 * w * (kpiDebug.scale || 1)) : ''
          if (typeof contrib === 'number') sumContrib += contrib
          calcMd += `| ${key} | ${val} | ${score100} | ${w} | ${contrib} |\n`
        }
        calcMd += `| **Total** |  |  |  | **${Math.round(sumContrib)}** |\n`
        if ((kpiDebug.ceilingApplied || 100) < 100) {
          calcMd += `\n> Plafond appliqué: **${kpiDebug.ceilingApplied}**. Contributions × **${(kpiDebug.scale||1).toFixed(2)}**.\n`
        }
      } else {
        calcMd += '_(Données détaillées indisponibles dans cette exécution.)_\n'
      }
    } catch(e) {
      console.error('[report] calc section failed:', e)
    }

    const reportMd = header + resume + "\n" + advice + "\n" + calcMd

    const ts = nowIso().replace(/[:.]/g, '-')
    const baseName = `${safeName(meta.product)}_${safeName(meta.pageName)}_${ts}`
    const reportsDir = path.join(outDir, 'reports', safeName(meta.product))
    ensureDir(reportsDir)
    const reportPath = path.join(reportsDir, `${baseName}_report.md`)
    fs.writeFileSync(reportPath, reportMd, 'utf8')
    console.log(`  Report: ${reportPath}`)

  } catch (err) {
    console.error('[report] generation failed:', err)
  }
}