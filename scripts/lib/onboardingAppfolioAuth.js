import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { chromium } from 'playwright'
import { ONBOARDING_APPFOLIO_PROFILE, parseBoolean, resolvePathFromRoot } from './onboardingEnv.js'

export function getOnboardingAppfolioConfig(rootDir, env = process.env) {
  return {
    appfolioUrl: env.APPFOLIO_URL || 'https://thetgpm.appfolio.com',
    appfolioMfaCode: env.APPFOLIO_MFA_CODE || '',
    appfolioLoginTimeoutMs: Number(env.APPFOLIO_LOGIN_TIMEOUT_MS || '60000'),
    appfolioActionTimeoutMs: Number(env.APPFOLIO_ACTION_TIMEOUT_MS || '30000'),
    appfolioManualLoginTimeoutMs: Number(env.APPFOLIO_MANUAL_LOGIN_TIMEOUT_MS || '600000'),
    headless: parseBoolean(env.HEADLESS, false),
    slowMo: Number(env.PLAYWRIGHT_SLOW_MO || '80'),
    rawUserDataDir: env.PLAYWRIGHT_USER_DATA_DIR || ONBOARDING_APPFOLIO_PROFILE,
    userDataDir: resolvePathFromRoot(rootDir, env.PLAYWRIGHT_USER_DATA_DIR, ONBOARDING_APPFOLIO_PROFILE),
  }
}

export function assertOnboardingProfileReady(config, { rootDir = process.cwd(), allowEmpty = false, log = defaultLog } = {}) {
  log('PLAYWRIGHT_PROFILE_ENV', `raw="${config.rawUserDataDir}" resolved="${config.userDataDir}" cwd="${process.cwd()}" rootDir="${rootDir}"`)
  if (!fs.existsSync(config.userDataDir)) {
    throw new Error(
      `PLAYWRIGHT_USER_DATA_DIR does not exist: ${config.userDataDir}. ` +
        'Run npm run appfolio:onboarding-login first to bootstrap the onboarding AppFolio profile.',
    )
  }

  const defaultProfileDir = path.join(config.userDataDir, 'Default')
  const hasDefaultProfile = fs.existsSync(defaultProfileDir)
  const singletonLock = path.join(config.userDataDir, 'SingletonLock')
  log(
    'PLAYWRIGHT_PROFILE_CHECK',
    `exists=true defaultProfile=${hasDefaultProfile} singletonLock=${fs.existsSync(singletonLock)}`,
  )
  if (!hasDefaultProfile && !allowEmpty) {
    throw new Error(
      `PLAYWRIGHT_USER_DATA_DIR exists but does not look like a Chromium profile: ${config.userDataDir}. ` +
        'Expected a Default/ directory. Run npm run appfolio:onboarding-login to create the profile.',
    )
  }
}

export async function launchOnboardingPersistentContext(config, { rootDir = process.cwd(), allowEmptyProfile = false, log = defaultLog } = {}) {
  assertOnboardingProfileReady(config, { rootDir, allowEmpty: allowEmptyProfile, log })
  return chromium.launchPersistentContext(config.userDataDir, {
    headless: config.headless,
    slowMo: config.slowMo,
    viewport: { width: 1440, height: 1000 },
  })
}

export async function loginToAppFolio(page, config, {
  username = '',
  password = '',
  interactive = Boolean(process.stdin.isTTY),
  log = defaultLog,
} = {}) {
  log('LOGIN_STEP', `Opening AppFolio ${config.appfolioUrl}`)
  await page.goto(config.appfolioUrl, { waitUntil: 'domcontentloaded', timeout: config.appfolioLoginTimeoutMs })
  if (await waitForAppFolioShell(page, 5000, 'session reuse', { diagnose: false, log }).catch(() => false)) {
    log('SESSION_REUSED', 'Existing AppFolio authenticated browser session is valid')
    return
  }

  log('LOGIN_REQUIRED', 'Existing AppFolio session is missing or expired')
  if (!username || !password) {
    if (await clickAutofilledLoginIfPresent(page, config, log)) {
      await waitForLoginOutcome(page, config, { interactive, log })
      log('LOGIN_SUCCESS', 'AppFolio authenticated session saved in persistent browser profile')
      return
    }
    throw new Error('AppFolio login is required, but APPFOLIO_USERNAME or APPFOLIO_PASSWORD is missing.')
  }

  await fillLoginField(page, ['email', 'username', 'login'], page.locator('input[type="email"], input[name*="email" i], input[name*="username" i]').first(), username)
  await fillLoginField(page, ['password'], page.locator('input[type="password"]').first(), password)
  log('LOGIN_CREDENTIALS_FILLED', 'Filled AppFolio username and password from onboarding environment')
  await clickLoginButton(page, config)
  await waitForLoginOutcome(page, config, { interactive, log })
  log('LOGIN_SUCCESS', 'AppFolio authenticated session saved in persistent browser profile')
}

