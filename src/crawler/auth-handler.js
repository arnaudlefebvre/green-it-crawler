import path from 'path'
import { safeName } from '../utils/file-helpers.js'

export async function performLogin(context, page, loginCfg, persistSession, authDir, productName) {
  if (!loginCfg) return false

  // selectors can be string or array of strings (engines allowed: css=, xpath=, text=, role=, etc.)
  const getArr = (v) => Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : [])

  const timeoutMs = (typeof loginCfg.timeoutMs === 'number' ? loginCfg.timeoutMs : 45000)
  const { url, submitSelector, waitFor } = loginCfg

  // Resolve credentials (per-product envs supported)
  const prodKey = (productName || 'default')
  const safeProd = safeName(prodKey).toUpperCase()
  const prefix = loginCfg.envPrefix || (`KPI_${safeProd}_`)
  const userEnvName = loginCfg.usernameEnv || (prefix + 'USER')
  const passEnvName = loginCfg.passwordEnv || (prefix + 'PASS')
  let user = loginCfg.username != null ? String(loginCfg.username) : process.env[userEnvName]
  let pass = loginCfg.password != null ? String(loginCfg.password) : process.env[passEnvName]

  // Build selector candidates, include deep-shadow variants for Vaadin-like fields
  const usernameSelectors = getArr(loginCfg.usernameSelector || loginCfg.usernameSelectors)
  const passwordSelectors = getArr(loginCfg.passwordSelector || loginCfg.passwordSelectors)
  const expandShadow = (sel) => {
    // If already has engine prefix or '>>>', keep as-is
    if (/^[a-z]+=/.test(sel) || sel.includes('>>>')) return [sel]
    // If ID or tag#id, add deep combinator as a fallback
    const out = [sel]
    out.push(`css=${sel} >>> input`)
    return out
  }
  const userCandidates = usernameSelectors.flatMap(expandShadow)
  const passCandidates = passwordSelectors.flatMap(expandShadow)

  async function tryFill(selectorList, value, label) {
    for (const s of selectorList) {
      try {
        console.log(`[login] waiting for ${label} selector: ${s}`)
        const loc = page.locator(s)
        await loc.waitFor({ state: 'visible', timeout: timeoutMs })
        await loc.fill(value, { timeout: timeoutMs })
        console.log(`[login] filled ${label} with selector: ${s}`)
        return true
      } catch (e) {
        console.warn(`[login] attempt failed for ${label} selector: ${s} -> ${e?.message || e}`)
      }
    }
    return false
  }

  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 30000) })
  }

  if (!user || !pass) {
    console.warn(`[login] Missing credentials for ${prodKey}. Expected envs: ${userEnvName}/${passEnvName}.`)
    return false
  }

  // Try to fill username
  const userOk = await tryFill(userCandidates, user, 'username')
  // Try to fill password
  const passOk = await tryFill(passCandidates, pass, 'password')

  if (!userOk || !passOk) {
    console.error('[login] Could not locate login fields. Check selectors or use css=... >>> input for shadow DOM.')
    return false
  }

  if (submitSelector) {
    try {
      const submitLoc = page.locator(submitSelector)
      await submitLoc.waitFor({ state: 'visible', timeout: timeoutMs })
      await submitLoc.click({ timeout: timeoutMs })
      console.log('[login] submit clicked')
    } catch (e) {
      console.warn(`[login] submit click failed: ${e?.message || e}`)
    }
  }

  try {
    await page.waitForLoadState(waitFor || 'networkidle', { timeout: timeoutMs })
  } catch (e) {
    console.warn(`[login] waitForLoadState(${waitFor || 'networkidle'}) timed out: ${e?.message || e}`)
  }

  if (persistSession) {
    const storagePath = (loginCfg.storageStatePath || path.join(authDir, safeName(prodKey) + '_storageState.json'))
    await context.storageState({ path: storagePath })
    console.log(`[session] Storage state persisted for ${prodKey} -> ${storagePath}`)
  }
  console.log(`[login] OK for ${prodKey}`)
  return true
}