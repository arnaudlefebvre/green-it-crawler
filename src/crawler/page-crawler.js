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

import { isHttp, isStatic, isCompressible, isMinifiedName, isFontUrl, isImageUrl, looksMinifiedContent, parseCacheControl, hostname } from '../utils/network-helpers.js'

export async function crawlPage(page, pageConfig, cfg) {
  const responses = []
  const statusCounts = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }
  const imagesByUrl = new Map()
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
  }

  // HTTP protocol via CDP
  const context = page.context()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  const protoCounts = { 'http/1.1': 0, 'h2': 0, 'h3': 0, 'other': 0 }
  
  cdp.on('Network.responseReceived', e => {
    const proto = (e.response?.protocol || '').toLowerCase()
    if (proto.includes('http/1.1')) protoCounts['http/1.1']++
    else if (proto.includes('h2')) protoCounts['h2']++
    else if (proto.includes('h3')) protoCounts['h3']++
    else protoCounts['other']++
  })

  // JavaScript console errors
  const jsErrors = []
  page.removeAllListeners('console')
  page.on('console', msg => {
    if (msg.type() === 'error') jsErrors.push(msg.text())
  })

  const minCacheSeconds = cfg?.cache?.minSeconds ?? 60 * 60 * 24 * 7

  // Response handler
  page.removeAllListeners('response')
  page.on('response', async(resp) => {
    try {
      const req = resp.request()
      const url = req.url()
      const status = resp.status()
      const headers = resp.headers()
      const rType = req.resourceType?.() || 'unknown'

      const bucket = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx'
      statusCounts[bucket] += 1

      net.totalReq += 1
      if (status >= 400) net.errors += 1
      if (req.redirectedFrom()) net.redirects += 1
      if (isHttp(url)) net.domains.add(hostname(url))

      const ct = (headers['content-type'] || '').toLowerCase()
      const enc = headers['content-encoding']
      const compressed = !!enc && /(gzip|br|deflate)/i.test(enc)

      // transferred vs decoded sizes
      let transferred = 0
      let decoded = 0
      if (headers['content-length']) {
        transferred = parseInt(headers['content-length'], 10) || 0
      } else {
        try {
          const buf = await resp.body()
          transferred = buf.length
        } catch {}
      }
      try {
        const buf = await resp.body()
        decoded = buf.length
      } catch {
        decoded = transferred
      }
      net.transferBytes += transferred
      net.decodedBytes += decoded

      // Compression tracking
      if (isCompressible(ct, url)) {
        net.compressibleCount += 1
        if (compressed) net.compressedCompressible += 1
      }

      // Cookie header length (request)
      const reqCookie = req.headers()['cookie']
      if (reqCookie) net.cookieHeaderLens.push(Buffer.byteLength(reqCookie, 'utf8'))

      // Static policy
      if (isStatic(url)) {
        const reqHeaders = req.headers()
        if (reqHeaders['cookie']) {
          net.staticWithCookies += 1
          net.staticCookieDomains.add(hostname(url))
        }
        const cc = parseCacheControl(headers['cache-control'])
        if (!cc.maxAge || cc.noStore || cc.noCache) {
          net.staticNoCache += 1
        } else if (cc.maxAge < minCacheSeconds) {
          net.staticShortCache += 1
        }
      }

      // Minification (CSS/JS)
      if (/\.(css|js)(\?|$)/i.test(url)) {
        net.minifyEligible += 1
        let looksMin = isMinifiedName(url)
        if (!looksMin) {
          try {
            const body = await resp.body()
            const sample = body.slice(0, 96 * 1024).toString('utf8')
            if (looksMinifiedContent(sample)) looksMin = true
          } catch {}
        }
        if (looksMin) net.minifiedCount += 1
      }
      if (/\.css(\?|$)/i.test(url)) net.cssFiles += 1
      if (/\.js(\?|$)/i.test(url)) net.jsFiles += 1

      // Fonts
      if (rType === 'font' || isFontUrl(url)) {
        net.fontFileCount += 1
        net.fontBytes += decoded
      }

      // Images
      if (rType === 'image' || isImageUrl(url)) {
        net.imageCount += 1
        net.imageBytes += decoded
        const optimized = /image\/(webp|avif|jxl)/.test(ct) || /\.(webp|avif|jxl)(\?|$)/i.test(url)
        if (optimized) net.imageOptimizedCount += 1
        else net.imageLegacyCount += 1
        imagesByUrl.set(url.split('#')[0], decoded)
      }

      // Log response
      responses.push({
        url,
        status,
        method: req.method(),
        resourceType: rType,
        redirected: !!req.redirectedFrom(),
        requestHeaders: req.headers(),
        responseHeaders: headers,
        contentLength: decoded
      })
    } catch {
      // ignore per-response errors
    }
  })

  // Navigate
  await page.goto(pageConfig.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(cfg.runtime?.settleAfterMs ?? 2500)

  // DOM + lazy loading checks
  const domInfo = await page.evaluate(() => {
    const vh = window.innerHeight || 800
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
    }))
    const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
      loading: f.getAttribute('loading') || '',
      top: f.getBoundingClientRect().top
    }))
    const belowFoldNoLazyImages = toImg.filter(i => i.top >= vh && i.loading.toLowerCase() !== 'lazy').length
    const belowFoldNoLazyIframes = iframes.filter(f => f.top >= vh && f.loading.toLowerCase() !== 'lazy').length
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
    }
  })

  return {
    responses,
    statusCounts,
    protoCounts,
    jsErrors,
    domInfo,
    net,
    imagesByUrl
  }
}