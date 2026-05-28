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
    getMyMfaUrl: env.GETMYMFA_URL || 'https://client.get.mymfa.io/',
    getMyMfaUsername: env.GETMYMFA_USERNAME || '',
    getMyMfaPassword: env.GETMYMFA_PASSWORD || '',
    getMyMfaPhoneNumber: env.GETMYMFA_PHONE_NUMBER || '+16266104061',
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
  if (await handleExistingMfaScreen(page, config, { interactive, log })) {
    log('LOGIN_SUCCESS', 'AppFolio authenticated session saved in persistent browser profile')
    return
  }

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

async function handleExistingMfaScreen(page, config, { interactive, log }) {
  const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')
  if (await isMfaChoiceScreen(page, bodyText)) {
    await requestSmsVerificationCode(page, config, log)
    await submitMfaCodeOrWait(page, config, { interactive, log })
    return true
  }
  if (isMfaCodeEntryScreen(bodyText)) {
    log('MFA_REQUIRED', 'AppFolio requested MFA code entry')
    await submitMfaCodeOrWait(page, config, { interactive, log })
    return true
  }
  return false
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
    if (await isMfaChoiceScreen(page, bodyText)) {
      await requestSmsVerificationCode(page, config, log)
      await submitMfaCodeOrWait(page, config, { interactive, log })
      return
    }
    if (/verification|2-step|two-step|mfa|code/i.test(bodyText)) {
      log('MFA_REQUIRED', 'AppFolio requested MFA or verification')
      await submitMfaCodeOrWait(page, config, { interactive, log })
      return
    }
    if (/invalid|incorrect|could not log|try again|account locked/i.test(bodyText)) {
      throw new Error(`AppFolio login page reported an error. Page text starts with: ${bodyText.slice(0, 300)}`)
    }
    await page.waitForTimeout(1000)
  }
  throw new Error(`AppFolio login did not complete within ${config.appfolioLoginTimeoutMs}ms`)
}

async function isMfaChoiceScreen(page, bodyText) {
  const hasMfaChoiceControls = await page.evaluate(() => {
    const sms = document.querySelector('#method-sms, input[name="twoFactorMethod"][value*="sms" i]')
    const send = document.querySelector('#send_verification_code, input[name="send_verification_code"]')
    return Boolean(sms && send)
  }).catch(() => false)
  if (hasMfaChoiceControls) return true

  const hasVerificationPrompt = /2-step verification|two-step verification|verification method/i.test(bodyText)
  const hasSmsOption = /receive code via sms|sms/i.test(bodyText)
  const hasAlternateDeliveryOption = /receive code via phone call|phone call|call/i.test(bodyText)
  const hasSendButtonText = /send verification code/i.test(bodyText)
  return hasVerificationPrompt && hasSmsOption && (hasAlternateDeliveryOption || hasSendButtonText)
}

function isMfaCodeEntryScreen(bodyText) {
  return /2-step verification|two-step verification|verification code|enter.*code|mfa/i.test(bodyText) &&
    !/receive code via sms|receive code via phone call|send verification code/i.test(bodyText)
}

async function requestSmsVerificationCode(page, config, log) {
  log('MFA_REQUIRED', 'AppFolio requested 2-Step Verification method selection')
  await selectSmsVerificationMethod(page, config, log)
  await clickSendVerificationCode(page, config)
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(1000)
  log('MFA_CODE_REQUESTED', 'Clicked Send Verification Code after selecting SMS')
}

async function clickSendVerificationCode(page, config) {
  const directButton = page.locator('#send_verification_code, input[name="send_verification_code"]').first()
  if (await directButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await directButton.click({ force: true })
    return
  }

  const clicked = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]'))
    const sendControl = controls.find((control) => /send verification code/i.test(`${control.innerText || ''} ${control.textContent || ''} ${control.value || ''} ${control.id || ''} ${control.name || ''}`))
    if (!sendControl) return false
    sendControl.click()
    return true
  }).catch(() => false)
  if (clicked) return

  const sendButton = await visibleFirst(
    page.locator('button, a, [role="button"], input[type="submit"], input[type="button"]').filter({ hasText: /send verification code/i }).or(page.locator('input[value*="Send Verification Code" i]')),
    'Send Verification Code button',
    config.appfolioActionTimeoutMs,
  )
  await sendButton.click({ force: true })
}

