const N8N_WEBHOOK_URL = import.meta.env.VITE_N8N_WEBHOOK_URL

export async function submitPropertyOnboarding({
  agreementFile,
  serviceType,
  sor,
}) {
  if (!N8N_WEBHOOK_URL) {
    throw new Error('Missing VITE_N8N_WEBHOOK_URL. Add it to your Vite environment.')
  }

  const payload = new FormData()
  payload.append('managementAgreementPdf', agreementFile)
  payload.append('serviceType', serviceType)
  payload.append('sor', sor)
  payload.append('tenantPlacement', serviceType === 'Tenant Placement' ? 'Yes' : '')

  const response = await fetch(N8N_WEBHOOK_URL, {
    method: 'POST',
    body: payload,
  })

  if (!response.ok) {
    const responseText = await response.text()
    throw new Error(
      responseText || `n8n webhook returned ${response.status} ${response.statusText}`,
    )
  }

  return response
}
