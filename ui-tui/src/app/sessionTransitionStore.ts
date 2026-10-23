import { atom, computed } from 'nanostores'

// Pending adoption fences old gestures as well as main-composer effects.
export const $sessionTransition = atom<null | object>(null)
export const $sessionAdopting = computed($sessionTransition, Boolean)