async function selectSmsVerificationMethod(page, config, log) {
  const directSmsRadio = page.locator('#method-sms, input[name="twoFactorMethod"][value*="sms" i]').first()
  if (await directSmsRadio.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (!(await directSmsRadio.isChecked().catch(() => false))) await directSmsRadio.check({ force: true })
    log('MFA_SMS_SELECTED', 'Selected SMS verification radio')
    return
  }

  const smsRadio = page.locator('input[type="radio"]').filter({ hasText: /sms/i }).first()
  if (await smsRadio.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (!(await smsRadio.isChecked().catch(() => false))) await smsRadio.check({ force: true })
    log('MFA_SMS_SELECTED', 'Selected SMS verification radio')
    return
  }

  const selected = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label'))
    const smsLabel = labels.find((label) => /receive code via sms|sms/i.test(label.innerText || label.textContent || ''))
    if (smsLabel) {
      const forId = smsLabel.getAttribute('for')
      const radio = forId ? document.getElementById(forId) : smsLabel.querySelector('input[type="radio"]')
      if (radio && radio instanceof HTMLInputElement) {
        radio.checked = true
        radio.dispatchEvent(new Event('input', { bubbles: true }))
        radio.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }
      smsLabel.click()
      return true
    }

    const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
    const smsRadio = radios.find((radio) => /sms/i.test(`${radio.value || ''} ${radio.id || ''} ${radio.name || ''}`))
    if (smsRadio && smsRadio instanceof HTMLInputElement) {
      smsRadio.checked = true
      smsRadio.dispatchEvent(new Event('input', { bubbles: true }))
      smsRadio.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    return false
  })

  if (!selected) {
    const smsText = await visibleFirst(page.getByText(/receive code via sms|sms/i), 'SMS verification option', config.appfolioActionTimeoutMs)
    await smsText.click({ force: true })
  }
  log('MFA_SMS_SELECTED', 'Selected SMS verification option')
}

async function submitMfaCodeOrWait(page, config, { interactive, log }) {
  const code = await getMfaCodeFromDashboard(page, config, log)
  if (!code) {
    await waitForManualLogin(page, config, 'AppFolio requested MFA. Complete verification in the visible browser/noVNC session.', { interactive, log })
    return
  }

  await fillMfaCode(page, config, code)
  log('MFA_CODE_TYPED', 'Entered verification code into AppFolio')
  await clickLoginButton(page, config)
  log('MFA_SUBMIT_CLICKED', 'Clicked AppFolio MFA submit button')
  await waitForAppFolioShell(page, config.appfolioLoginTimeoutMs, 'MFA login completion', { diagnose: true, log })
}

async function fillMfaCode(page, config, code) {
  const codeInput = page.locator('input[type="text"], input[type="tel"], input[type="number"], input:not([type])').last()
  await fillLoginField(page, ['code', 'verification'], codeInput, code)
}

async function getMfaCodeFromDashboard(appfolioPage, config, log) {
  if (!config.getMyMfaUsername || !config.getMyMfaPassword || !config.getMyMfaPhoneNumber) {
    log('GETMYMFA_DASHBOARD_NOT_CONFIGURED', 'GETMYMFA_USERNAME, GETMYMFA_PASSWORD, or GETMYMFA_PHONE_NUMBER is missing')
    return ''
  }

  const dashboardPage = await appfolioPage.context().newPage()
  try {
    log('GETMYMFA_DASHBOARD_LOGIN_STARTED', `Opening ${config.getMyMfaUrl}`)
    await dashboardPage.goto(config.getMyMfaUrl, { waitUntil: 'domcontentloaded', timeout: config.appfolioActionTimeoutMs })
    await loginToGetMyMfaDashboard(dashboardPage, config, log)
    log('GETMYMFA_DASHBOARD_LOGIN_SUCCESS', 'GetMyMFA dashboard loaded')
    await clickAccessLastMfaCode(dashboardPage, config)
    log('GETMYMFA_ACCESS_LAST_CODE_CLICKED', `Clicked Access last MFA code for ${config.getMyMfaPhoneNumber}`)
    const code = await readDashboardMfaCode(dashboardPage, config)
    log('GETMYMFA_DASHBOARD_CODE_FOUND', 'Read 6-digit MFA code from GetMyMFA dashboard')
    await appfolioPage.bringToFront()
    return code
  } catch (error) {
    const bodyText = await dashboardPage.locator('body').innerText({ timeout: 1000 }).catch(() => '')
    log('GETMYMFA_DASHBOARD_FAILED', `${error.message} url=${dashboardPage.url()} body=${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`)
    await appfolioPage.bringToFront().catch(() => {})
    return ''
  } finally {
    await dashboardPage.close().catch(() => {})
  }
}

