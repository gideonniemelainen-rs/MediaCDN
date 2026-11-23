import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import UploadPage from './upload/UploadPage.tsx'
import AnalysisPage from './AnalysisPage.tsx'
import { RequireAuth } from './auth/RequireAuth.tsx'
import { routeFor } from './routes.ts'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
