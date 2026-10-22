import { useLocation, useNavigate } from 'react-router-dom'
import { Button } from '../../components/ui/button'
import { LEARNER_BUILD, LEARNER_HISTORY, LEARNER_LOOP_STATUS, LEARNER_OSMOSIS, LEARNER_PLAYGROUND } from '../../lib/routes'

const OSMOSIS_NAV = [
  { label: 'Map', path: LEARNER_OSMOSIS },
  { label: 'Build', path: LEARNER_BUILD },
  { label: 'History', path: LEARNER_HISTORY },
  { label: 'Playground', path: LEARNER_PLAYGROUND },
  { label: 'Status', path: LEARNER_LOOP_STATUS },
] as const

/** The Osmosis pages under the header's one Osmosis link; the map is the root, so it matches only itself. */
export function OsmosisNav() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return (
    <nav aria-label="Osmosis" data-testid="osmosis-nav" className="glass flex w-fit max-w-full gap-1 overflow-x-auto rounded-full p-1">
      {OSMOSIS_NAV.map((item) => {
        const active = item.path === LEARNER_OSMOSIS ? pathname.replace(/\/$/, '') === LEARNER_OSMOSIS : pathname.startsWith(item.path)
        return <Button key={item.path} variant="nav" size="md" className="rounded-full" aria-current={active ? 'page' : undefined} onClick={() => navigate(item.path)}>{item.label}</Button>
      })}
    </nav>
  )
}
