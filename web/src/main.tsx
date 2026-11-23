import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import UploadPage from './upload/UploadPage.tsx'
import AnalysisPage from './AnalysisPage.tsx'
import { routeFor } from './routes.ts'

const PAGES = { player: App, upload: UploadPage, analysis: AnalysisPage }
const Page = PAGES[routeFor(window.location.pathname)]

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
