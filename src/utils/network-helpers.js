export function isHttp(url) {
  return /^https?:\/\//i.test(url)
}

export function isStatic(url) {
  return /\.(css|js|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|mp4|webm|avif)(\?|$)/i.test(url)
}

export function isMinifiedName(url) {
  return /\.min\.(js|css)(\?|$)/i.test(url)
}

export function isImageUrl(url) {
  return /\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i.test(url)
}

export function isFontUrl(url) {
  return /\.(woff2?|ttf|otf)(\?|$)/i.test(url)
}

export function isCompressible(ct, url) {
  const t = (ct || '').toLowerCase()
  return /(^text\/|javascript|json|xml|svg|font\/svg)/.test(t) || /\.(css|js|json|svg|xml|html?)(\?|$)/i.test(url)
}

export function hostname(u) {
  try {
    return new URL(u).hostname
  } catch {
    return 'unknown'
  }
}

export function pct(num, den) {
  return den > 0 ? Math.round((num / den) * 100) : 0
}

export function looksMinifiedContent(text) {
  if (!text) return false
  const len = text.length
  if (len < 2000) return false
  const spaces = (text.match(/\s/g) || []).length
  const ratio = spaces / len
  const avgLine = len / (text.split('\n').length)
  return ratio < 0.15 && avgLine > 200
}

export function parseCacheControl(cc) {
  if (!cc) return {
    maxAge: null,
    noStore: false,
    noCache: false,
    privateScope: false
  }
  const lower = cc.toLowerCase()
  const noStore = /no-store/.test(lower)
  const noCache = /no-cache/.test(lower)
  const isPrivate = /private/.test(lower)
  const m = lower.match(/max-age\s*=\s*(\d+)/)
  const maxAge = m ? parseInt(m[1], 10) : null
  return { maxAge, noStore, noCache, privateScope: isPrivate }
}

export function isOptimizedImageResponse(r) {
  const ct = (r.responseHeaders?.['content-type'] || '').toLowerCase()
  return /\.(webp|avif|jxl)(\?|$)/i.test(r.url) || /image\/(webp|avif|jxl)/i.test(ct)
}

export function isImageResponse(r) {
  return r.resourceType === 'image' || isImageUrl(r.url)
}