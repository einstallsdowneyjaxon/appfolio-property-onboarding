#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  getOnboardingAppfolioConfig,
  launchOnboardingPersistentContext,
  loginToAppFolio,
} from './lib/onboardingAppfolioAuth.js'
import {
  getOnboardingGoogleConfig,
  getOnboardingSheetsClient,
} from './lib/onboardingGoogleAuth.js'
import { loadOnboardingEnv, parseBoolean } from './lib/onboardingEnv.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
loadOnboardingEnv(rootDir)

const APPFOLIO_AUTH_CONFIG = getOnboardingAppfolioConfig(rootDir)
const GOOGLE_AUTH_CONFIG = getOnboardingGoogleConfig(rootDir)

const DEFAULT_ADDENDUMS = [
  'ADDENDA 1-5',
  'CARPET AND CLEANING ADDENDUM',
  'Crime Free Addendum',
  'DISCLOSURE OF INFORMATION ON LEAD-BASED PAINT',
  'DRUG FREE /CRIME FREE ADDENDUM',
  'Early Termination of Lease Agreement',
  'Electronic Notices Addendum',
  'LAWN MAINTENANCE ADDENDUM',
  'MOLD ADDENDUM',
  'No Party/Noise Addendum',
  'PEST CONTROL ADDENDUM',
  'RESIDENT HANDBOOK',
  'Texting Addendum',
]

const CONFIG = {
  appfolioUrl: process.env.APPFOLIO_URL || 'https://thetgpm.appfolio.com',
  spreadsheetId: process.env.PROPERTY_ONBOARDING_SPREADSHEET_ID || '1VNjBAp_19s7ShBFHmF6u-w2crGnywCZogy4CgQcrHHU',
  sheetName: process.env.PROPERTY_ONBOARDING_TAB || 'Property_Onboarding',
  googleOAuthClientPath: GOOGLE_AUTH_CONFIG.googleOAuthClientPath,
  googleOAuthTokenPath: GOOGLE_AUTH_CONFIG.googleOAuthTokenPath,
  rawUserDataDir: APPFOLIO_AUTH_CONFIG.rawUserDataDir,
  userDataDir: APPFOLIO_AUTH_CONFIG.userDataDir,
  headless: APPFOLIO_AUTH_CONFIG.headless,
  slowMo: APPFOLIO_AUTH_CONFIG.slowMo,
  appfolioMfaCode: process.env.APPFOLIO_MFA_CODE || '',
  appfolioLoginTimeoutMs: Number(process.env.APPFOLIO_LOGIN_TIMEOUT_MS || '60000'),
  appfolioActionTimeoutMs: Number(process.env.APPFOLIO_ACTION_TIMEOUT_MS || '30000'),
  diagnosticMode: parseBoolean(process.env.APPFOLIO_DIAGNOSTIC_MODE, true),
  dryRun: parseBoolean(process.env.APPFOLIO_PROPERTY_DRY_RUN, false),
  requireFinalSaveConfirmation: parseBoolean(process.env.APPFOLIO_REQUIRE_FINAL_SAVE_CONFIRMATION, true),
  pauseOnError: parseBoolean(process.env.APPFOLIO_TRAINING_PAUSE_ON_ERROR, true),
  startSection: process.env.START_SECTION || '',
  skipLeaseSettingsForTraining: parseBoolean(process.env.APPFOLIO_SKIP_LEASE_SETTINGS_FOR_TRAINING, false),
}

const failedFields = []
const STATUS_COLUMNS = {
  appfolioStatus: 'AppFolio Status',
  appfolioPropertyId: 'AppFolio Property ID',
  botLastRun: 'Bot Last Run',
  errorMessage: 'Error Message',
}

const COLUMN_ALIASES = {
  address1: ['Address 1', 'address1', 'address_1'],
  address2: ['Address 2', 'Unit', 'Unit Number', 'unit_number', 'address2', 'address_2'],
  city: ['City'],
  state: ['State'],
  zip: ['Zip', 'ZIP', 'Postal Code'],
  county: ['County'],
  sor: ['SOR', 'sor'],
  yearBuilt: ['Year Built', 'yearBuilt', 'year_built'],
  agreementStartDate: ['Agreement Start Date', 'Management Start Date', 'agreementStartDate'],
  subdivision: ['Subdivision', 'Subdivision Name'],
  tenantPlacement: ['Tenant Placement', 'tenantPlacement', 'tenant_placement'],
  bed: ['Bed', 'Beds', 'Bedrooms'],
  bath: ['Bath', 'Baths', 'Bathrooms'],
  sqft: ['SqFt', 'Sq Ft', 'Square Feet'],
  amenities: ['Amenities'],
  coolingType: ['Cooling Type'],
  heatingType: ['Heating Type'],
  garageType: ['Garage Type'],
  propertyType: ['Property Type', 'Listing Type'],
  ownerName: ['Owner Name', 'Owner'],
  managementFee: ['Management Fee'],
  leaseFee: ['Lease Fee', 'Leasing Fee', 'Lease Fee Amount', 'Leasing Fee Amount'],
  renewalFee: ['Renewal Fee'],
  maintenanceLimit: ['Maintenance Limit'],
}

class SoftStepError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SoftStepError'
  }
}

const STABLE_FIELD_SELECTORS = new Map([
  ['Address 1', '#property_address_attributes_address1'],
  ['Address 2', '#property_address_attributes_address2'],
  ['City', '#property_address_attributes_city'],
  ['Zip', '#property_address_attributes_postal_code'],
  ['County', '#property_address_attributes_county'],
  ['First Name', '#property_site_manager_attributes_first_name'],
  ['Last Name', '#property_site_manager_attributes_last_name'],
  ['Year Built', '#property_year_built'],
  ['Management Start Date', '#property_management_start_date'],
])

const STABLE_DROPDOWN_SELECTORS = new Map([
  ['Property Type', '#property_property_type'],
  ['State', '#property_address_attributes_state'],
])

const DROPDOWN_CONTROL_SELECTOR =
  '.Select-control, .select2-container, .select2-choice, [role="combobox"], input[placeholder*="Start typing" i], input[placeholder*="search" i], select'

function log(step, detail = '') {
  const suffix = detail ? ` - ${detail}` : ''
  console.log(`[${new Date().toISOString()}] ${step}${suffix}`)
}

function logState(state, detail = '') {
  log(state, detail)
}

function fail(message) {
  throw new Error(message)
}

function parsePayloadJson(value, source) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch (error) {
    fail(`Could not parse ${source} as JSON: ${error.message}`)
  }
}

function findRowNumberInPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  return (
    payload.rowNumber ??
    payload.row_number ??
    payload.row ??
    payload.sheetRow ??
    payload.sheet_row ??
    payload.propertyOnboardingRow ??
    payload.property_onboarding_row ??
    payload.body?.rowNumber ??
    payload.body?.row_number ??
    payload.json?.rowNumber ??
    payload.json?.row_number ??
    null
  )
}

