import { useMemo, useRef, useState } from 'react'
import { submitPropertyOnboarding } from '../services/propertyOnboardingApi'

const initialForm = {
  serviceType: 'Management',
  sor: '',
}

function formatFileSize(bytes) {
  if (!bytes) {
    return '0 KB'
  }

  const kilobytes = bytes / 1024
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(1)} KB`
  }

  return `${(kilobytes / 1024).toFixed(2)} MB`
}

export function ManagementAgreementUpload() {
  const [formValues, setFormValues] = useState(initialForm)
  const [agreementFile, setAgreementFile] = useState(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const fileInputRef = useRef(null)
  const [status, setStatus] = useState({
    tone: 'idle',
    message: 'Waiting for a management agreement PDF.',
  })

  const selectedFileSummary = useMemo(() => {
    if (!agreementFile) {
      return null
    }

    return `${agreementFile.name} (${formatFileSize(agreementFile.size)})`
  }, [agreementFile])

  function handleFieldChange(event) {
    const { name, value } = event.target
    setFormValues((currentValues) => ({
      ...currentValues,
      [name]: value,
    }))
  }

  function handleFileChange(event) {
    const file = event.target.files?.[0] ?? null
    setAgreementFile(file)

    setStatus(
      file
        ? {
            tone: 'ready',
            message: `${file.name} is ready for intake review.`,
          }
        : {
            tone: 'idle',
            message: 'Waiting for a management agreement PDF.',
          },
    )
  }

  async function handleSubmit(event) {
    event.preventDefault()

    if (!agreementFile) {
      setStatus({
        tone: 'error',
        message: 'Choose a management agreement PDF before submitting.',
      })
      return
    }

    setIsSubmitting(true)
    setStatus({
      tone: 'loading',
      message: 'Uploading management agreement to the onboarding webhook...',
    })

    try {
      await submitPropertyOnboarding({
        agreementFile,
        serviceType: formValues.serviceType,
        sor: formValues.sor.trim(),
      })

      setFormValues(initialForm)
      setAgreementFile(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }

      setStatus({
        tone: 'success',
        message: 'Management agreement submitted successfully.',
      })
    } catch (error) {
      setStatus({
        tone: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Unable to submit the management agreement.',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section className="upload-panel" aria-labelledby="upload-title">
      <div className="panel-heading">
        <div>
          <h2 id="upload-title">Upload Management Agreement PDF</h2>
          <p>
            Add service type and SOR details so they travel with the document
            extraction workflow.
          </p>
        </div>
      </div>

      <form className="onboarding-form" onSubmit={handleSubmit}>
        <label className="file-drop-zone">
          <span className="file-label">Management agreement PDF</span>
          <span className="file-instructions">
            {selectedFileSummary ?? 'Select a PDF from your computer'}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            onChange={handleFileChange}
            disabled={isSubmitting}
          />
        </label>

        <div className="field-grid">
          <label className="field">
            <span>Service Type</span>
            <select
              name="serviceType"
              value={formValues.serviceType ?? initialForm.serviceType}
              onChange={handleFieldChange}
              disabled={isSubmitting}
            >
              <option value="Management">Management</option>
              <option value="Tenant Placement">Tenant Placement</option>
            </select>
          </label>

          <label className="field">
            <span>SOR</span>
            <input
              name="sor"
              type="text"
              value={formValues.sor ?? ''}
              onChange={handleFieldChange}
              placeholder="Enter SOR"
              disabled={isSubmitting}
            />
          </label>
        </div>

        <button className="submit-button" type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Submitting...' : 'Submit'}
        </button>
      </form>

      <div className={`status-area status-${status.tone}`} role="status">
        <span>Status</span>
        <p>{status.message}</p>
      </div>
    </section>
  )
}