async function loginToGetMyMfaDashboard(page, config, log) {
  if (await isGetMyMfaDashboardVisible(page).catch(() => false)) {
    log('GETMYMFA_SESSION_REUSED', 'Existing GetMyMFA dashboard session is valid')
    return
  }

  await waitForGetMyMfaLoginOrDashboard(page, config, log)
  if (await isGetMyMfaDashboardVisible(page).catch(() => false)) {
    log('GETMYMFA_SESSION_REUSED', 'Existing GetMyMFA dashboard session is valid')
    return
  }

  await fillLoginField(
    page,
    ['email', 'username', 'login'],
    getGetMyMfaUsernameInput(page),
    config.getMyMfaUsername,
    config.appfolioActionTimeoutMs,
  )
  await fillLoginField(page, ['password'], page.locator('input[type="password"]').first(), config.getMyMfaPassword, config.appfolioActionTimeoutMs)
  await clickGetMyMfaSubmit(page, config)
  await waitForGetMyMfaDashboard(page, config)
}

async function waitForGetMyMfaLoginOrDashboard(page, config, log) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: Math.min(config.appfolioActionTimeoutMs, 10000) }).catch(() => {})

  const deadline = Date.now() + config.appfolioActionTimeoutMs
  while (Date.now() < deadline) {
    if (await isGetMyMfaDashboardVisible(page).catch(() => false)) return
    const hasLoginInputs = await getGetMyMfaUsernameInput(page).first().isVisible({ timeout: 500 }).catch(() => false) &&
      await page.locator('input[type="password"]').first().isVisible({ timeout: 500 }).catch(() => false)
    if (hasLoginInputs) return
    await page.waitForTimeout(500)
  }

  const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')
  log('GETMYMFA_LOGIN_FORM_NOT_READY', `url=${page.url()} body=${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`)
}

function getGetMyMfaUsernameInput(page) {
  return page.locator([
    'input[type="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[autocomplete="username"]',
    'input[type="text"]',
    'input:not([type])',
  ].join(', ')).first()
}

async function isGetMyMfaDashboardVisible(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')
  if (/my phone numbers|access last mfa code/i.test(bodyText)) return true
  return page.locator('text=/Access last MFA code/i').first().isVisible({ timeout: 500 }).catch(() => false)
}

async function waitForGetMyMfaDashboard(page, config) {
  const deadline = Date.now() + config.appfolioLoginTimeoutMs
  while (Date.now() < deadline) {
    if (await isGetMyMfaDashboardVisible(page)) return
    await page.waitForTimeout(500)
  }
  throw new Error('GetMyMFA dashboard login did not complete before timeout.')
}

async function clickAccessLastMfaCode(page, config) {
  await waitForPhoneNumber(page, config)
  const attempts = [
    () => clickAccessTileByLocator(page),
    () => clickAccessTileByCoordinates(page),
    () => clickAccessTileByDom(page, config),
  ]

  for (const attempt of attempts) {
    await attempt().catch(() => false)
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await page.waitForTimeout(1200)
    if (await isGetMyMfaCodePageVisible(page)) return
  }

  throw new Error('Clicked Access last MFA code but GetMyMFA code page did not open.')
}

async function clickAccessTileByLocator(page) {
  const accessTile = await visibleFirst(
    page.getByText(/access last mfa code/i).or(page.locator('button, a, [role="button"], input[type="button"], input[type="submit"], div, span').filter({ hasText: /access last mfa code/i })),
    'Access last MFA code action',
    5000,
  )
  await accessTile.click({ force: true })
  return true
}