function normalizeHeader(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function pick(row, aliases) {
  for (const alias of aliases) {
    if (row[alias] != null && row[alias] !== '') return row[alias]
    const normalizedAlias = normalizeHeader(alias)
    const matchingKey = Object.keys(row).find((key) => normalizeHeader(key) === normalizedAlias)
    if (matchingKey && row[matchingKey] != null && row[matchingKey] !== '') return row[matchingKey]
  }
  return ''
}

function normalizeMoneyNumber(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const number = Number(raw.replace(/[$,%\s,]/g, ''))
  return Number.isFinite(number) ? String(number) : raw.replace(/[$,%]/g, '').trim()
}

function feeKind(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const numericValue = Number(raw.replace(/[$,%\s,]/g, ''))
  if (raw.includes('%')) return 'Percent'
  if (Number.isFinite(numericValue) && numericValue > 0 && numericValue < 1) return 'Percent'
  return 'Flat'
}

function normalizeFeeNumber(value) {
  const kind = feeKind(value)
  const normalized = normalizeMoneyNumber(value)
  const numericValue = Number(normalized)
  if (kind === 'Percent' && Number.isFinite(numericValue) && numericValue > 0 && numericValue < 1) {
    return formatNumberForInput(numericValue * 100)
  }
  return normalized
}

function formatNumberForInput(value) {
  return Number(value.toFixed(6)).toString()
}

function normalizeDigits(value) {
  return String(value ?? '').replace(/\D/g, '')
}

function isYes(value) {
  return /^(yes|y|true|1|checked)$/i.test(String(value ?? '').trim())
}

function googleSerialToDate(serial) {
  const numericSerial = Number(serial)
  const wholeDays = Math.trunc(numericSerial)
  const date = new Date(1899, 11, 30)
  date.setDate(date.getDate() + wholeDays)
  return date
}

function formatDateValue(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const date = /^\d+(\.\d+)?$/.test(raw) ? googleSerialToDate(raw) : new Date(raw)
  if (!date || Number.isNaN(date.valueOf())) return raw
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${mm}/${dd}/${date.getFullYear()}`
}

function parseSor(value) {
  const raw = String(value ?? '').trim()
  const letter = raw.match(/\b([A-E])\b/i)?.[1]?.toUpperCase() || ''
  return {
    raw,
    firstName: 'SOR',
    lastName: letter,
  }
}

function buildAdditionalLeaseInformation(row) {
  return [
    ['Cooling Type', row.coolingType],
    ['Heating Type', row.heatingType],
    ['Garage Type', row.garageType],
  ]
    .filter(([, value]) => String(value ?? '').trim())
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n')
}

function normalizeListingType(value) {
  const raw = String(value ?? '').trim()
  const normalized = raw.replace(/[^a-z0-9]+/gi, '').toLowerCase()
  if (normalized === 'singlefamily' || normalized === 'singlefamilyhome') return 'House'
  if (normalized === 'townhome' || normalized === 'townhouse') return 'Townhouse'
  return raw
}

function normalizeRow(rawRow) {
  const source = rawRow?.json && typeof rawRow.json === 'object' ? rawRow.json : rawRow?.body && typeof rawRow.body === 'object' ? rawRow.body : rawRow
  const byKey = {}
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    byKey[key] = pick(source || {}, aliases)
  }

  const sor = parseSor(byKey.sor)
  return {
    ...byKey,
    address1: String(byKey.address1 ?? '').trim(),
    address2: String(byKey.address2 ?? '').trim(),
    city: String(byKey.city ?? '').trim(),
    state: String(byKey.state ?? '').trim().toUpperCase(),
    zip: String(byKey.zip ?? '').trim(),
    county: String(byKey.county ?? '').trim(),
    sor,
    yearBuilt: String(byKey.yearBuilt ?? '').trim(),
    agreementStartDate: formatDateValue(byKey.agreementStartDate),
    subdivision: String(byKey.subdivision ?? '').trim(),
    tenantPlacement: isYes(byKey.tenantPlacement),
    bed: String(byKey.bed ?? '').trim(),
    bath: String(byKey.bath ?? '').trim(),
    sqft: String(byKey.sqft ?? '').trim(),
    amenities: String(byKey.amenities ?? '').trim(),
    additionalLeaseInformation: buildAdditionalLeaseInformation(byKey),
    propertyType: String(byKey.propertyType ?? '').trim(),
    listingType: normalizeListingType(byKey.propertyType),
    ownerName: String(byKey.ownerName ?? '').trim(),
    managementFee: {
      kind: feeKind(byKey.managementFee),
      value: normalizeFeeNumber(byKey.managementFee),
    },
    leaseFee: {
      kind: feeKind(byKey.leaseFee),
      value: normalizeFeeNumber(byKey.leaseFee),
    },
    renewalFee: normalizeMoneyNumber(byKey.renewalFee),
    maintenanceLimit: normalizeMoneyNumber(byKey.maintenanceLimit),
  }
}

async function resolvePayloadRow() {
  const sources = [
    ['PROPERTY_ONBOARDING_PAYLOAD', process.env.PROPERTY_ONBOARDING_PAYLOAD],
    ['N8N_PAYLOAD', process.env.N8N_PAYLOAD],
    ['N8N_INPUT', process.env.N8N_INPUT],
    ['N8N_JSON', process.env.N8N_JSON],
  ]

  for (const [source, value] of sources) {
    const payload = parsePayloadJson(value, source)
    if (!payload) continue
    const directRow = payload.rowData || payload.rowJson || payload.property || payload.json || payload.body || payload
    const hasSheetColumns = Object.values(COLUMN_ALIASES).some((aliases) => aliases.some((alias) => pick(directRow, [alias]) !== ''))
    if (hasSheetColumns) {
      log('Loaded n8n row payload', source)
      const normalizedPayloadRow = normalizeRow(directRow)
      const rowNumber = Number(findRowNumberInPayload(payload))
      if (Number.isInteger(rowNumber) && rowNumber >= 2) {
        log('PAYLOAD_ROW_NUMBER_FOUND', `row=${rowNumber}; reading full Property_Onboarding row`)
        return readPropertyOnboardingRow(rowNumber)
      }
      if (rowNeedsSheetFeeLookup(normalizedPayloadRow)) {
        const sheetRow = await findPropertyOnboardingRowByAddress(normalizedPayloadRow)
        if (sheetRow) {
          log('PAYLOAD_ROW_MATCHED_SHEET', `row=${sheetRow.sheetRowNumber} address="${sheetRow.address1}"`)
          return sheetRow
        }
        log('PAYLOAD_ROW_SHEET_MATCH_NOT_FOUND', `address="${normalizedPayloadRow.address1}" zip="${normalizedPayloadRow.zip}"`)
      }
      return normalizedPayloadRow
    }

    const rowNumber = Number(findRowNumberInPayload(payload))
    if (Number.isInteger(rowNumber) && rowNumber >= 2) {
      return readPropertyOnboardingRow(rowNumber)
    }
  }

  const envRowNumber = Number(process.env.PROPERTY_ONBOARDING_ROW || '')
  if (Number.isInteger(envRowNumber) && envRowNumber >= 2) {
    return readPropertyOnboardingRow(envRowNumber)
  }

  fail('No Property_Onboarding row JSON or valid row number was provided.')
}

async function resolveRowsToProcess() {
  const directRow = await resolvePayloadRow().catch((error) => {
    if (/No Property_Onboarding row JSON or valid row number/.test(error.message)) return null
    throw error
  })
  if (directRow) return [directRow]
  return readIncompletePropertyOnboardingRows()
}

function escapeSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`
}

function colToA1(index) {
  let column = index + 1
  let label = ''
  while (column > 0) {
    const remainder = (column - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    column = Math.floor((column - remainder) / 26)
  }
  return label
}

function rowToObject(header, row) {
  const rowObject = {}
  header.forEach((heading, index) => {
    rowObject[String(heading).trim()] = row[index] ?? ''
  })
  return rowObject
}

function statusAllowsProcessing(value) {
  const status = normalizeHeader(value)
  return status === '' || status === 'not started'
}

function statusIsCompleted(value) {
  return normalizeHeader(value) === 'completed'
}

async function getSheetsClient() {
  return getOnboardingSheetsClient(GOOGLE_AUTH_CONFIG, { log })
}

async function readPropertyOnboardingRow(rowNumber) {
  log('Reading Google Sheet', `${CONFIG.sheetName} row ${rowNumber}`)
  const sheets = await getSheetsClient()
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `${escapeSheetName(CONFIG.sheetName)}!A1:AZ${rowNumber}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  })

  const values = response.data.values || []
  const header = values[0] || []
  const row = values[rowNumber - 1] || []
  if (!row.length) fail(`No data found at row ${rowNumber} in tab ${CONFIG.sheetName}`)

  return attachRowMetadata(normalizeRow(rowToObject(header, row)), rowNumber)
}

async function readIncompletePropertyOnboardingRows() {
  log('Reading Google Sheet', `${CONFIG.sheetName} incomplete rows`)
  const sheets = await getSheetsClient()
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `${escapeSheetName(CONFIG.sheetName)}!A:AZ`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  })

  const values = response.data.values || []
  const header = values[0] || []
  const statusIndex = findColumnIndex(header, STATUS_COLUMNS.appfolioStatus)
  if (statusIndex < 0) fail(`Missing required "${STATUS_COLUMNS.appfolioStatus}" column in ${CONFIG.sheetName}`)

  const rows = []
  values.slice(1).forEach((row, offset) => {
    const rowNumber = offset + 2
    if (!row.some((cell) => String(cell ?? '').trim())) return
    const status = row[statusIndex] ?? ''
    const rowObject = rowToObject(header, row)
    const normalized = attachRowMetadata(normalizeRow(rowObject), rowNumber)
    const address = normalized.address1 || rowObject['Address 1'] || '(missing address)'
    if (statusIsCompleted(status)) {
      log('ROW_SKIPPED_COMPLETED', `row=${rowNumber} address="${address}"`)
      return
    }
    if (!statusAllowsProcessing(status)) {
      log('ROW_SKIPPED_STATUS', `row=${rowNumber} status="${status}" address="${address}"`)
      return
    }
    rows.push(normalized)
  })

  log('INCOMPLETE_ROWS_FOUND', String(rows.length))
  return rows
}

function rowNeedsSheetFeeLookup(row) {
  return !row?.leaseFee?.kind || !row?.leaseFee?.value || !row?.renewalFee || !row?.managementFee?.kind || !row?.managementFee?.value
}

async function findPropertyOnboardingRowByAddress(targetRow) {
  if (!targetRow?.address1) return null
  log('Reading Google Sheet', `${CONFIG.sheetName} lookup for "${targetRow.address1}"`)
  const sheets = await getSheetsClient()
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `${escapeSheetName(CONFIG.sheetName)}!A:AZ`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  })

  const values = response.data.values || []
  const header = values[0] || []
  const matches = []
  values.slice(1).forEach((row, offset) => {
    if (!row.some((cell) => String(cell ?? '').trim())) return
    const rowNumber = offset + 2
    const normalized = attachRowMetadata(normalizeRow(rowToObject(header, row)), rowNumber)
    if (rowsReferToSameProperty(normalized, targetRow)) matches.push(normalized)
  })

  if (matches.length > 1) {
    log('PAYLOAD_ROW_MULTIPLE_SHEET_MATCHES', matches.map((row) => `row=${row.sheetRowNumber}`).join(', '))
  }
  return matches[0] || null
}

function rowsReferToSameProperty(sheetRow, payloadRow) {
  const sheetAddress = normalizeLookupText(sheetRow.address1)
  const payloadAddress = normalizeLookupText(payloadRow.address1)
  if (!sheetAddress || sheetAddress !== payloadAddress) return false

  const sheetZip = normalizeDigits(sheetRow.zip)
  const payloadZip = normalizeDigits(payloadRow.zip)
  if (sheetZip && payloadZip && sheetZip !== payloadZip) return false

  const sheetCity = normalizeLookupText(sheetRow.city)
  const payloadCity = normalizeLookupText(payloadRow.city)
  if (sheetCity && payloadCity && sheetCity !== payloadCity) return false

  return true
}

function normalizeLookupText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function attachRowMetadata(row, rowNumber) {
  return {
    ...row,
    sheetRowNumber: rowNumber,
  }
}

function findColumnIndex(header, columnName) {
  const wanted = normalizeHeader(columnName)
  return header.findIndex((heading) => normalizeHeader(heading) === wanted)
}

async function updateOnboardingRowStatus(row, status, { propertyId = '', errorMessage = '' } = {}) {
  if (!row.sheetRowNumber) return
  const sheets = await getSheetsClient()
  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `${escapeSheetName(CONFIG.sheetName)}!1:1`,
  })
  const header = headerResponse.data.values?.[0] || []
  const updates = {
    [STATUS_COLUMNS.appfolioStatus]: status,
    [STATUS_COLUMNS.botLastRun]: new Date().toISOString(),
    [STATUS_COLUMNS.errorMessage]: errorMessage,
  }
  if (propertyId) updates[STATUS_COLUMNS.appfolioPropertyId] = propertyId

  const data = []
  for (const [columnName, value] of Object.entries(updates)) {
    const index = findColumnIndex(header, columnName)
    if (index < 0) {
      log('SHEET_STATUS_COLUMN_MISSING', columnName)
      continue
    }
    data.push({
      range: `${escapeSheetName(CONFIG.sheetName)}!${colToA1(index)}${row.sheetRowNumber}`,
      values: [[value]],
    })
  }
  if (!data.length) return

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: CONFIG.spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  })
  log('ROW_STATUS_UPDATED', `row=${row.sheetRowNumber} status=${status}${propertyId ? ` propertyId=${propertyId}` : ''}`)
}

function diagnosticLabel(value) {
  return String(value || 'diagnostic').replace(/[^a-z0-9_-]/gi, '-').toLowerCase()
}

async function capturePageDiagnostics(page, label, detail = '') {
  if (!page || page.isClosed?.()) return ''
  const safeLabel = diagnosticLabel(label)
  const screenshotPath = path.resolve(rootDir, `appfolio-property-${safeLabel}-${Date.now()}.png`)
  const url = page.url()
  const title = await page.title().catch(() => '')
  const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')
  const summary = await page
    .evaluate(() => {
      function clean(value) {
        return String(value || '').replace(/\s+/g, ' ').trim()
      }
      function isVisible(element) {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const inputs = Array.from(document.querySelectorAll('input, textarea, select, [role="combobox"], [contenteditable="true"]'))
        .filter(isVisible)
        .slice(0, 24)
        .map((element) => ({
          tag: element.tagName,
          type: element.getAttribute('type') || '',
          role: element.getAttribute('role') || '',
          name: element.getAttribute('name') || '',
          id: element.id || '',
          placeholder: element.getAttribute('placeholder') || '',
          aria: element.getAttribute('aria-label') || '',
          text: clean(element.textContent).slice(0, 80),
        }))
      const actions = Array.from(document.querySelectorAll('a, button, [role="button"]'))
        .filter(isVisible)
        .slice(0, 30)
        .map((element) => clean(element.textContent || element.getAttribute('aria-label')).slice(0, 90))
        .filter(Boolean)
      return { inputs, actions }
    })
    .catch(() => ({ inputs: [], actions: [] }))

  if (CONFIG.diagnosticMode) await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
  log('DIAGNOSTIC', `${label}${detail ? ` - ${detail}` : ''}`)
  log('DIAGNOSTIC_URL', url)
  log('DIAGNOSTIC_TITLE', title || '(no title)')
  log('DIAGNOSTIC_BODY', bodyText.slice(0, 900).replace(/\s+/g, ' '))
  log('DIAGNOSTIC_INPUTS', JSON.stringify(summary.inputs))
  log('DIAGNOSTIC_ACTIONS', JSON.stringify(summary.actions))
  if (CONFIG.diagnosticMode) log('DIAGNOSTIC_SCREENSHOT', screenshotPath)
  return screenshotPath
}

async function runSection(page, name, action) {
  log('SECTION_STARTED', name)
  try {
    await action()
    log('SECTION_VERIFIED', name)
    log('SECTION_COMPLETED', name)
    return true
  } catch (error) {
    failedFields.push({ section: name, error: error.message })
    log('SECTION_FAILED', `${name}: ${error.message}`)
    await capturePageDiagnostics(page, `property-${name}`, error.message)
    throw error
  }
}

async function retryAction(description, action, retries = 2) {
  let lastError
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await action(attempt)
    } catch (error) {
      lastError = error
      log('RETRY', `${description} attempt=${attempt} error=${error.message}`)
      await new Promise((resolve) => setTimeout(resolve, 450 * attempt))
    }
  }
  throw lastError
}

async function visibleFirst(locator, description, timeout = CONFIG.appfolioActionTimeoutMs) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    const count = await locator.count().catch((error) => {
      lastError = error
      return 0
    })
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index)
      if (await candidate.isVisible().catch(() => false)) return candidate
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new SoftStepError(`Could not find visible ${description}${lastError ? `: ${lastError.message}` : ''}`)
}

async function clickByRoleOrText(page, textOrRegex, description) {
  const candidate =
    typeof textOrRegex === 'string'
      ? page.getByRole('button', { name: textOrRegex }).or(page.getByText(textOrRegex))
      : page.locator('button, a, [role="button"], input[type="submit"]').filter({ hasText: textOrRegex })
  const target = await visibleFirst(candidate, description, 5000)
  await target.click({ force: true })
}

async function clickVisibleText(page, textOrRegex, description) {
  const candidate = typeof textOrRegex === 'string' ? page.getByText(textOrRegex) : page.getByText(textOrRegex)
  const target = await visibleFirst(candidate, description, 5000)
  await target.click({ force: true })
  await page.waitForTimeout(400)
}

async function navigateToNewProperty(page) {
  await retryAction('navigate to Properties', async () => {
    await clickByRoleOrText(page, /properties/i, 'Properties navigation')
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await page.waitForTimeout(1000)
  })

  const tasks = page.locator('button, a, [role="button"]').filter({ hasText: /^Tasks$/i })
  if (await tasks.first().isVisible().catch(() => false)) {
    await tasks.first().click({ force: true })
    await page.waitForTimeout(500)
  }

  await retryAction('click New Property', async () => {
    await clickByRoleOrText(page, /new property/i, 'New Property')
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await page.waitForTimeout(1200)
  })
}

async function saveSection(page, sectionName = '') {
  const save = await visibleFirst(
    page.locator('button, input[type="submit"], a').filter({ hasText: /^Save$/i }),
    `${sectionName} Save`,
    5000,
  )
  await save.click({ force: true })
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(1000)
  await assertNoValidationErrors(page, sectionName)
}

async function assertNoValidationErrors(page, contextLabel) {
  const errors = await page.evaluate(() => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    return Array.from(document.querySelectorAll('.error, .errors, .field_with_errors, .invalid-feedback, [role="alert"], .flash, .alert'))
      .filter(isVisible)
      .map((element) => clean(element.textContent))
      .filter((text) => text && !/^save$/i.test(text))
      .slice(0, 12)
  })

  const actionableErrors = errors.filter((text) => /required|invalid|error|can't|cannot|must|missing|select|blank|failed/i.test(text))
  if (actionableErrors.length) {
    await capturePageDiagnostics(page, `validation-${contextLabel}`, actionableErrors.join(' | '))
    throw new Error(`AppFolio validation errors after ${contextLabel}: ${actionableErrors.join(' | ')}`)
  }
}

async function askForFinalSaveConfirmation(page) {
  await capturePageDiagnostics(page, 'before-final-save', 'Waiting for user confirmation before final Save')
  logState('FINAL_SAVE_CONFIRMATION_REQUIRED', 'Type SAVE and press Enter to click the final AppFolio Save button.')
  if (!process.stdin.isTTY) {
    throw new Error('Final Save confirmation requires an interactive terminal.')
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question('Type SAVE to click the final AppFolio Save button, or anything else to stop: ')).trim()
    if (answer !== 'SAVE') {
      throw new Error('Final Save was not confirmed by the user.')
    }
  } finally {
    rl.close()
  }
}

async function pauseForTrainingError(message) {
  if (!CONFIG.pauseOnError || !process.stdin.isTTY) return
  logState('TRAINING_PAUSED', 'Browser is left open for inspection.')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    await rl.question(`Training paused after error: ${message}\nInspect the browser, then press Enter to close this run: `)
  } finally {
    rl.close()
  }
}

async function scrollToText(page, text) {
  await page.evaluate((targetText) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function normalize(value) {
      return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const wanted = normalize(targetText)
    const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, legend, .section-title, .card-header, body *'))
      .filter((node) => isVisible(node) && normalize(node.textContent) === wanted)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    candidates[0]?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, text).catch(async () => {
    await page.getByText(sectionTextRegex(text)).first().scrollIntoViewIfNeeded().catch(async () => {
      await page.evaluate((targetText) => {
        function clean(value) {
          return String(value || '').replace(/\s+/g, ' ').trim()
        }
        function normalize(value) {
          return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
        }
        function isVisible(element) {
          const rect = element.getBoundingClientRect()
          const style = window.getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        }
        const wanted = normalize(targetText)
        const element = Array.from(document.querySelectorAll('h1, h2, h3, h4, legend, .section-title, .card-header, body *'))
          .find((node) => isVisible(node) && normalize(node.textContent) === wanted)
        element?.scrollIntoView({ block: 'center' })
      }, text)
    })
  })
  await page.waitForTimeout(500)
}

async function scrollToSectionHeading(page, headings) {
  const headingList = Array.isArray(headings) ? headings : [headings]
  const result = await page.evaluate((targetHeadings) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function normalize(value) {
      return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }

    const wanted = targetHeadings.map((heading) => normalize(heading)).filter(Boolean)
    const selectors = [
      'h1',
      'h2',
      'h3',
      'h4',
      'legend',
      '.section-title',
      '.card-header',
      '.panel-title',
      '.panel-heading',
      '.form-section-title',
    ].join(',')
    const candidates = Array.from(document.querySelectorAll(selectors))
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) =>
        isVisible(element) &&
        text.length <= 80 &&
        wanted.some((heading) => normalize(text) === heading || normalize(text).includes(heading) || heading.includes(normalize(text))) &&
        rect.height < 120,
      )
      .sort((a, b) => Math.abs(a.rect.top - window.innerHeight * 0.3) - Math.abs(b.rect.top - window.innerHeight * 0.3))

    const match = candidates[0]
    if (!match) return { found: false, text: '' }
    match.element.scrollIntoView({ block: 'start', inline: 'nearest' })
    window.scrollBy(0, -90)
    return { found: true, text: match.text }
  }, headingList)

  if (!result.found) {
    for (const heading of headingList) {
      const locator = page.getByText(sectionTextRegex(heading)).first()
      if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
        await locator.scrollIntoViewIfNeeded()
        await page.waitForTimeout(500)
        log('SECTION_SCROLL', heading)
        return heading
      }
    }
    throw new SoftStepError(`Could not find section heading "${headingList.join('" or "')}"`)
  }

  await page.waitForTimeout(500)
  log('SECTION_SCROLL', result.text)
  return result.text
}

function sectionTextRegex(text) {
  const escaped = escapeRegex(text).replace(/\\&|and/gi, '(?:&|and)')
  return new RegExp(`^\\s*${escaped}\\s*$`, 'i')
}

async function fillNearestField(page, labelText, value, { sectionName = '', multiline = false } = {}) {
  if (value == null || value === '') return
  await retryAction(`fill ${labelText}`, async () => {
    if (sectionName) await scrollToText(page, sectionName)
    const stableSelector = STABLE_FIELD_SELECTORS.get(labelText)
    if (stableSelector) {
      const stableField = await visibleFirst(page.locator(stableSelector).first(), `${labelText} stable field`, 2500).catch(() => null)
      if (stableField) {
        await replaceInputValue(stableField, value)
        await stableField.press('Tab').catch(() => {})
        return
      }
    }
    const fieldIndex = await findFieldIndexByLabel(page, labelText, { sectionName, multiline })
    const selector = multiline ? 'textarea, input:not([type="hidden"])' : 'input:not([type="hidden"]), textarea'
    const field = page.locator(selector).nth(fieldIndex)
    await replaceInputValue(field, value)
    await field.press('Tab').catch(() => {})
  })
}

async function fillNearestFieldWithAliases(page, labels, value, options = {}) {
  let lastError
  for (const label of labels) {
    try {
      await fillNearestField(page, label, value, options)
      return
    } catch (error) {
      lastError = error
      log('FIELD_ALIAS_RETRY', `${label}: ${error.message}`)
    }
  }
  throw lastError
}

async function setGracePeriodAfter(page, value, { sectionName = 'Late Fee Policy Details' } = {}) {
  await retryAction('set Grace Period After', async () => {
    if (sectionName) await scrollToText(page, sectionName)
    const target = await page.evaluate((sectionName) => {
      function clean(value) {
        return String(value || '').replace(/\s+/g, ' ').trim()
      }
      function normalize(value) {
        return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
      }
      function isVisible(element) {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }

      const elements = Array.from(document.querySelectorAll('body *'))
      const sectionElement = elements.find((element) =>
        isVisible(element) && normalize(element.textContent).includes(normalize(sectionName)) && element.getBoundingClientRect().height < 140
      )
      const sectionY = sectionElement ? sectionElement.getBoundingClientRect().top + window.scrollY : 0
      const label = elements
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
        .filter(({ element, rect, text }) =>
          isVisible(element) &&
          normalize(text).startsWith('graceperiod') &&
          rect.top + window.scrollY >= sectionY &&
          rect.height < 120 &&
          text.length < 160,
        )
        .sort((a, b) => a.text.length - b.text.length || a.rect.top - b.rect.top)[0]
      if (!label) return null

      const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
        .map((radio) => ({ radio, rect: radio.getBoundingClientRect() }))
        .filter(({ radio, rect }) =>
          isVisible(radio) &&
          rect.top + window.scrollY >= sectionY &&
          rect.left > label.rect.right - 8 &&
          Math.abs((rect.top + rect.height / 2) - (label.rect.top + label.rect.height / 2)) < 90,
        )
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
      const radio = radios[0]?.radio
      if (!radio) return null

      const marker = `grace-after-${Date.now()}-${Math.random().toString(16).slice(2)}`
      radio.setAttribute('data-codex-grace-after-radio', marker)
      return marker
    }, sectionName)
    if (!target) throw new SoftStepError('Could not find Grace Period After radio')

    const radio = page.locator(`[data-codex-grace-after-radio="${target}"]`).first()
    if (!(await radio.isChecked())) await radio.click({ force: true })
    await page.waitForTimeout(300)

    const inputMarker = await page.evaluate((target) => {
      function isVisible(element) {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const radio = document.querySelector(`[data-codex-grace-after-radio="${target}"]`)
      if (!radio) return ''
      const radioRect = radio.getBoundingClientRect()
      const input = Array.from(document.querySelectorAll('input:not([type="hidden"])'))
        .map((field) => ({ field, rect: field.getBoundingClientRect() }))
        .filter(({ field, rect }) =>
          isVisible(field) &&
          !field.disabled &&
          rect.left > radioRect.right &&
          Math.abs((rect.top + rect.height / 2) - (radioRect.top + radioRect.height / 2)) < 70,
        )
        .sort((a, b) => a.rect.left - b.rect.left)[0]?.field
      if (!input) return ''
      const marker = `grace-after-input-${Date.now()}-${Math.random().toString(16).slice(2)}`
      input.setAttribute('data-codex-grace-after-input', marker)
      return marker
    }, target)
    if (!inputMarker) throw new SoftStepError('Could not find Grace Period After days input')

    const field = page.locator(`[data-codex-grace-after-input="${inputMarker}"]`).first()
    await replaceInputValue(field, value)
    await field.press('Tab').catch(() => {})
  })
}

async function verifyGracePeriodAfter(page, expectedValue, { sectionName = 'Late Fee Policy Details' } = {}) {
  if (sectionName) await scrollToText(page, sectionName)
  await setGracePeriodAfter(page, expectedValue, { sectionName })
  log('FIELD_VERIFIED', `${sectionName} Grace Period After => ${expectedValue}`)
}

async function findFieldIndexByLabel(page, labelText, { sectionName = '', multiline = false } = {}) {
  const index = await page.evaluate(({ labelText, sectionName, multiline }) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const fields = Array.from(document.querySelectorAll(multiline ? 'textarea, input:not([type="hidden"])' : 'input:not([type="hidden"]), textarea'))
    const elements = Array.from(document.querySelectorAll('body *'))
    const sectionElement = sectionName
      ? elements.find((element) => isVisible(element) && normalizeSectionText(element.textContent) === normalizeSectionText(sectionName))
      : null
    const sectionY = sectionElement ? sectionElement.getBoundingClientRect().top + window.scrollY : 0
    const labels = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) =>
        isVisible(element) &&
        (new RegExp(`^${escapeRegExp(labelText)}\\s*\\*?$`, 'i').test(text) || normalizeSectionText(text).startsWith(normalizeSectionText(labelText))) &&
        (!sectionName || rect.top + window.scrollY >= sectionY) &&
        rect.height < 160 &&
        text.length < 160,
      )
      .sort((a, b) => a.text.length - b.text.length || a.rect.top - b.rect.top)
    for (const label of labels) {
      const candidates = fields
        .map((field, index) => ({ field, index, rect: field.getBoundingClientRect() }))
        .filter(({ field, rect }) => {
          if (!isVisible(field)) return false
          const dy = Math.abs((rect.top + rect.height / 2) - (label.rect.top + label.rect.height / 2))
          const below = rect.top >= label.rect.top && rect.top - label.rect.bottom < 80
          const right = rect.left >= label.rect.left && dy < 55
          return below || right
        })
        .sort((a, b) => {
          const ady = Math.abs((a.rect.top + a.rect.height / 2) - (label.rect.top + label.rect.height / 2))
          const bdy = Math.abs((b.rect.top + b.rect.height / 2) - (label.rect.top + label.rect.height / 2))
          return ady - bdy || a.rect.left - b.rect.left
        })
      if (candidates[0]) return candidates[0].index
    }
    return -1

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    function normalizeSectionText(value) {
      return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
    }
  }, { labelText, sectionName, multiline })
  if (index < 0) throw new SoftStepError(`Could not find field near label "${labelText}"`)
  return index
}

async function replaceInputValue(input, value) {
  const expectedValue = String(value)
  await input.click({ force: true })
  await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {})
  await input.press('Backspace').catch(() => {})
  await input.pressSequentially(expectedValue, { delay: 12 })
  await verifyInputValue(input, expectedValue).catch(async () => {
    await input.evaluate((element, nextValue) => {
      element.value = nextValue
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      element.dispatchEvent(new Event('blur', { bubbles: true }))
    }, expectedValue)
    await verifyInputValue(input, expectedValue)
  })
}

async function verifyInputValue(input, expectedValue) {
  const actualValue = await input.inputValue().catch(async () => input.evaluate((element) => element.value || ''))
  if (!fieldValuesEquivalent(actualValue, expectedValue)) {
    throw new SoftStepError(`Field value did not stick. Expected "${expectedValue}", got "${actualValue}"`)
  }
}

function fieldValuesEquivalent(actualValue, expectedValue) {
  const actual = String(actualValue ?? '').trim()
  const expected = String(expectedValue ?? '').trim()
  if (actual === expected) return true
  const actualNumber = Number(actual.replace(/[$,%\s,]/g, ''))
  const expectedNumber = Number(expected.replace(/[$,%\s,]/g, ''))
  if (actual && expected && Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)) {
    return Math.abs(actualNumber - expectedNumber) < 0.0001
  }
  return false
}

async function verifySelectValue(page, selector, expectedValue, labelText) {
  const actualValue = await page.locator(selector).first().evaluate((select) => {
    const selected = select.options?.[select.selectedIndex]
    return selected?.textContent || select.value || ''
  })
  if (String(actualValue).trim().toLowerCase() !== String(expectedValue).trim().toLowerCase()) {
    throw new SoftStepError(`${labelText} did not stick. Expected "${expectedValue}", got "${actualValue}"`)
  }
}

async function verifyFieldNearLabel(page, labelText, expectedValue, { sectionName = '', multiline = false } = {}) {
  if (expectedValue == null || expectedValue === '') return
  const expected = String(expectedValue).trim()
  const stableSelector = STABLE_FIELD_SELECTORS.get(labelText)
  const stableField = stableSelector
    ? await visibleFirst(page.locator(stableSelector).first(), `${labelText} stable verification field`, 1500).catch(() => null)
    : null
  const field = stableField || page.locator(multiline ? 'textarea, input:not([type="hidden"])' : 'input:not([type="hidden"]), textarea').nth(await findFieldIndexByLabel(page, labelText, { sectionName, multiline }))
  await verifyInputValue(field, expected)
  log('FIELD_VERIFIED', `${sectionName ? `${sectionName} ` : ''}${labelText} => ${expected}`)
}

async function verifyFieldNearLabelWithAliases(page, labels, expectedValue, options = {}) {
  let lastError
  for (const label of labels) {
    try {
      await verifyFieldNearLabel(page, label, expectedValue, options)
      return
    } catch (error) {
      lastError = error
      log('FIELD_VERIFY_ALIAS_RETRY', `${label}: ${error.message}`)
    }
  }
  throw lastError
}

async function verifyDropdownNearLabel(page, labelText, expectedValue, { sectionName = '' } = {}) {
  if (expectedValue == null || expectedValue === '') return
  if (sectionName) await scrollToText(page, sectionName)
  const expected = String(expectedValue).trim()
  const stableSelector = STABLE_DROPDOWN_SELECTORS.get(labelText)
  const control = stableSelector
    ? page.locator(stableSelector).first()
    : await findDropdownNearLabel(page, labelText, sectionName)
  const actual = await control.evaluate((element) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    if (element.tagName.toLowerCase() === 'select') {
      const selected = element.options?.[element.selectedIndex]
      return clean(selected?.textContent || element.value || '')
    }
    return clean(element.textContent || element.getAttribute('aria-label') || element.value || '')
  })
  if (!normalizedIncludes(actual, expected)) {
    throw new SoftStepError(`${labelText} did not verify. Expected "${expected}", got "${actual}"`)
  }
  log('DROPDOWN_VERIFIED', `${sectionName ? `${sectionName} ` : ''}${labelText} => ${expected}`)
}

async function verifyCheckboxNearLabel(page, labelText, expectedChecked, { sectionName = '' } = {}) {
  if (sectionName) await scrollToText(page, sectionName)
  const index = await findCheckboxIndexNearLabel(page, labelText, sectionName)
  if (index < 0) throw new SoftStepError(`Could not find checkbox near "${labelText}" for verification`)
  const actual = await page.locator('input[type="checkbox"]').nth(index).isChecked()
  if (actual !== expectedChecked) {
    throw new SoftStepError(`${labelText} checkbox did not verify. Expected ${expectedChecked}, got ${actual}`)
  }
  log('CHECKBOX_VERIFIED', `${sectionName ? `${sectionName} ` : ''}${labelText} => ${expectedChecked ? 'checked' : 'unchecked'}`)
}

async function setRadioOptionNearLabel(page, groupLabel, optionText, { sectionName = '' } = {}) {
  await retryAction(`set radio ${groupLabel} ${optionText}`, async () => {
    if (sectionName) await scrollToText(page, sectionName)
    const index = await findRadioIndexNearOption(page, groupLabel, optionText, sectionName)
    if (index < 0) throw new SoftStepError(`Could not find radio option "${optionText}" near "${groupLabel}"`)
    const radio = page.locator('input[type="radio"]').nth(index)
    if (!(await radio.isChecked())) await radio.click({ force: true })
  })
}

async function verifyRadioOptionNearLabel(page, groupLabel, optionText, { sectionName = '' } = {}) {
  if (sectionName) await scrollToText(page, sectionName)
  const index = await findRadioIndexNearOption(page, groupLabel, optionText, sectionName)
  if (index < 0) throw new SoftStepError(`Could not find radio option "${optionText}" near "${groupLabel}" for verification`)
  const actual = await page.locator('input[type="radio"]').nth(index).isChecked()
  if (!actual) throw new SoftStepError(`${groupLabel} radio option "${optionText}" did not verify as selected`)
  log('RADIO_VERIFIED', `${sectionName ? `${sectionName} ` : ''}${groupLabel} => ${optionText}`)
}

async function findRadioIndexNearOption(page, groupLabel, optionText, sectionName = '') {
  return page.evaluate(({ groupLabel, optionText, sectionName }) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function normalize(value) {
      return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }

    const elements = Array.from(document.querySelectorAll('body *'))
    const sectionElement = sectionName
      ? elements.find((element) => isVisible(element) && normalize(element.textContent) === normalize(sectionName))
      : null
    const sectionY = sectionElement ? sectionElement.getBoundingClientRect().top + window.scrollY : 0
    const group = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) =>
        isVisible(element) &&
        normalize(text).includes(normalize(groupLabel)) &&
        (!sectionName || rect.top + window.scrollY >= sectionY) &&
        rect.height < 100,
      )
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!group) return -1

    const option = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) =>
        isVisible(element) &&
        normalize(text) === normalize(optionText) &&
        rect.top + window.scrollY >= sectionY &&
        Math.abs((rect.top + rect.height / 2) - (group.rect.top + group.rect.height / 2)) < 80 &&
        rect.left > group.rect.left,
      )
      .sort((a, b) => a.rect.left - b.rect.left)[0]
    if (!option) return -1

    const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
    return radios
      .map((radio, index) => ({ radio, index, rect: radio.getBoundingClientRect() }))
      .filter(({ radio, rect }) =>
        isVisible(radio) &&
        rect.top + window.scrollY >= sectionY &&
        Math.abs((rect.top + rect.height / 2) - (option.rect.top + option.rect.height / 2)) < 50 &&
        rect.left <= option.rect.left + 12,
      )
      .sort((a, b) => Math.abs(a.rect.right - option.rect.left) - Math.abs(b.rect.right - option.rect.left))[0]?.index ?? -1
  }, { groupLabel, optionText, sectionName })
}

async function findCheckboxIndexNearLabel(page, labelText, sectionName = '') {
  return page.evaluate(({ labelText, sectionName }) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    function normalizeSectionText(value) {
      return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
    }
    const elements = Array.from(document.querySelectorAll('body *'))
    const sectionElement = sectionName
      ? elements.find((element) => isVisible(element) && normalizeSectionText(element.textContent) === normalizeSectionText(sectionName))
      : null
    const sectionY = sectionElement ? sectionElement.getBoundingClientRect().top + window.scrollY : 0
    const label = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ rect, text }) =>
        normalizeSectionText(text).includes(normalizeSectionText(labelText)) &&
        (!sectionName || rect.top + window.scrollY >= sectionY),
      )
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!label) return -1
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
    return boxes
      .map((box, index) => ({ box, index, rect: box.getBoundingClientRect() }))
      .filter(({ box, rect }) => isVisible(box) && Math.abs((rect.top + rect.height / 2) - (label.rect.top + label.rect.height / 2)) < 110)
      .sort((a, b) => Math.abs(a.rect.left - label.rect.left) - Math.abs(b.rect.left - label.rect.left))[0]?.index ?? -1
  }, { labelText, sectionName })
}

function normalizedIncludes(actual, expected) {
  const normalize = (value) => String(value || '').replace(/[^a-z0-9]+/gi, '').toLowerCase()
  const actualNormalized = normalize(actual)
  const expectedNormalized = normalize(expected)
  return actualNormalized === expectedNormalized || actualNormalized.includes(expectedNormalized) || expectedNormalized.includes(actualNormalized)
}

async function verifyAddressBlock(page, row) {
  await verifyDropdownNearLabel(page, 'Property Type', 'Single-Family')
  await verifyFieldNearLabel(page, 'Address 1', row.address1)
  await verifyFieldNearLabel(page, 'Address 2', row.address2)
  await verifyFieldNearLabel(page, 'City', row.city)
  await verifySelectValue(page, '#property_address_attributes_state', row.state, 'State')
  await verifyFieldNearLabel(page, 'Zip', row.zip)
  await verifyFieldNearLabel(page, 'County', row.county)
}

async function verifyPropertyDetails(page, row) {
  await verifyAddressBlock(page, row)
  await verifySiteManager(page, row)
  await verifyFieldNearLabel(page, 'Year Built', row.yearBuilt)
  await verifyFieldNearLabel(page, 'Management Start Date', row.agreementStartDate)
}

async function verifySiteManager(page, row) {
  await verifyFieldNearLabel(page, 'First Name', row.sor.firstName)
  await verifyFieldNearLabel(page, 'Last Name', row.sor.lastName)
}

async function fillAndVerifyAddressBlock(page, row) {
  let lastError
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await fillNearestField(page, 'Address 1', row.address1)
      await fillNearestField(page, 'Address 2', row.address2)
      await fillNearestField(page, 'City', row.city)
      await fillNearestField(page, 'Zip', row.zip)
      await fillNearestField(page, 'County', row.county)
      await selectNearestDropdown(page, 'State', row.state, { searchText: row.state })
      await page.waitForTimeout(700)
      await verifyAddressBlock(page, row)
      return
    } catch (error) {
      lastError = error
      if (attempt >= 2) break
      log('ADDRESS_BLOCK_RETRY', error.message)
      await page.waitForTimeout(1500)
    }
  }
  throw lastError
}

async function waitForPropertyDetailsFieldsReady(page) {
  await page.waitForFunction(() => {
    const selectors = [
      '#property_property_type',
      '#property_address_attributes_address1',
      '#property_address_attributes_city',
      '#property_address_attributes_state',
      '#property_address_attributes_postal_code',
      '#property_address_attributes_county',
    ]
    return selectors.every((selector) => {
      const element = document.querySelector(selector)
      if (!element) return false
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !element.disabled
    })
  }, { timeout: 10000 })
  await page.waitForTimeout(900)
}

async function selectNearestDropdown(page, labelText, optionText, { sectionName = '', searchText = optionText } = {}) {
  if (!optionText) return
  await retryAction(`select ${labelText}`, async () => {
    if (sectionName) await scrollToText(page, sectionName)
    const stableSelector = STABLE_DROPDOWN_SELECTORS.get(labelText)
    if (stableSelector) {
      const stableControl = await visibleFirst(page.locator(stableSelector).first(), `${labelText} stable dropdown`, 2500).catch(() => null)
      if (stableControl) {
        await selectDropdownControl(page, stableControl, labelText, optionText, searchText)
        return
      }
    }
    const control = await findDropdownNearLabel(page, labelText, sectionName)
    await selectDropdownControl(page, control, labelText, optionText, searchText)
  })
}

async function selectAddendaTemplateInSubsection(page, subsectionName, addendum) {
  await retryAction(`select ${subsectionName} addendum ${addendum}`, async () => {
    await scrollToText(page, subsectionName)
    await page.keyboard.press('Escape').catch(() => {})
    const control = await findAddendaDropdownInSubsection(page, subsectionName)
    await clickAddendaInputBelowLastChip(page, control, `${subsectionName} Addenda Template(s)`)
    await selectActiveSelect2Option(page, `${subsectionName} Addenda Template(s)`, addendum, addendum)
    await verifyAddendumSelected(page, subsectionName, addendum)
  })
}

async function findAddendaDropdownInSubsection(page, subsectionName) {
  const marker = await page.evaluate((subsectionName) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const elements = Array.from(document.querySelectorAll('body *'))
    const previous = document.querySelectorAll('[data-codex-addenda-control]')
    previous.forEach((element) => element.removeAttribute('data-codex-addenda-control'))

    const subsection = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) => isVisible(element) && text.includes(subsectionName) && rect.height < 120)
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!subsection) return -1

    const startY = subsection.rect.top + window.scrollY
    const nextSubsection = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) =>
        isVisible(element) &&
        rect.top + window.scrollY > startY + 10 &&
        /Default .* Templates/i.test(text) &&
        rect.height < 120,
      )
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    const endY = nextSubsection ? nextSubsection.rect.top + window.scrollY : startY + 900

    const addendaLabel = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) =>
        isVisible(element) &&
        /Addenda Template/i.test(text) &&
        rect.top + window.scrollY >= startY &&
        rect.top + window.scrollY < endY &&
        rect.height < 90,
      )
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!addendaLabel) return -1

    const labelCenterY = addendaLabel.rect.top + addendaLabel.rect.height / 2
    const controls = Array.from(document.querySelectorAll('.select2-container-multi, .select2-container, .select2-choices, .Select-control, [role="combobox"], select'))
    const candidates = controls
      .map((control) => ({ control, rect: control.getBoundingClientRect(), text: clean(control.textContent) }))
      .filter(({ control, rect }) =>
        isVisible(control) &&
        rect.top + window.scrollY >= startY &&
        rect.top + window.scrollY < endY &&
        rect.left > addendaLabel.rect.left &&
        rect.bottom >= labelCenterY &&
        !/^\s*Lease Template\b/i.test(clean(control.closest('tr, .form-group, .control-group, .field, li, .row')?.textContent || '')) &&
        Math.abs((rect.top + rect.height / 2) - labelCenterY) < 170,
      )
      .sort((a, b) => {
        const aHasChoices = a.control.matches('.select2-choices, .select2-container-multi') || Boolean(a.control.querySelector('.select2-choices, .select2-search-choice, .select2-selection__choice'))
        const bHasChoices = b.control.matches('.select2-choices, .select2-container-multi') || Boolean(b.control.querySelector('.select2-choices, .select2-search-choice, .select2-selection__choice'))
        if (aHasChoices !== bHasChoices) return aHasChoices ? -1 : 1
        const achips = a.control.querySelectorAll('.select2-search-choice, .select2-selection__choice, .Select-value').length
        const bchips = b.control.querySelectorAll('.select2-search-choice, .select2-selection__choice, .Select-value').length
        if (achips !== bchips) return bchips - achips
        const ady = Math.abs((a.rect.top + a.rect.height / 2) - labelCenterY)
        const bdy = Math.abs((b.rect.top + b.rect.height / 2) - labelCenterY)
        return ady - bdy || b.rect.height - a.rect.height
      })

    const winner = candidates[0]?.control
    if (!winner) return ''
    const marker = `addenda-${Date.now()}-${Math.random().toString(16).slice(2)}`
    winner.setAttribute('data-codex-addenda-control', marker)
    return marker
  }, subsectionName)

  if (!marker) throw new SoftStepError(`Could not find Addenda Template(s) dropdown in ${subsectionName}`)
  return page.locator(`[data-codex-addenda-control="${marker}"]`).first()
}

async function clickAddendaInputBelowLastChip(page, control, description) {
  await control.scrollIntoViewIfNeeded()
  await page.waitForTimeout(350)
  const target = await control.evaluate((element) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest' })
    function visibleRect(node) {
      const rect = node.getBoundingClientRect()
      const style = window.getComputedStyle(node)
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return null
      return rect
    }

    const rect = visibleRect(element)
    if (!rect) return null
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return null
    const chips = Array.from(element.querySelectorAll('.select2-search-choice, .select2-selection__choice, .Select-value'))
      .map((chip) => visibleRect(chip))
      .filter(Boolean)
      .sort((a, b) => a.top - b.top || a.left - b.left)
    const lastChip = chips[chips.length - 1]
    const x = Math.min(rect.right - 24, Math.max(rect.left + 28, lastChip ? lastChip.left + 28 : rect.left + 28))
    const preferredY = lastChip ? lastChip.bottom + 12 : rect.top + Math.min(32, rect.height / 2)
    const y = Math.min(rect.bottom - 16, Math.max(rect.top + 16, preferredY))
    return { x, y, chipCount: chips.length }
  })

  if (!target) throw new SoftStepError(`Could not calculate click point for ${description}`)
  await page.mouse.click(target.x, target.y)
  log('ADDENDA_CLICK_TARGET', `${description} chips=${target.chipCount} x=${Math.round(target.x)} y=${Math.round(target.y)}`)
}

async function selectActiveSelect2Option(page, description, optionText, searchText = optionText) {
  const searchInput = await visibleFirst(
    page.locator('.select2-drop-active input, .select2-search input, input.select2-input').last(),
    `${description} Select2 search`,
    3000,
  ).catch(() => null)

  if (searchInput) {
    await searchInput.fill(String(searchText)).catch(async () => {
      await searchInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {})
      await searchInput.pressSequentially(String(searchText), { delay: 10 })
    })
  } else {
    log('SELECT2_KEYBOARD_SEARCH', `${description} => ${searchText}`)
    await page.keyboard.type(String(searchText), { delay: 10 })
    await page.waitForTimeout(500)
  }

  const optionRegex = new RegExp(`^\\s*${escapeRegex(optionText)}\\s*$`, 'i')
  const looseOptionRegex = new RegExp(escapeRegex(optionText), 'i')
  const option =
    await visibleFirst(page.locator('.select2-drop-active .select2-results li, .select2-drop-active .select2-result-label, .select2-results li, .select2-result-label').filter({ hasText: optionRegex }), `${description} Select2 option`, 2500).catch(() => null) ||
    await visibleFirst(page.locator('.select2-drop-active .select2-results li, .select2-drop-active .select2-result-label, .select2-results li, .select2-result-label').filter({ hasText: looseOptionRegex }), `${description} Select2 option`, 2500).catch(() => null)

  if (option) {
    await option.click({ force: true })
  } else {
    await page.keyboard.press('Enter')
  }
  await page.waitForTimeout(400)
  log('SELECT_OPTION', `${description} => ${optionText}`)
}

async function verifyAddendumSelected(page, subsectionName, addendum) {
  const selected = await page.evaluate(({ subsectionName, addendum }) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function normalize(value) {
      return clean(value).replace(/[^a-z0-9]+/gi, '').toLowerCase()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const elements = Array.from(document.querySelectorAll('body *'))
    const subsection = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) => isVisible(element) && text.includes(subsectionName) && rect.height < 120)
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!subsection) return false
    const startY = subsection.rect.top + window.scrollY
    const nextSubsection = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) =>
        isVisible(element) &&
        rect.top + window.scrollY > startY + 10 &&
        /Default .* Templates/i.test(text) &&
        rect.height < 120,
      )
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    const endY = nextSubsection ? nextSubsection.rect.top + window.scrollY : startY + 900
    const desired = normalize(addendum)
    return Array.from(document.querySelectorAll('.select2-search-choice, .select2-selection__choice, .Select-value'))
      .some((chip) => {
        const rect = chip.getBoundingClientRect()
        return isVisible(chip) && rect.top + window.scrollY >= startY && rect.top + window.scrollY < endY && normalize(chip.textContent).includes(desired)
      })
  }, { subsectionName, addendum })

  if (!selected) throw new SoftStepError(`Could not verify "${addendum}" was selected in ${subsectionName} Addenda Template(s)`)
  log('ADDENDUM_VERIFIED', `${subsectionName} => ${addendum}`)
}

async function verifyPageSelectionText(page, description, expectedValue, { sectionName = '' } = {}) {
  if (expectedValue == null || expectedValue === '') return
  if (sectionName) await scrollToText(page, sectionName)
  const expected = String(expectedValue).trim()
  const found = await page.evaluate(({ expected, sectionName }) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function normalize(value) {
      return clean(value).replace(/[^a-z0-9]+/gi, '').toLowerCase()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const elements = Array.from(document.querySelectorAll('body *'))
    const sectionElement = sectionName
      ? elements.find((element) => isVisible(element) && normalizeSectionText(element.textContent) === normalizeSectionText(sectionName))
      : null
    const sectionY = sectionElement ? sectionElement.getBoundingClientRect().top + window.scrollY : 0
    const desired = normalize(expected)
    return elements.some((element) => {
      if (!isVisible(element)) return false
      const rect = element.getBoundingClientRect()
      if (sectionName && rect.top + window.scrollY < sectionY) return false
      const text = normalize(element.textContent)
      return text === desired || text.includes(desired)
    })
    function normalizeSectionText(value) {
      return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
    }
  }, { expected, sectionName })
  if (!found) throw new SoftStepError(`${description} did not verify. Expected page selection text "${expected}"`)
  log('SELECTION_TEXT_VERIFIED', `${sectionName ? `${sectionName} ` : ''}${description} => ${expected}`)
}

async function findDropdownNearLabel(page, labelText, sectionName = '') {
  const controlIndex = await page.evaluate(({ labelText, sectionName, dropdownControlSelector }) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const elements = Array.from(document.querySelectorAll('body *'))
    const sectionElement = sectionName
      ? elements.find((element) => isVisible(element) && normalizeSectionText(element.textContent) === normalizeSectionText(sectionName))
      : null
    const sectionY = sectionElement ? sectionElement.getBoundingClientRect().top + window.scrollY : 0
    const label = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) =>
        isVisible(element) &&
        text.includes(labelText) &&
        (!sectionName || rect.top + window.scrollY >= sectionY) &&
        rect.height < 90,
      )
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!label) return -1
    const controls = Array.from(document.querySelectorAll(dropdownControlSelector))
    const candidates = controls
      .map((control, index) => ({ control, index, rect: control.getBoundingClientRect() }))
      .filter(({ control, rect }) =>
        isVisible(control) &&
        rect.right >= label.rect.left - 24 &&
        Math.abs((rect.top + rect.height / 2) - (label.rect.top + label.rect.height / 2)) < 90,
      )
      .sort((a, b) => {
        const ady = Math.abs((a.rect.top + a.rect.height / 2) - (label.rect.top + label.rect.height / 2))
        const bdy = Math.abs((b.rect.top + b.rect.height / 2) - (label.rect.top + label.rect.height / 2))
        return ady - bdy || a.rect.left - b.rect.left
    })
    function normalizeSectionText(value) {
      return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
    }
    return candidates[0]?.index ?? -1
  }, { labelText, sectionName, dropdownControlSelector: DROPDOWN_CONTROL_SELECTOR })
  if (controlIndex < 0) throw new SoftStepError(`Could not find dropdown near "${labelText}"`)
  return page.locator(DROPDOWN_CONTROL_SELECTOR).nth(controlIndex)
}

async function selectDropdownControl(page, control, description, optionText, searchText = optionText) {
  const tagName = await control.evaluate((element) => element.tagName.toLowerCase()).catch(() => '')
  if (tagName === 'select') {
    const selected = await control.evaluate((select, desiredOptionText) => {
      function normalize(value) {
        return String(value || '').replace(/[^a-z0-9]+/gi, '').toLowerCase()
      }

      const desired = normalize(desiredOptionText)
      const options = Array.from(select.options || [])
      const match =
        options.find((option) => normalize(option.textContent) === desired) ||
        options.find((option) => normalize(option.value) === desired) ||
        options.find((option) => normalize(option.textContent).includes(desired)) ||
        options.find((option) => desired.includes(normalize(option.textContent)))

      if (!match) {
        return {
          ok: false,
          options: options.map((option) => ({ text: option.textContent, value: option.value })).slice(0, 50),
        }
      }

      select.value = match.value
      select.dispatchEvent(new Event('input', { bubbles: true }))
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, text: match.textContent, value: match.value }
    }, optionText)

    if (!selected.ok) {
      throw new SoftStepError(`Could not select "${optionText}" in ${description}. Options: ${JSON.stringify(selected.options)}`)
    }
    log('SELECT_OPTION', `${description} => ${selected.text || selected.value}`)
    return
  }

  const isSelect2 = await control.evaluate((element) =>
    element.classList.contains('select2-container') ||
    element.classList.contains('select2-choice') ||
    Boolean(element.closest('.select2-container')),
  ).catch(() => false)
  if (isSelect2) {
    await selectSelect2Dropdown(page, control, description, optionText, searchText)
    return
  }

  const input = control.locator('input[role="combobox"], input').first()
  const inputCandidate = await visibleFirst(input, `${description} combobox input`, 2500).catch(() => control)
  await inputCandidate.click({ force: true })
  await inputCandidate.fill(searchText).catch(async () => inputCandidate.pressSequentially(searchText))
  const optionRegex = new RegExp(escapeRegex(optionText), 'i')
  const option = await visibleFirst(page.locator('.Select-option, [role="option"], li, div').filter({ hasText: optionRegex }), `${description} option`, 5000).catch(() => null)
  if (option) {
    await option.click({ force: true })
    return
  }
  await inputCandidate.press('Enter').catch(() => {})
  await page.waitForTimeout(350)
}

async function selectSelect2Dropdown(page, control, description, optionText, searchText = optionText) {
  await control.click({ force: true })
  const searchInput = await visibleFirst(
    page.locator('.select2-drop-active input, .select2-search input, input.select2-input').last(),
    `${description} Select2 search`,
    2500,
  ).catch(() => null)

  if (searchInput) {
    await searchInput.fill(String(searchText)).catch(async () => {
      await searchInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {})
      await searchInput.pressSequentially(String(searchText), { delay: 10 })
    })
  } else {
    await page.keyboard.type(String(searchText), { delay: 10 })
  }

  const optionRegex = new RegExp(`^\\s*${escapeRegex(optionText)}\\s*$`, 'i')
  const looseOptionRegex = new RegExp(escapeRegex(optionText), 'i')
  const option =
    await visibleFirst(page.locator('.select2-results li, .select2-result-label, [role="option"]').filter({ hasText: optionRegex }), `${description} Select2 option`, 2000).catch(() => null) ||
    await visibleFirst(page.locator('.select2-results li, .select2-result-label, [role="option"]').filter({ hasText: looseOptionRegex }), `${description} Select2 option`, 2000).catch(() => null)

  if (option) {
    await option.click({ force: true })
  } else {
    await page.keyboard.press('Enter')
  }
  await page.waitForTimeout(350)
  log('SELECT_OPTION', `${description} => ${optionText}`)
}

async function selectOwnerInOwnersAndFinancials(page, ownerName) {
  if (!ownerName) return
  await retryAction(`select Owner ${ownerName}`, async () => {
    await scrollToSectionHeading(page, 'Owners and Financials')
    const marker = await page.evaluate(() => {
      function clean(value) {
        return String(value || '').replace(/\s+/g, ' ').trim()
      }
      function normalize(value) {
        return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
      }
      function isVisible(element) {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      const elements = Array.from(document.querySelectorAll('body *'))
      const header = elements
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
        .filter(({ element, rect, text }) => isVisible(element) && normalize(text) === 'ownersandfinancials' && rect.height < 80)
        .sort((a, b) => a.rect.top - b.rect.top)[0]
      if (!header) return null
      const ownerHeader = elements
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
        .filter(({ element, rect, text }) =>
          isVisible(element) &&
          /^Owner$/i.test(text) &&
          rect.top > header.rect.bottom &&
          rect.top - header.rect.bottom < 160 &&
          rect.height < 60,
        )
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]
      if (!ownerHeader) return null
      const controls = Array.from(document.querySelectorAll('input:not([type="hidden"]), .select2-container, .select2-choice, .Select-control, [role="combobox"]'))
        .map((control) => ({ control, rect: control.getBoundingClientRect(), text: clean(control.textContent || control.getAttribute('placeholder') || '') }))
        .filter(({ control, rect }) =>
          isVisible(control) &&
          rect.top > ownerHeader.rect.bottom &&
          rect.top - ownerHeader.rect.bottom < 90 &&
          rect.left >= ownerHeader.rect.left - 16 &&
          rect.left < ownerHeader.rect.right + 120,
        )
        .sort((a, b) => {
          const aInput = a.control.matches('input') ? 0 : 1
          const bInput = b.control.matches('input') ? 0 : 1
          return aInput - bInput || a.rect.top - b.rect.top || a.rect.left - b.rect.left
        })
      const control = controls[0]?.control
      if (!control) return null
      const markerValue = `owner-control-${Date.now()}-${Math.random().toString(16).slice(2)}`
      control.setAttribute('data-codex-owner-control', markerValue)
      return markerValue
    })

    if (!marker) throw new SoftStepError('Could not find Owner search input in Owners and Financials')
    const ownerControl = page.locator(`[data-codex-owner-control="${marker}"]`).first()
    await ownerControl.scrollIntoViewIfNeeded()
    const clickTarget = await ownerControl.evaluate((element) => {
      const clickable = element.closest('.select2-container, .select2-choice, .Select-control') || element
      const rect = clickable.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        x: Math.max(rect.left + 20, rect.right - 18),
        y: rect.top + rect.height / 2,
        tag: clickable.tagName,
        text: String(clickable.textContent || element.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim(),
      }
    })
    log('OWNER_CLICK_TARGET', `${clickTarget.tag} ${clickTarget.text} x=${Math.round(clickTarget.x)} y=${Math.round(clickTarget.y)}`)
    await page.mouse.click(clickTarget.x, clickTarget.y)
    await page.waitForTimeout(350)

    let activeSearch =
      await visibleFirst(page.locator('.select2-drop-active input, .select2-search input, input.select2-input').last(), 'Owner active search input', 1200).catch(() => null)
    if (!activeSearch) {
      await page.mouse.click(clickTarget.left + 28, clickTarget.y)
      await page.waitForTimeout(350)
      activeSearch =
        await visibleFirst(page.locator('.select2-drop-active input, .select2-search input, input.select2-input').last(), 'Owner active search input', 1200).catch(() => null)
    }
    if (!activeSearch) {
      await page.keyboard.press('Alt+ArrowDown').catch(() => {})
      await page.waitForTimeout(350)
      activeSearch =
        await visibleFirst(page.locator('.select2-drop-active input, .select2-search input, input.select2-input').last(), 'Owner active search input', 1200).catch(() => null)
    }
    if (!activeSearch) throw new SoftStepError('Owner dropdown did not open an active search input')

    await activeSearch.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {})
    await activeSearch.press('Backspace').catch(() => {})
    const searchText = String(ownerName).split(/\s+/).filter(Boolean).slice(0, 2).join(' ') || String(ownerName)
    await activeSearch.pressSequentially(searchText, { delay: 10 }).catch(async () => {
      await page.keyboard.type(searchText, { delay: 10 })
    })
    await page.waitForTimeout(800)

    const optionRegex = new RegExp(escapeRegex(ownerName), 'i')
    const optionLabels = await page.locator('.select2-results li, .select2-result-label, .chosen-results li, [role="option"]')
      .evaluateAll((nodes) => nodes.map((node) => String(node.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10))
      .catch(() => [])
    log('OWNER_OPTIONS', optionLabels.join(' | ') || '(none)')
    const option =
      await visibleFirst(
        page
          .locator('.select2-drop-active .select2-result-selectable, .select2-drop-active .select2-result-label, .select2-results .select2-result-selectable, .select2-results .select2-result-label, .chosen-results li, [role="option"]')
          .filter({ hasText: optionRegex }),
        'Owner option',
        5000,
      ).catch(() => null)

    if (option) {
      await option.click({ force: true })
    } else {
      await page.keyboard.press('Enter')
    }
    await page.waitForTimeout(500)
    await verifyPageSelectionText(page, 'Owner', ownerName, { sectionName: 'Owners and Financials' })
    log('SELECT_OPTION', `Owner => ${ownerName}`)
  })
}

async function setCheckboxNearLabel(page, labelText, checked, { sectionName = '' } = {}) {
  await retryAction(`set checkbox ${labelText}`, async () => {
    if (sectionName) await scrollToText(page, sectionName)
    const index = await page.evaluate(({ labelText, sectionName }) => {
      function clean(value) {
        return String(value || '').replace(/\s+/g, ' ').trim()
      }
      function isVisible(element) {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }
      function normalizeSectionText(value) {
        return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
      }
      const elements = Array.from(document.querySelectorAll('body *'))
      const sectionY = sectionName
        ? elements.find((element) => isVisible(element) && normalizeSectionText(element.textContent) === normalizeSectionText(sectionName))?.getBoundingClientRect().top + window.scrollY
        : 0
      const label = elements
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
        .filter(({ element, rect, text }) =>
          isVisible(element) &&
          normalizeSectionText(text).includes(normalizeSectionText(labelText)) &&
          (!sectionName || (Number.isFinite(sectionY) && rect.top + window.scrollY >= sectionY)),
        )
        .sort((a, b) => a.rect.top - b.rect.top)[0]
      if (!label) return -1
      const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      return boxes
        .map((box, index) => ({ box, index, rect: box.getBoundingClientRect() }))
        .filter(({ box, rect }) => isVisible(box) && Math.abs((rect.top + rect.height / 2) - (label.rect.top + label.rect.height / 2)) < 110)
        .sort((a, b) => Math.abs(a.rect.left - label.rect.left) - Math.abs(b.rect.left - label.rect.left))[0]?.index ?? -1
    }, { labelText, sectionName })
    if (index < 0) throw new SoftStepError(`Could not find checkbox near "${labelText}"`)
    const checkbox = page.locator('input[type="checkbox"]').nth(index)
    const isChecked = await checkbox.isChecked()
    if (isChecked !== checked) await checkbox.click({ force: true })
  })
}

async function fillMissingPropertyGroup(page, value) {
  await retryAction(`property group ${value}`, async () => {
    await scrollToSectionHeading(page, 'Property Groups')
    if (await propertyGroupSelected(page, value)) {
      log('PROPERTY_GROUP_ALREADY_SELECTED', value)
      return
    }

    let marker = await findBlankPropertyGroupControlMarker(page)
    if (!marker) {
      await addAnotherPropertyGroup(page)
      await scrollToSectionHeading(page, 'Property Groups')
      marker = await findBlankPropertyGroupControlMarker(page)
    }
    if (!marker) throw new SoftStepError(`No blank property group dropdown found for "${value}"`)

    const control = page.locator(`[data-codex-property-group-control="${marker}"]`).first()
    await selectDropdownControl(page, control, `Property Group ${value}`, value, value)
    await verifyPropertyGroupSelected(page, value)
  })
}

async function findBlankPropertyGroupControlMarker(page) {
  return page.evaluate((dropdownControlSelector) => {
      function clean(value) {
        return String(value || '').replace(/\s+/g, ' ').trim()
      }
      function normalize(value) {
        return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
      }
      function isVisible(element) {
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      }

      const elements = Array.from(document.querySelectorAll('body *'))
      const header = elements
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
        .filter(({ element, rect, text }) => isVisible(element) && normalize(text) === 'propertygroups' && rect.height < 120)
        .sort((a, b) => a.rect.top - b.rect.top)[0]
      if (!header) return ''

      const startY = header.rect.top + window.scrollY
      const nextHeader = elements
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
        .filter(({ element, rect, text }) =>
          isVisible(element) &&
          rect.top + window.scrollY > startY + 20 &&
          /Bank Accounts|Notifications|Save/i.test(text) &&
          rect.height < 140,
        )
        .sort((a, b) => a.rect.top - b.rect.top)[0]
      const endY = nextHeader ? nextHeader.rect.top + window.scrollY : startY + 900
      const controls = Array.from(document.querySelectorAll(dropdownControlSelector))
        .map((control) => ({ control, rect: control.getBoundingClientRect(), text: clean(control.textContent || control.getAttribute('placeholder') || '') }))
        .filter(({ control, rect }) =>
          isVisible(control) &&
          rect.top + window.scrollY > startY &&
          rect.top + window.scrollY < endY &&
          !control.matches('input.select2-input') &&
          !/global-search/i.test(control.id || ''),
        )
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
      const control = controls.find(({ text }) => {
        const normalized = normalize(text)
        return !normalized || normalized === 'starttypingtosearch' || normalized === 'choosetemplate'
      })?.control
      if (!control) return ''
      const marker = `property-group-${Date.now()}-${Math.random().toString(16).slice(2)}`
      control.setAttribute('data-codex-property-group-control', marker)
      return marker
    }, DROPDOWN_CONTROL_SELECTOR)
}

async function propertyGroupSelected(page, value) {
  const values = await getPropertyGroupValues(page)
  return values.some((selected) => normalizedIncludes(selected, value))
}

async function verifyPropertyGroupSelected(page, value) {
  if (!(await propertyGroupSelected(page, value))) {
    const values = await getPropertyGroupValues(page)
    throw new SoftStepError(`Property Group "${value}" did not verify. Current groups: ${values.join(' | ') || '(none)'}`)
  }
  log('PROPERTY_GROUP_VERIFIED', value)
}

async function getPropertyGroupValues(page) {
  await scrollToSectionHeading(page, 'Property Groups')
  return page.evaluate((dropdownControlSelector) => {
    function clean(value) {
      return String(value || '').replace(/\s+/g, ' ').trim()
    }
    function normalize(value) {
      return clean(value).replace(/&/g, 'and').replace(/[^a-z0-9]+/gi, '').toLowerCase()
    }
    function isVisible(element) {
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    function controlValue(control) {
      const selected =
        control.querySelector('.select2-chosen, .select2-choice span, .Select-value-label, .Select-value, .select2-selection__rendered') ||
        control
      return clean(selected.textContent || selected.getAttribute('title') || selected.getAttribute('placeholder') || '')
        .replace(/^[^a-z0-9]+/i, '')
        .replace(/[^a-z0-9]+$/i, '')
    }

    const elements = Array.from(document.querySelectorAll('body *'))
    const header = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) => isVisible(element) && normalize(text) === 'propertygroups' && rect.height < 120)
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!header) return []

    const startY = header.rect.top + window.scrollY
    const nextHeader = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: clean(element.textContent) }))
      .filter(({ element, rect, text }) =>
        isVisible(element) &&
        rect.top + window.scrollY > startY + 20 &&
        /Bank Accounts|Notifications|Save/i.test(text) &&
        rect.height < 140,
      )
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    const endY = nextHeader ? nextHeader.rect.top + window.scrollY : startY + 900
    return Array.from(document.querySelectorAll(dropdownControlSelector))
      .map((control) => ({ control, rect: control.getBoundingClientRect(), value: controlValue(control) }))
      .filter(({ control, rect }) =>
        isVisible(control) &&
        rect.top + window.scrollY > startY &&
        rect.top + window.scrollY < endY &&
        !control.matches('input.select2-input') &&
        !/global-search/i.test(control.id || ''),
      )
      .map(({ value }) => value)
      .filter((value) => value && normalize(value) !== 'starttypingtosearch')
  }, DROPDOWN_CONTROL_SELECTOR)
}

async function addAnotherPropertyGroup(page) {
  await clickByRoleOrText(page, /\+?\s*add another property group/i, 'Add Another Property Group')
  await page.waitForTimeout(500)
}

function currentYearDoors() {
  return `${new Date().getFullYear()} Doors`
}

async function propertyDetails(page, row) {
  await selectNearestDropdown(page, 'Property Type', 'Single-Family', { searchText: 'Single-Family' })
  await waitForPropertyDetailsFieldsReady(page)
  await page.waitForTimeout(2500)
  await fillAndVerifyAddressBlock(page, row)
  await siteManager(page, row)
  await fillNearestField(page, 'Year Built', row.yearBuilt)
  await fillNearestField(page, 'Management Start Date', row.agreementStartDate)
  await verifyPropertyDetails(page, row)
}

async function siteManager(page, row) {
  await scrollToText(page, 'Site Manager')
  await fillNearestField(page, 'First Name', row.sor.firstName)
  await fillNearestField(page, 'Last Name', row.sor.lastName)
  await verifySiteManager(page, row)
}

async function customFields(page, row) {
  await fillNearestFieldWithAliases(page, ['Subdivision Name', 'Subdivision'], row.subdivision, { sectionName: 'Custom Fields' })
  if (row.tenantPlacement) {
    await setCheckboxNearLabel(page, 'Tenant Placement', true, { sectionName: 'Custom Fields' })
  }
  await verifyFieldNearLabelWithAliases(page, ['Subdivision Name', 'Subdivision'], row.subdivision, { sectionName: 'Custom Fields' })
  if (row.tenantPlacement) {
    await verifyCheckboxNearLabel(page, 'Tenant Placement', true, { sectionName: 'Custom Fields' })
  }
}

async function rentalInformation(page, row) {
  await selectNearestDropdown(page, 'Bedrooms', row.bed, { sectionName: 'Rental Information', searchText: row.bed })
  await selectNearestDropdown(page, 'Bathrooms', row.bath, { sectionName: 'Rental Information', searchText: row.bath })
  await fillNearestField(page, 'Square Feet', row.sqft, { sectionName: 'Rental Information' })
  await fillNearestField(page, 'NSF Fee', '55', { sectionName: 'Rental Information' })
  await fillNearestField(page, 'Amenities', row.amenities, { sectionName: 'Rental Information', multiline: true })
  await fillNearestField(page, 'Additional Lease Information', row.additionalLeaseInformation, {
    sectionName: 'Rental Information',
    multiline: true,
  })

  await selectNearestDropdown(page, 'Listing Type', row.listingType, { sectionName: 'Marketing Information', searchText: row.listingType })
  await verifyDropdownNearLabel(page, 'Bedrooms', row.bed, { sectionName: 'Rental Information' })
  await verifyDropdownNearLabel(page, 'Bathrooms', row.bath, { sectionName: 'Rental Information' })
  await verifyFieldNearLabel(page, 'Square Feet', row.sqft, { sectionName: 'Rental Information' })
  await verifyFieldNearLabel(page, 'NSF Fee', '55', { sectionName: 'Rental Information' })
  await verifyFieldNearLabel(page, 'Amenities', row.amenities, { sectionName: 'Rental Information', multiline: true })
  await verifyFieldNearLabel(page, 'Additional Lease Information', row.additionalLeaseInformation, {
    sectionName: 'Rental Information',
    multiline: true,
  })
  await verifyDropdownNearLabel(page, 'Listing Type', row.listingType, { sectionName: 'Marketing Information' })
}

async function leaseSettings(page) {
  if (CONFIG.skipLeaseSettingsForTraining) {
    logState('TRAINING_FAST_FORWARD', 'Lease Settings skipped by APPFOLIO_SKIP_LEASE_SETTINGS_FOR_TRAINING=true')
    return
  }
  for (const addendum of DEFAULT_ADDENDUMS) {
    await selectAddendaTemplateInSubsection(page, 'Default New Lease Templates', addendum)
  }
  for (const addendum of DEFAULT_ADDENDUMS) {
    await selectAddendaTemplateInSubsection(page, 'Default Renewal Templates', addendum)
  }
  for (const addendum of DEFAULT_ADDENDUMS) {
    await verifyAddendumSelected(page, 'Default New Lease Templates', addendum)
    await verifyAddendumSelected(page, 'Default Renewal Templates', addendum)
  }
}

async function ownersAndFinancials(page, row) {
  await selectOwnerInOwnersAndFinancials(page, row.ownerName)
  await fillNearestField(page, 'Reserve Funds', '300', { sectionName: 'Distributions' })
  await verifyPageSelectionText(page, 'Owner', row.ownerName, { sectionName: 'Owners and Financials' })
  await verifyFieldNearLabel(page, 'Reserve Funds', '300', { sectionName: 'Distributions' })
}

async function managementFees(page, row) {
  const sectionName = 'Management Fees'
  await scrollToSectionHeading(page, sectionName)
  await setCheckboxNearLabel(page, 'Waive Fees when Vacant', true, { sectionName })
  await setRadioOptionNearLabel(page, 'Fee Type', row.managementFee.kind, { sectionName })
  if (row.managementFee.kind === 'Flat') {
    await fillNearestField(page, 'Management Flat Fee', row.managementFee.value, { sectionName })
  } else if (row.managementFee.kind === 'Percent') {
    await fillNearestField(page, 'Management Fee Percent', row.managementFee.value, { sectionName })
  }
  await verifyCheckboxNearLabel(page, 'Waive Fees when Vacant', true, { sectionName })
  await verifyRadioOptionNearLabel(page, 'Fee Type', row.managementFee.kind, { sectionName })
  if (row.managementFee.kind === 'Flat') {
    await verifyFieldNearLabel(page, 'Management Flat Fee', row.managementFee.value, { sectionName })
  } else if (row.managementFee.kind === 'Percent') {
    await verifyFieldNearLabel(page, 'Management Fee Percent', row.managementFee.value, { sectionName })
  }
}

async function additionalFees(page, row) {
  const sectionName = 'Additional Fees'
  await scrollToSectionHeading(page, sectionName)
  requireFee(row.leaseFee, 'Lease Fee')
  requireValue(row.renewalFee, 'Renewal Fee')
  await setRadioOptionNearLabel(page, 'Lease Fee Type', row.leaseFee.kind, { sectionName })
  if (row.leaseFee.kind === 'Percent') {
    await fillNearestFieldWithAliases(page, ['Lease Fee Percent', 'Lease Fee'], row.leaseFee.value, { sectionName })
  } else if (row.leaseFee.kind === 'Flat') {
    await fillNearestFieldWithAliases(page, ['Lease Fee Flat', 'Lease Flat Fee', 'Lease Fee'], row.leaseFee.value, { sectionName })
  }
  await setRadioOptionNearLabel(page, 'Renewal Fee Type', 'Flat', { sectionName })
  await fillNearestFieldWithAliases(page, ['Renewal Fee Flat', 'Renewal Flat Fee', 'Renewal Fee'], row.renewalFee, { sectionName })

  await verifyRadioOptionNearLabel(page, 'Lease Fee Type', row.leaseFee.kind, { sectionName })
  if (row.leaseFee.kind === 'Percent') {
    await verifyFieldNearLabelWithAliases(page, ['Lease Fee Percent', 'Lease Fee'], row.leaseFee.value, { sectionName })
  } else if (row.leaseFee.kind === 'Flat') {
    await verifyFieldNearLabelWithAliases(page, ['Lease Fee Flat', 'Lease Flat Fee', 'Lease Fee'], row.leaseFee.value, { sectionName })
  }
  await verifyRadioOptionNearLabel(page, 'Renewal Fee Type', 'Flat', { sectionName })
  await verifyFieldNearLabelWithAliases(page, ['Renewal Fee Flat', 'Renewal Flat Fee', 'Renewal Fee'], row.renewalFee, { sectionName })
}

function requireFee(fee, label) {
  if (!fee?.kind || !fee?.value) {
    throw new SoftStepError(`Missing required ${label}. Expected a flat amount or percent in the Property_Onboarding row.`)
  }
}

function requireValue(value, label) {
  if (String(value ?? '').trim() === '') {
    throw new SoftStepError(`Missing required ${label} in the Property_Onboarding row.`)
  }
}

async function lateFeePolicy(page) {
  const sectionName = 'Late Fee Policy Details'
  await scrollToSectionHeading(page, sectionName)
  await setRadioOptionNearLabel(page, 'Late Fee Type', 'Flat', { sectionName })
  await fillNearestField(page, 'Base Late Fee', '100', { sectionName: 'Late Fee Policy Details' })
  await selectNearestDropdown(page, 'Eligible Charges', 'Only recurring rent', { sectionName: 'Late Fee Policy Details', searchText: 'Only recurring rent' })
  await setGracePeriodAfter(page, '3', { sectionName: 'Late Fee Policy Details' })
  await clickVisibleText(page, /optional settings/i, 'Optional Settings')
  await setCheckboxNearLabel(page, 'Charge Daily Late Fee', true, { sectionName: 'Late Fee Policy Details' })
  await fillNearestField(page, 'Daily Late Fee', '3', { sectionName: 'Late Fee Policy Details' })
  await fillNearestField(page, 'Grace Balance', '0', { sectionName: 'Late Fee Policy Details' })
  await verifyRadioOptionNearLabel(page, 'Late Fee Type', 'Flat', { sectionName: 'Late Fee Policy Details' })
  await verifyFieldNearLabel(page, 'Base Late Fee', '100', { sectionName: 'Late Fee Policy Details' })
  await verifyDropdownNearLabel(page, 'Eligible Charges', 'Only recurring rent', { sectionName: 'Late Fee Policy Details' })
  await verifyGracePeriodAfter(page, '3', { sectionName: 'Late Fee Policy Details' })
  await verifyCheckboxNearLabel(page, 'Charge Daily Late Fee', true, { sectionName: 'Late Fee Policy Details' })
  await verifyFieldNearLabel(page, 'Daily Late Fee', '3', { sectionName: 'Late Fee Policy Details' })
  await verifyFieldNearLabel(page, 'Grace Balance', '0', { sectionName: 'Late Fee Policy Details' })
}

async function maintenanceInformation(page, row) {
  await fillNearestField(page, 'Maintenance Limit', row.maintenanceLimit, { sectionName: 'Maintenance Information' })
  await verifyFieldNearLabel(page, 'Maintenance Limit', row.maintenanceLimit, { sectionName: 'Maintenance Information' })
}

async function propertyGroups(page, row) {
  const groups = ['all', 'Lifestyles Rental Services 06-2020', currentYearDoors(), row.sor.raw].filter(Boolean)
  for (const group of groups) {
    await fillMissingPropertyGroup(page, group)
    await verifyPropertyGroupSelected(page, group)
  }
}

async function bankAccounts(page) {
  await selectNearestDropdown(page, '1150: Owner Rent Account', 'Enterprise LRS Owner Account (Enterprise Bank & Trust)', {
    sectionName: 'Bank Accounts',
    searchText: 'Enterprise LRS Owner Account',
  })
  await selectNearestDropdown(page, '1160: Escrow Account', 'Enterprise LRS Escrow Account (Enterprise Bank & Trust)', {
    sectionName: 'Bank Accounts',
    searchText: 'Enterprise LRS Escrow Account',
  })
  await verifyDropdownNearLabel(page, '1150: Owner Rent Account', 'Enterprise LRS Owner Account (Enterprise Bank & Trust)', {
    sectionName: 'Bank Accounts',
  })
  await verifyDropdownNearLabel(page, '1160: Escrow Account', 'Enterprise LRS Escrow Account (Enterprise Bank & Trust)', {
    sectionName: 'Bank Accounts',
  })
}

async function finalReviewAndSave(page) {
  if (CONFIG.dryRun) {
    logState('DRY_RUN', 'Final Save skipped because APPFOLIO_PROPERTY_DRY_RUN=true')
    return
  }
  if (CONFIG.requireFinalSaveConfirmation) {
    await askForFinalSaveConfirmation(page)
  }
  await saveSection(page, 'Bank Accounts')
}

async function verifyCreatedProperty(page, row) {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(1500)
  let propertyId = extractPropertyId(page.url())
  if (propertyId) {
    return { url: page.url(), propertyId }
  }

  const searchText = row.address1
  if (!searchText) {
    return { url: page.url(), propertyId: '' }
  }

  const search = await findVisibleGlobalSearchInput(page)
  await search.click({ force: true })
  await search.fill(searchText)
  await page.waitForTimeout(3500)
  const result = page.locator('a[href*="/properties/"]').filter({ hasText: new RegExp(escapeRegex(searchText), 'i') }).first()
  if (await result.isVisible({ timeout: 4000 }).catch(() => false)) {
    const text = await result.innerText().catch(() => '')
    log('PROPERTY_SEARCH_RESULT', text.replace(/\s+/g, ' ').slice(0, 160))
    await result.click({ force: true })
  } else {
    log('PROPERTY_SEARCH_RESULT', `No direct link found for ${searchText}; pressing Enter`)
    await page.keyboard.press('Enter')
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(3500)
  propertyId = extractPropertyId(page.url())
  if (!propertyId) {
    const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')
    throw new Error(`Saved property was not verified after search for "${searchText}". URL=${page.url()} body=${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`)
  }
  return { url: page.url(), propertyId }
}

async function findVisibleGlobalSearchInput(page) {
  const count = await page.locator('#global-search-input').count()
  for (let index = 0; index < count; index += 1) {
    const input = page.locator('#global-search-input').nth(index)
    if (await input.isVisible().catch(() => false)) return input
  }
  return visibleFirst(page.locator('input[placeholder="Search AppFolio"], input[type="search"]').first(), 'global AppFolio search', 5000)
}

function extractPropertyId(url) {
  return String(url || '').match(/\/properties\/(\d+)/)?.[1] || ''
}

function normalizeSectionName(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase()
}

async function runWorkflow(page, row, username, password) {
  const sections = [
    ['login', () => loginToAppFolio(page, APPFOLIO_AUTH_CONFIG, {
      username,
      password,
      interactive: Boolean(process.stdin.isTTY),
      log,
    })],
    ['navigateToNewProperty', () => navigateToNewProperty(page)],
    ['propertyDetails', () => propertyDetails(page, row)],
    ['siteManager', () => siteManager(page, row)],
    ['customFields', () => customFields(page, row)],
    ['rentalInformation', () => rentalInformation(page, row)],
    ['leaseSettings', () => leaseSettings(page, row)],
    ['ownersAndFinancials', () => ownersAndFinancials(page, row)],
    ['managementFees', () => managementFees(page, row)],
    ['additionalFees', () => additionalFees(page, row)],
    ['lateFeePolicy', () => lateFeePolicy(page, row)],
    ['maintenanceInformation', () => maintenanceInformation(page, row)],
    ['propertyGroups', () => propertyGroups(page, row)],
    ['bankAccounts', () => bankAccounts(page, row)],
    ['finalReviewAndSave', () => finalReviewAndSave(page)],
  ]

  const startKey = normalizeSectionName(CONFIG.startSection)
  const startIndex = startKey ? sections.findIndex(([name]) => normalizeSectionName(name) === startKey) : 0
  if (startIndex < 0) {
    throw new Error(`Unknown START_SECTION "${CONFIG.startSection}". Valid sections: ${sections.map(([name]) => name).join(', ')}`)
  }
  if (startKey) {
    log('START_SECTION', sections[startIndex][0])
    await ensureResumePageReady(page, sections[startIndex][0])
  }

  for (const [name, action] of sections.slice(startIndex)) {
    await runSection(page, name, action)
  }
}

async function ensureResumePageReady(page, sectionName) {
  if (['login', 'navigateToNewProperty'].includes(sectionName)) return
  const url = page.url()
  if (/^about:blank/i.test(url)) {
    throw new Error(
      `START_SECTION=${sectionName} requires the headed browser to already be on the active AppFolio property form. Current page is about:blank.`,
    )
  }
  if (!/appfolio\.com/i.test(url)) {
    throw new Error(
      `START_SECTION=${sectionName} requires an AppFolio page. Current page is ${url}.`,
    )
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function main() {
  let context
  let page
  let hadFailure = false
  try {
    const rows = await resolveRowsToProcess()
    if (!rows.length) {
      logState('NO_INCOMPLETE_ROWS', `No blank or Not Started rows found in ${CONFIG.sheetName}`)
      return
    }
    log('ROWS_TO_PROCESS', rows.map((row) => `row=${row.sheetRowNumber || 'payload'} address="${row.address1 || '(missing address)'}"`).join(' | '))

    const username = process.env.APPFOLIO_USERNAME || ''
    const password = process.env.APPFOLIO_PASSWORD || ''
    log('Launching Playwright', CONFIG.headless ? 'headless' : 'headed')
    log('Using Playwright persistent profile', CONFIG.userDataDir)
    context = await launchOnboardingPersistentContext(APPFOLIO_AUTH_CONFIG, {
      rootDir,
      allowEmptyProfile: parseBoolean(process.env.ALLOW_EMPTY_PLAYWRIGHT_PROFILE, false),
      log,
    })
    page = context.pages()[0] || await context.newPage()
    page.setDefaultTimeout(Number(process.env.PLAYWRIGHT_TIMEOUT_MS || '15000'))

    for (const row of rows) {
      failedFields.length = 0
      const rowLabel = `row=${row.sheetRowNumber || 'payload'} address="${row.address1 || '(missing address)'}"`
      log('ROW_PROCESSING_STARTED', rowLabel)
      try {
        await updateOnboardingRowStatus(row, 'Processing')
        await runWorkflow(page, row, username, password)
        const verified = await verifyCreatedProperty(page, row)
        await updateOnboardingRowStatus(row, 'Completed', { propertyId: verified.propertyId, errorMessage: '' })
        if (failedFields.length) {
          log('FAILED_FIELDS', JSON.stringify(failedFields))
        }
        log('PROPERTY_URL', verified.url)
        log('PROPERTY_ID', verified.propertyId || '(not found)')
        logState('SUCCESS', `Property onboarding completed for ${rowLabel}`)
      } catch (error) {
        hadFailure = true
        let screenshotPath = ''
        if (page) screenshotPath = await capturePageDiagnostics(page, 'property-onboarding-error', error.message)
        await updateOnboardingRowStatus(row, 'Failed', { errorMessage: error.message }).catch((statusError) => {
          log('ROW_STATUS_UPDATE_FAILED', `row=${row.sheetRowNumber || 'payload'} error=${statusError.message}`)
        })
        logState('ERROR', `${rowLabel} ${error.message}`)
        if (screenshotPath) console.error(`Screenshot saved to: ${screenshotPath}`)
        if (page && !page.isClosed?.() && CONFIG.pauseOnError) {
          await pauseForTrainingError(error.message)
        }
      }
    }
  } catch (error) {
    let screenshotPath = ''
    if (page) screenshotPath = await capturePageDiagnostics(page, 'property-onboarding-error', error.message)
    logState('ERROR', error.message)
    if (screenshotPath) console.error(`Screenshot saved to: ${screenshotPath}`)
    if (page && !page.isClosed?.() && CONFIG.pauseOnError) {
      await pauseForTrainingError(error.message)
    }
    process.exitCode = 1
  } finally {
    await context?.close().catch(() => {})
  }
  if (hadFailure) process.exitCode = 1
}

main().catch((error) => {
  logState('ERROR', error.message)
  process.exit(1)
})
