import { atom } from 'nanostores'

// Presentation only. Survives virtualization and rehydration in this TUI;
// a fresh launch starts collapsed. Never modifies conversation/provider state.
export const $expandedJobNotices = atom<ReadonlySet<string>>(new Set())

export const toggleJobNotice = (id: string) => {
  const next = new Set($expandedJobNotices.get())

  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }

  $expandedJobNotices.set(next)
}