async function clickAccessTileByCoordinates(page) {
  const box = await page.getByText(/access last mfa code/i).first().boundingBox()
  if (!box) return false
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(300)
  await page.mouse.click(box.x + box.width / 2, Math.max(0, box.y - 36))
  return true
}

async function clickAccessTileByDom(page, config) {
  return page.evaluate((phoneNumber) => {
    const normalize = (value) => String(value || '').replace(/\D/g, '')
    const target = normalize(phoneNumber)
    const elements = Array.from(document.querySelectorAll('body *'))
    const phoneElement = elements.find((element) => normalize(element.textContent).includes(target))
    const accessTextElement = elements.find((element) => /^access last mfa code$/i.test((element.textContent || '').trim()))
    const clickElement = (element) => {
      if (!element) return false
      const clickable = element.closest('button, a, [role="button"], input[type="button"], input[type="submit"], [onclick]') || element
      clickable.scrollIntoView({ block: 'center', inline: 'center' })
      clickable.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }))
      clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      clickable.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }))
      clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      clickable.click()
      return true
    }

    if (phoneElement && accessTextElement) {
      const phoneTop = phoneElement.getBoundingClientRect().top
      const accessTop = accessTextElement.getBoundingClientRect().top
      if (Math.abs(accessTop - phoneTop) < 300 && clickElement(accessTextElement)) return true
    }

    let container = phoneElement || accessTextElement
    for (let depth = 0; depth < 12 && container; depth += 1) {
      const controls = Array.from(container.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], [onclick], div, span'))
      const accessControl = controls.find((control) => /access last mfa code/i.test(control.innerText || control.textContent || control.value || ''))
      if (clickElement(accessControl)) return true
      if (/access last mfa code/i.test(container.innerText || container.textContent || '') && clickElement(container)) return true
      container = container.parentElement
    }

    return clickElement(accessTextElement)
  }, config.getMyMfaPhoneNumber)
}

async function isGetMyMfaCodePageVisible(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')
  return /last mfa code for/i.test(bodyText) || Boolean(extractSixDigitMfaCode(bodyText))
}

async function waitForPhoneNumber(page, config) {
  const target = normalizeDigits(config.getMyMfaPhoneNumber)
  const deadline = Date.now() + config.appfolioActionTimeoutMs
  while (Date.now() < deadline) {
    const found = await page.evaluate((digits) => document.body?.innerText?.replace(/\D/g, '').includes(digits), target).catch(() => false)
    if (found) return
    await page.waitForTimeout(500)
  }
  throw new Error(`GetMyMFA phone number was not visible on dashboard: ${config.getMyMfaPhoneNumber}`)
}

async function readDashboardMfaCode(page, config) {
  const deadline = Date.now() + config.appfolioActionTimeoutMs
  while (Date.now() < deadline) {
    const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')
    const code = extractSixDigitMfaCode(bodyText)
    if (code) return code
    await page.waitForTimeout(500)
  }
  throw new Error('Could not find a 6-digit MFA code on GetMyMFA dashboard.')
}

function extractSixDigitMfaCode(text) {
  const value = String(text || '')
  const contiguousCandidates = value.match(/\b\d{6}\b/g) || []
  if (contiguousCandidates.length) return contiguousCandidates[contiguousCandidates.length - 1]

  const spacedCandidates = value.match(/(?:\b\d\s+){5}\d\b/g) || []
  if (spacedCandidates.length) return normalizeDigits(spacedCandidates[spacedCandidates.length - 1])

  return ''
}

async function clickGetMyMfaSubmit(page, config) {
  const button = await visibleFirst(
    page.locator('button, a, [role="button"], input[type="submit"]').filter({ hasText: /log in|login|sign in|continue|submit/i }).or(page.locator('input[type="submit"]')),
    'GetMyMFA login button',
    config.appfolioActionTimeoutMs,
  )
  await button.click({ force: true })
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(1000)
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '')
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

async function fillLoginField(page, labels, fallbackLocator, value, timeout = 3000) {
  for (const label of labels) {
    const field = page.getByLabel(new RegExp(label, 'i')).first()
    if (await field.isVisible({ timeout: 1000 }).catch(() => false)) {
      await replaceInputValue(field, value)
      return
    }
  }
  const fallback = await visibleFirst(fallbackLocator, labels[0], timeout)
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
