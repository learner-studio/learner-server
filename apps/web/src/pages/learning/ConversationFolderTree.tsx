import { useState } from 'react'
import { cn } from '../../lib/utils'
import { buildFolderTree, type ConversationThread, type FolderNode } from './conversation-history-model'

function FolderRow({ node, depth, value, expanded, onToggle, onChange }: {
  readonly node: FolderNode
  readonly depth: number
  readonly value: string
  readonly expanded: Readonly<Record<string, boolean>>
  readonly onToggle: (value: string) => void
  readonly onChange: (value: string) => void
}) {
  const open = Boolean(expanded[node.value])
  const selected = node.value === value
  return (
    <li role="treeitem" aria-expanded={node.children?.length ? open : undefined} aria-selected={selected}>
      <button type="button" data-folder-tree-row="true" aria-label={node.label} style={{ paddingLeft: `${0.5 + depth * 0.9}rem` }}
        onClick={() => { onChange(node.value); if (node.children?.length) onToggle(node.value) }}
        className={cn('flex w-full cursor-pointer items-center gap-1.5 truncate rounded-md py-1 pr-2 text-left text-sm transition', selected ? 'bg-glass-strong font-semibold text-ink' : 'text-ink-soft hover:bg-glass hover:text-ink')}>
        <span className="w-3 flex-none text-xs" aria-hidden="true">{node.children?.length ? (open ? '▾' : '▸') : ''}</span>
        <span className="truncate">{node.label}</span>
      </button>
      {open && node.children?.length ? (
        <ul role="group" className="m-0 list-none border-l border-rule p-0" style={{ marginLeft: `${0.9 + depth * 0.9}rem` }}>
          {node.children.map((child) => <FolderRow key={child.value} node={child} depth={depth + 1} value={value} expanded={expanded} onToggle={onToggle} onChange={onChange} />)}
        </ul>
      ) : null}
    </li>
  )
}

/** The workspace folders the threads were recorded in, as a collapsible tree; picking one filters the thread list. */
export default function ConversationFolderTree({ threads, value, onChange }: { readonly threads: readonly ConversationThread[]; readonly value: string; readonly onChange: (value: string) => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggle = (folder: string) => setExpanded((current) => ({ ...current, [folder]: !current[folder] }))
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <strong>Conversation folders</strong>
      <ul role="tree" aria-label="Conversation folders" className="m-0 min-h-0 list-none overflow-auto p-0">
        {buildFolderTree(threads).map((node) => <FolderRow key={node.value} node={node} depth={0} value={value} expanded={expanded} onToggle={toggle} onChange={onChange} />)}
      </ul>
    </div>
  )
}
