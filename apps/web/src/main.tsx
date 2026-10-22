import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider, useLocation, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { LearnerShell } from './components/shell'
import LearnerHomePage from './pages/Home'
import LearnerOsmosisPage from './pages/Osmosis'
import LearnerProgressPage from './pages/Progress'
import LearnerLiveFeedbackPage from './pages/LiveFeedback'

// The Osmosis admin pages carry sigma, graphology and React Flow; they load on first visit.
const page = (load: () => Promise<{ default: () => React.JSX.Element }>) => async () => ({ Component: (await load()).default })

/** Old `/learning/<page>` links land on the same page under Osmosis, query intact. */
function LegacyLearningRedirect() {
  const rest = useParams()['*'] ?? ''
  const { search } = useLocation()
  return <Navigate to={`/learner/osmosis${rest ? `/${rest}` : ''}${search}`} replace />
}

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/learner" replace /> },
  {
    path: '/learner', element: <LearnerShell />,
    children: [
      { index: true, element: <LearnerHomePage /> },
      { path: 'osmosis', lazy: page(() => import('./pages/learning/LearningPage')) },
      { path: 'osmosis/build', lazy: page(() => import('./pages/learning/CurriculumBuilder')) },
      { path: 'osmosis/history', lazy: page(() => import('./pages/learning/ConversationHistory')) },
      { path: 'osmosis/playground', lazy: page(() => import('./pages/learning/Playground')) },
      { path: 'osmosis/status', element: <LearnerOsmosisPage /> },
      { path: 'progress', element: <LearnerProgressPage /> },
      { path: 'feedback', element: <LearnerLiveFeedbackPage /> },
    ],
  },
  { path: '/learning/*', element: <LegacyLearningRedirect /> },
  { path: '*', element: <Navigate to="/learner" replace /> },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
