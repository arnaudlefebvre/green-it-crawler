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

import { pct, isStatic, isImageUrl, isFontUrl, parseCacheControl, isOptimizedImageResponse, isImageResponse } from '../utils/network-helpers.js'

export function calculateMetrics(responses, domInfo, net, statusCounts, cfg) {
  const pageKB_transfer = Math.round((net.transferBytes || 0) / 1024)
  const pageKB_decoded = Math.round((net.decodedBytes || 0) / 1024)
  const transferKB = pageKB_transfer
  const uniqueDomains = net.domains.size
  const compressedPct = pct(net.compressedCompressible || 0, net.compressibleCount || 1)
  const minifiedPct = pct(net.minifiedCount || 0, net.minifyEligible || 1)
  const fontsExternal = responses.some(r => isFontUrl(r.url))

  const totalImageResponses = responses.filter(isImageResponse)
  const optimizedImageResponses = totalImageResponses.filter(isOptimizedImageResponse)
  const legacyImageResponses = totalImageResponses.filter(r => !isOptimizedImageResponse(r))
  const imageLegacyPct = pct(legacyImageResponses.length, totalImageResponses.length || 1)

  const resizedImgs = domInfo.images.filter(i => 
    i.naturalW && i.naturalH && i.clientW && i.clientH && 
    (i.clientW < i.naturalW || i.clientH < i.naturalH)
  )
  const hiddenDownloaded = domInfo.images.filter(i => 
    i.naturalW > 0 && (i.display === 'none' || i.visibility === 'hidden' || i.clientW === 0 || i.clientH === 0)
  )

  let wastedImageBytes = 0
  let oversizedCount = 0
  const imagesByUrl = new Map()
  
  // Build imagesByUrl map from responses
  responses.filter(r => r.resourceType === 'image' || isImageUrl(r.url))
    .forEach(r => imagesByUrl.set(r.url.split('#')[0], r.contentLength || 0))

  for (const i of resizedImgs) {
    if (i.clientW > 0 && i.clientH > 0) {
      const displayedArea = i.clientW * i.clientH
      const naturalArea = i.naturalW * i.naturalH
      if (displayedArea > 0 && naturalArea > displayedArea) {
        const oversizeFactor = naturalArea / displayedArea
        if (oversizeFactor > 1.5) oversizedCount += 1
        const size = imagesByUrl.get((i.src || '').split('#')[0]) || 0
        wastedImageBytes += Math.round(size * (1 - 1 / Math.max(1, oversizeFactor)))
      }
    }
  }

  const totalImageBytes = totalImageResponses.reduce((s, r) => s + (r.contentLength || 0), 0)
  const wastedImagePct = pct(wastedImageBytes, totalImageBytes || 1)

  const hstsMissing = responses.some(r => 
    r.resourceType === 'document' && 
    /^https:/i.test(r.url) && 
    !Object.keys(r.responseHeaders || {}).some(h => h.toLowerCase() === 'strict-transport-security')
  )

  // Cookie calculations
  const baseHost = (() => { 
    try { 
      return new URL(responses.find(r => r.resourceType === 'document')?.url || '').hostname 
    } catch { 
      return '' 
    } 
  })()
  
  const isSameSite = (u) => {
    try {
      const h = new URL(u).hostname
      return h === baseHost || (!!baseHost && h.endsWith('.' + baseHost))
    } catch { 
      return false 
    }
  }

  const cookieLensAll = responses
    .filter(r => r.requestHeaders && typeof r.requestHeaders.cookie === 'string')
    .map(r => Buffer.byteLength(r.requestHeaders.cookie, 'utf8'))
  const cookieLensSame = responses
    .filter(r => isSameSite(r.url) && r.requestHeaders && typeof r.requestHeaders.cookie === 'string')
    .map(r => Buffer.byteLength(r.requestHeaders.cookie, 'utf8'))
  
  const avgBytes = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b,0) / arr.length) : 0
  const cookieHeaderAvgAll = avgBytes(cookieLensAll)
  const cookieHeaderAvgSame = avgBytes(cookieLensSame)
  const cookieHeaderAvg = cookieHeaderAvgSame || cookieHeaderAvgAll
  const cookieHeaderMax = (cookieLensSame.length ? cookieLensSame : cookieLensAll).reduce((m,v)=>Math.max(m,v), 0)

  const imageResponsivePct = pct(domInfo.images.filter(i => i.hasSrcset).length, domInfo.images.length || 1)

  const minCacheSeconds = cfg?.cache?.minSeconds ?? 60 * 60 * 24 * 7

  return {
    // Core metrics
    domSize: domInfo.domSize,
    requests: responses.length,
    transferKB,
    pageKB_transfer,
    pageKB_decoded,
    uniqueDomains,
    errors: statusCounts['4xx'] + statusCounts['5xx'],
    redirects: statusCounts['3xx'],
    
    // Styles & Scripts
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
    imageLegacyPct,
    oversizedImageCount: oversizedCount,
    wastedImageKB: Math.round(wastedImageBytes / 1024),
    wastedImagePct,
    
    // Compression & Minification
    compressedPct,
    minifiedPct,
    
    // Cache & Cookies
    staticWithCookies: responses.filter(r => isStatic(r.url) && r.requestHeaders?.cookie).length,
    staticNoCache: responses.filter(r => 
      isStatic(r.url) && 
      (!parseCacheControl(r.responseHeaders['cache-control'] || '').maxAge || 
       /no-(cache|store)/i.test(r.responseHeaders['cache-control'] || ''))
    ).length,
    staticShortCache: responses.filter(r => 
      isStatic(r.url) && 
      parseCacheControl(r.responseHeaders['cache-control'] || '').maxAge && 
      parseCacheControl(r.responseHeaders['cache-control'] || '').maxAge < minCacheSeconds
    ).length,
    staticCookieDomains: (new Set(responses.filter(r => isStatic(r.url) && r.requestHeaders?.cookie).map(r => new URL(r.url).hostname))).size,
    cookieHeaderAvg,
    cookieHeaderMax,
    cookieLength: domInfo.cookieLength,
    
    // Fonts
    fontsExternal,
    fontFileCount: responses.filter(r => isFontUrl(r.url) || r.resourceType === 'font').length,
    fontBytes: responses.filter(r => isFontUrl(r.url) || r.resourceType === 'font').reduce((s, r) => s + (r.contentLength || 0), 0),
    
    // Security & Protocol
    hstsMissing,
    
    // Lazy loading
    belowFoldNoLazy: domInfo.belowFoldNoLazyImages + domInfo.belowFoldNoLazyIframes,
    
    // User Agent
    userAgent: domInfo.userAgent
  }
}