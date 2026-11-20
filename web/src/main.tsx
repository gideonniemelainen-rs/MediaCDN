import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import UploadPage from './upload/UploadPage.tsx'

// There is no router: the player is `/` and the upload page is `/upload/`.
const Page = /^\/upload\/?$/.test(window.location.pathname) ? UploadPage : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
)
