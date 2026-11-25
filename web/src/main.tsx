import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import UploadPage from './upload/UploadPage.tsx'
import AnalysisPage from './AnalysisPage.tsx'
import { RequireAuth } from './auth/RequireAuth.tsx'
import { routeFor } from './routes.ts'
import { startSettingsSync } from './settings/store.ts'

// The player works without the pipeline server; uploads and analysis need a session.
const PAGES = {
  player: App,
  upload: () => (
    <RequireAuth current="upload">
      <UploadPage />
    </RequireAuth>
  ),
  analysis: () => (
    <RequireAuth current="analysis">
      <AnalysisPage />
    </RequireAuth>
  ),
}
const Page = PAGES[routeFor(window.location.pathname)]

// Delivery and player settings come from the pipeline server when it is up, and from the build's defaults when it is not.
startSettingsSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
