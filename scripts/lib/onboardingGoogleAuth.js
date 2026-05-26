import fs from 'node:fs'
import { google } from 'googleapis'
import { resolvePathFromRoot } from './onboardingEnv.js'

export function getOnboardingGoogleConfig(rootDir, env = process.env) {
  return {
    googleOAuthClientPath: env.GOOGLE_OAUTH_CLIENT_JSON ? resolvePathFromRoot(rootDir, env.GOOGLE_OAUTH_CLIENT_JSON, '') : '',
    googleOAuthTokenPath: resolvePathFromRoot(rootDir, env.GOOGLE_OAUTH_TOKEN_PATH, '.appfolio-google-token.json'),
  }
}

export async function getOnboardingGoogleAuth(config, { log = defaultLog } = {}) {
  if (!config.googleOAuthClientPath) {
    throw new Error('GOOGLE_OAUTH_CLIENT_JSON is required for onboarding Google auth.')
  }
  if (!fs.existsSync(config.googleOAuthClientPath)) {
    throw new Error(`Google OAuth client JSON not found: ${config.googleOAuthClientPath}`)
  }
  if (!fs.existsSync(config.googleOAuthTokenPath)) {
    throw new Error(`Google OAuth token not found: ${config.googleOAuthTokenPath}. Create a dedicated onboarding token before running production jobs.`)
  }

  const clientConfig = JSON.parse(fs.readFileSync(config.googleOAuthClientPath, 'utf8'))
  const installed = clientConfig.installed || clientConfig.web
  if (!installed?.client_id || !installed?.client_secret) {
    throw new Error('Google OAuth client JSON must contain installed.client_id/client_secret or web.client_id/client_secret.')
  }

  const token = JSON.parse(fs.readFileSync(config.googleOAuthTokenPath, 'utf8'))
  if (!token.refresh_token && !token.access_token) {
    throw new Error(`Google OAuth token does not contain refresh_token or access_token: ${config.googleOAuthTokenPath}`)
  }

  const oauthClient = new google.auth.OAuth2(installed.client_id, installed.client_secret)
  oauthClient.setCredentials(token)
  log('Google OAuth', `Using saved onboarding token at ${config.googleOAuthTokenPath}`)
  return oauthClient
}

export async function getOnboardingSheetsClient(config, options = {}) {
  const auth = await getOnboardingGoogleAuth(config, options)
  return google.sheets({ version: 'v4', auth })
}

function defaultLog(step, detail = '') {
  const suffix = detail ? ` - ${detail}` : ''
  console.log(`[${new Date().toISOString()}] ${step}${suffix}`)
}
