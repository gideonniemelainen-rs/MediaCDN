import NavBar from './NavBar'

// Placeholder: this will list earlier uploads and benchmark runs to analyse.
export default function AnalysisPage() {
  return (
    <div className="app">
      <NavBar current="analysis" />
      <main className="page-stub">
        <h1>Analysis</h1>
        <p>Prior uploads and benchmark runs will be listed here.</p>
      </main>
    </div>
  )
}
