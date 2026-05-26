#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  getOnboardingAppfolioConfig,
  launchOnboardingPersistentContext,
  loginToAppFolio,
  waitForAppFolioShell,
} from './lib/onboardingAppfolioAuth.js'
import { loadOnboardingEnv, ONBOARDING_APPFOLIO_PROFILE } from './lib/onboardingEnv.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadOnboardingEnv(rootDir)

function log(step, detail = '') {
  const suffix = detail ? ` - ${detail}` : ''
  console.log(`[${new Date().toISOString()}] ${step}${suffix}`)
}

async function main() {
  const config = {
    ...getOnboardingAppfolioConfig(rootDir),
    headless: false,
  }
  if (!process.env.PLAYWRIGHT_USER_DATA_DIR) {
    config.rawUserDataDir = ONBOARDING_APPFOLIO_PROFILE
    config.userDataDir = ONBOARDING_APPFOLIO_PROFILE
  }

  fs.mkdirSync(config.userDataDir, { recursive: true })
  log('ONBOARDING_LOGIN_PROFILE', config.userDataDir)
  log('ONBOARDING_LOGIN_MODE', process.env.DISPLAY ? `DISPLAY=${process.env.DISPLAY}` : 'No DISPLAY detected; run with xvfb-run on VPS if needed.')

  let context
  try {
    context = await launchOnboardingPersistentContext(config, {
      rootDir,
      allowEmptyProfile: true,
      log,
    })
    const page = context.pages()[0] || await context.newPage()
    page.setDefaultTimeout(Number(process.env.PLAYWRIGHT_TIMEOUT_MS || '15000'))

    await loginToAppFolio(page, config, {
      username: process.env.APPFOLIO_USERNAME || '',
      password: process.env.APPFOLIO_PASSWORD || '',
      interactive: true,
      log,
    })
    await waitForAppFolioShell(page, config.appfolioLoginTimeoutMs, 'onboarding login bootstrap', { diagnose: true, log })
    log('LOGIN_SUCCESS', 'Onboarding AppFolio profile is authenticated and ready.')
  } finally {
    await context?.close().catch(() => {})
  }
}

main().catch((error) => {
  log('ERROR', error.message)
  process.exit(1)
})
