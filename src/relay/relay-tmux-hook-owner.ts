import { randomUUID } from 'node:crypto'
import { createAgentStatusStore } from '../shared/agent-status-store'
import { TmuxAgentHookOwner, type TmuxManagedPty } from '../shared/tmux-agent-hook-owner'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookUnavailableEnvelope } from '../shared/agent-hook-relay'

export function createRelayTmuxHookOwner(options: {
  getRoot?: (paneKey: string) => Promise<TmuxManagedPty | null>
  isRetired: (paneKey: string) => boolean
  getPrevious: (paneKey: string) => AgentHookEventPayload | undefined
  clearProjection: (paneKey: string) => void
  publish: (event: AgentHookEventPayload) => void
  forwardUnavailable?: (envelope: AgentHookUnavailableEnvelope) => void
}): TmuxAgentHookOwner | undefined {
  if (!options.getRoot) {
    return undefined
  }
  const store = createAgentStatusStore({ epoch: randomUUID(), mode: 'authority' })
  return new TmuxAgentHookOwner({
    store: () => store,
    getRoot: options.getRoot,
    isRetired: options.isRetired,
    publish: (event, observedAt) =>
      options.publish({ ...event, hostEvidenceObservedAt: observedAt }),
    unavailable: (paneKey) => {
      const previous = options.getPrevious(paneKey)
      options.clearProjection(paneKey)
      options.forwardUnavailable?.({
        source: previous?.source === 'opencode2' ? 'opencode2' : 'opencode',
        paneKey,
        tabId: previous?.tabId,
        worktreeId: previous?.worktreeId,
        launchToken: previous?.launchToken,
        connectionId: null,
        statusUnavailable: true,
        payload: null
      })
    }
  })
}
