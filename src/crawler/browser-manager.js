import { chromium } from 'playwright'
import path from 'path'

export async function createBrowserContext(cfg, userDataDir) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: cfg.runtime?.headless !== false,
    ignoreHTTPSErrors: !!cfg.runtime?.ignoreHTTPSErrors,
  })
  
  const page = context.pages()[0] || await context.newPage()
  
  if (cfg.runtime?.navigationTimeoutMs) {
    page.setDefaultNavigationTimeout(cfg.runtime.navigationTimeoutMs)
  }
  
  return { context, page }
}

export async function closeBrowserContext(context) {
  await context.close()
}