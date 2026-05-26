import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

export const ONBOARDING_APPFOLIO_PROFILE = '/root/appfolio-property-onboarding/.playwright-appfolio-profile'

export function loadOnboardingEnv(rootDir) {
  for (const envFile of ['.env.local', '.env']) {
    const envPath = path.join(rootDir, envFile)
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false, quiet: true })
    }
  }
}

export function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase())
}

export function resolvePathFromRoot(rootDir, value, fallback) {
  const chosen = value || fallback
  return path.isAbsolute(chosen) ? path.resolve(chosen) : path.resolve(rootDir, chosen)
}
