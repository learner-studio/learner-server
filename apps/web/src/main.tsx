import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { LearnerShell } from './components/shell'
import LearnerHomePage from './pages/Home'
import LearnerOsmosisPage from './pages/Osmosis'
import LearnerProgressPage from './pages/Progress'
import LearnerLiveFeedbackPage from './pages/LiveFeedback'

const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/learner" replace /> },
  {
    path: '/learner', element: <LearnerShell />,
    children: [
      { index: true, element: <LearnerHomePage /> },
      { path: 'osmosis', element: <LearnerOsmosisPage /> },
      { path: 'progress', element: <LearnerProgressPage /> },
      { path: 'feedback', element: <LearnerLiveFeedbackPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/learner" replace /> },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
