import type { ServerRequest } from '@hermes/shared/json-rpc-channel'

import type { OverlayState } from './interfaces.js'
import { getActivePromptKey, getOverlayState, patchOverlayState, type PromptKey } from './overlayStore.js'
import { getServerRequest } from './serverRequestStore.js'
import { getUiState } from './uiStore.js'

export interface PromptOwner {
  key: PromptKey
  prompt: NonNullable<OverlayState[PromptKey]>
  sessionId: null | string
  request?: ServerRequest
}

const promptInstances = new WeakMap<object, number>()
let nextPromptInstance = 0

/** Remount per actual request, not per reusable wire ID or clarify answer patch. */
export function promptInstanceKey(owner: PromptOwner | null): number | undefined {
  if (!owner) {
    return undefined
  }

  const instance = owner.request ?? owner.prompt
  let key = promptInstances.get(instance)

  if (key === undefined) {
    key = ++nextPromptInstance
    promptInstances.set(instance, key)
  }

  return key
}

/** Capture at render/admission, never by looking up the latest ID on a stale action. */
export function capturePromptOwner(
  key: PromptKey,
  prompt: OverlayState[PromptKey],
  sessionId = getUiState().sid
): PromptOwner | null {
  if (!prompt) {
    return null
  }

  const request = 'requestId' in prompt ? getServerRequest(prompt.requestId) : undefined

  return { key, prompt, request, sessionId }
}

export function ownsPrompt(owner: PromptOwner | null, completion = false): owner is PromptOwner {
  if (!owner || getUiState().sid !== owner.sessionId) {
    return false
  }

  const overlay = getOverlayState()

  if ((!completion && getActivePromptKey(overlay) !== owner.key) || overlay[owner.key] !== owner.prompt) {
    return false
  }

  if (!owner.request) {
    return !('requestId' in owner.prompt) || getServerRequest(owner.prompt.requestId) === undefined
  }

  if (owner.request.params.session_id && owner.request.params.session_id !== owner.sessionId) {
    return false
  }

  const current = getServerRequest(owner.request.id)

  // A successful synchronous respond removes its own request. A replacement
  // under the same wire ID is a different instance, including gateway replays.
  return current === owner.request || (completion && current === undefined)
}

export function clearOwnedPrompt(owner: PromptOwner | null): boolean {
  if (!ownsPrompt(owner, true)) {
    return false
  }

  patchOverlayState({ [owner.key]: null })

  return true
}

export function guardPromptAction<Args extends unknown[]>(owner: PromptOwner | null, action: (...args: Args) => void) {
  return (...args: Args) => {
    if (ownsPrompt(owner)) {
      action(...args)
    }
  }
}