export async function waitForAppFolioShell(page, timeout, context, { diagnose = false, log = defaultLog } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const shellReady = await page.evaluate(() => {
      const bodyText = document.body?.innerText || ''
      const url = window.location.href
      const title = document.title || ''
      const appUrlReady = /thetgpm\.appfolio\.com/.test(url) && !/account\.appfolio\.com/.test(url)
      const appTitleReady = /Dashboard|Properties|Tasks|AppFolio Property Manager/i.test(title)
      const navReady = /\bProperties\b/i.test(bodyText) || /\bTasks\b/i.test(bodyText) || /\bDashboard\b/i.test(bodyText)
      return appUrlReady && (appTitleReady || navReady)
    }).catch(() => false)

    if (shellReady) {
      log('APPFOLIO_SHELL_READY', context)
      return true
    }
    await page.waitForTimeout(500)
  }

  if (diagnose) {
    const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')
    log('APPFOLIO_SHELL_NOT_READY', `${context} url=${page.url()} body=${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`)
  }
  throw new Error(`Could not confirm AppFolio dashboard/navigation for ${context}`)
}

async function clickAutofilledLoginIfPresent(page, config, log) {
  const hasLoginForm = await page.locator('input[type="password"]').first().isVisible({ timeout: 2000 }).catch(() => false)
  if (!hasLoginForm) return false

  const submit = await visibleFirst(
    page.locator('input[type="submit"], button').filter({ hasText: /log in|login|sign in/i }).or(page.locator('input[type="submit"][name="login"], #kc-login')),
    'autofilled AppFolio login button',
    Math.min(config.appfolioActionTimeoutMs, 5000),
  ).catch(() => null)
  if (!submit) return false

  log('LOGIN_AUTOFILLED_SUBMIT', 'Clicking AppFolio login button using browser-saved credentials')
  await submit.click({ force: true })
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(1000)
  return true
}

async function waitForLoginOutcome(page, config, { interactive, log }) {
  const deadline = Date.now() + config.appfolioLoginTimeoutMs
  while (Date.now() < deadline) {
    if (await waitForAppFolioShell(page, 1000, 'login outcome', { diagnose: false, log }).catch(() => false)) return
    const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')
    if (/verification|2-step|two-step|mfa|code/i.test(bodyText)) {
      log('MFA_REQUIRED', 'AppFolio requested MFA or verification')
      if (!config.appfolioMfaCode) {
        await waitForManualLogin(page, config, 'AppFolio requested MFA. Complete verification in the visible browser/noVNC session.', { interactive, log })
        return
      }
      await fillLoginField(page, ['code', 'verification'], page.locator('input').last(), config.appfolioMfaCode)
      await clickLoginButton(page, config)
    }
    if (/invalid|incorrect|could not log|try again|account locked/i.test(bodyText)) {
      throw new Error(`AppFolio login page reported an error. Page text starts with: ${bodyText.slice(0, 300)}`)
    }
    await page.waitForTimeout(1000)
  }
  throw new Error(`AppFolio login did not complete within ${config.appfolioLoginTimeoutMs}ms`)
}

async function waitForManualLogin(page, config, reason, { interactive, log }) {
  log('MANUAL_LOGIN_REQUIRED', reason)
  if (!interactive) {
    log('MANUAL_LOGIN_WAITING', `Waiting up to ${config.appfolioManualLoginTimeoutMs}ms for manual completion in the visible browser/noVNC session`)
    await waitForAppFolioShell(page, config.appfolioManualLoginTimeoutMs, 'manual login/MFA completion', { diagnose: true, log })
    log('LOGIN_SUCCESS', 'Manual AppFolio login/MFA completed and the persistent profile is ready')
    return
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    while (true) {
      const answer = (await rl.question('Complete AppFolio login/MFA in the headed browser, then type DONE and press Enter: ')).trim()
      if (!/^done$/i.test(answer)) {
        throw new Error('Manual AppFolio login was not confirmed by the user.')
      }
      if (await waitForAppFolioShell(page, Math.min(config.appfolioLoginTimeoutMs, 15000), 'manual login confirmation', { diagnose: false, log }).catch(() => false)) {
        log('LOGIN_SUCCESS', 'Manual AppFolio login completed and the persistent profile is ready')
        return
      }
      log('MANUAL_LOGIN_STILL_PENDING', 'AppFolio dashboard or navigation is not visible yet.')
    }
  } finally {
    rl.close()
  }
}

async function fillLoginField(page, labels, fallbackLocator, value) {
  for (const label of labels) {
    const field = await page.getByLabel(new RegExp(label, 'i')).first().isVisible().then(() => page.getByLabel(new RegExp(label, 'i')).first()).catch(() => null)
    if (field) {
      await replaceInputValue(field, value)
      return
    }
  }
  const fallback = await visibleFirst(fallbackLocator, labels[0], 3000)
  await replaceInputValue(fallback, value)
}

async function clickLoginButton(page, config) {
  const button = await visibleFirst(
    page.locator('button, a, [role="button"], input[type="submit"]').filter({ hasText: /verify|submit|continue|sign in|log in|login/i }).or(page.locator('input[type="submit"][name="login"], #kc-login')),
    'AppFolio login/MFA button',
    config.appfolioActionTimeoutMs,
  )
  await button.click({ force: true })
}

async function visibleFirst(locator, description, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const count = await locator.count().catch(() => 0)
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index)
      if (await candidate.isVisible().catch(() => false)) return candidate
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Could not find visible ${description}`)
}

async function replaceInputValue(input, value) {
  await input.click({ force: true })
  await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {})
  await input.press('Backspace').catch(() => {})
  await input.pressSequentially(String(value), { delay: 12 })
}

function defaultLog(step, detail = '') {
  const suffix = detail ? ` - ${detail}` : ''
  console.log(`[${new Date().toISOString()}] ${step}${suffix}`)
}
