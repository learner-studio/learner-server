import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from './ui/button'
import { signOut, useSession } from '../lib/api'
import { LEARNER_FEEDBACK, LEARNER_HOME, LEARNER_OSMOSIS, LEARNER_PROGRESS } from '../lib/routes'

export const LEARNER_NAV = [
  { label: 'Home', path: LEARNER_HOME },
  { label: 'Osmosis', path: LEARNER_OSMOSIS },
  { label: 'Progress', path: LEARNER_PROGRESS },
  { label: 'Live Feedback', path: LEARNER_FEEDBACK },
] as const

/** Home matches only itself; every other surface owns its sub-routes. */
const isActive = (path: string, active: string) => path === LEARNER_HOME ? active === LEARNER_HOME : active.startsWith(path)

/** The OS scheme by default; the header toggle overrides it for this browser. */
function useColorScheme() {
  const [scheme, setScheme] = useState<'light' | 'dark'>(() => {
    try { const saved = localStorage.getItem('learner-scheme'); if (saved === 'light' || saved === 'dark') return saved } catch { /* storage blocked */ }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', scheme === 'dark')
    try { localStorage.setItem('learner-scheme', scheme) } catch { /* storage blocked */ }
  }, [scheme])
  return [scheme, () => setScheme(scheme === 'dark' ? 'light' : 'dark')] as const
}

/** Learner's own chrome: one compact strip (wordmark, the four surfaces, scheme toggle, account) over a scroll box. */
export function LearnerShell() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const session = useSession()
  const queryClient = useQueryClient()
  const [scheme, toggleScheme] = useColorScheme()
  return (
    <div data-testid="learner-shell" className="flex h-full flex-col overflow-hidden">
      <div role="banner" data-testid="learner-header" className="flex h-8 flex-none items-center justify-between gap-2 border-b border-rule px-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-sm font-bold whitespace-nowrap">🧠 Learner</span>
          <nav aria-label="Learner" className="flex gap-1 overflow-x-auto">
            {LEARNER_NAV.map((item) => (
              <Button key={item.path} variant="nav" size="sm" aria-current={isActive(item.path, pathname) ? 'page' : undefined} onClick={() => navigate(item.path)}>{item.label}</Button>
            ))}
          </nav>
        </div>
        <div className="flex flex-none items-center gap-2">
          {session.data && <span className="hidden text-xs text-ink-soft sm:inline">{session.data.name}</span>}
          <Button variant="ghost" size="icon" aria-label={scheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={scheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleScheme}>{scheme === 'dark' ? '☀️' : '🌙'}</Button>
          {session.data && <Button variant="secondary" size="sm" onClick={async () => { await signOut(); await queryClient.invalidateQueries() }}>Sign out</Button>}
        </div>
      </div>
      <div className="flex min-h-0 flex-auto flex-col overflow-auto"><Outlet /></div>
    </div>
  )
}
