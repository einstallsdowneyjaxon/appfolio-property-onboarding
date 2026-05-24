import { ManagementAgreementUpload } from './components/ManagementAgreementUpload'
import './App.css'

function App() {
  return (
    <main className="app-shell">
      <section className="page-header" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">Intake workspace</p>
          <h1 id="page-title">Property Onboarding</h1>
          <p className="page-description">
            Upload a management agreement and capture service routing details
            before extraction runs.
          </p>
        </div>
        <div className="workflow-badge" aria-label="Current workflow status">
          Frontend draft
        </div>
      </section>

      <ManagementAgreementUpload />
    </main>
  )
}

export default App
