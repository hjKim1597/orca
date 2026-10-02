import { TmuxAgentHookOwner, type TmuxManagedPty } from '../../../shared/tmux-agent-hook-owner'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import { AgentHookServerOpenCodeBinder } from './server-opencode-binder'

export abstract class AgentHookServerTmuxStatus extends AgentHookServerOpenCodeBinder {
  private tmuxOwner: TmuxAgentHookOwner | undefined
  private tmuxRootResolver: (paneKey: string) => Promise<TmuxManagedPty | null> = async () => null

  setTmuxManagedPtyResolver(resolver: (paneKey: string) => Promise<TmuxManagedPty | null>): void {
    this.tmuxRootResolver = resolver
  }

  private get owner(): TmuxAgentHookOwner {
    this.tmuxOwner ??= new TmuxAgentHookOwner({
      store: () => this.canonicalStatusStore,
      getRoot: (paneKey) => this.tmuxRootResolver(paneKey),
      isRetired: (paneKey) => this.getAgentStatusDisposition(paneKey) === 'suppress',
      publish: (event, observedAt) => {
        if (this.getAgentStatusDisposition(event.paneKey, event) === 'suppress') {
          return
        }
        this.recordCurrentAuthorityObservation(event)
        this.applyNormalizedStatus(event, undefined, 'hook', observedAt)
      },
      unavailable: (paneKey) => {
        if (this.getAgentStatusDisposition(paneKey) === 'suppress') {
          return
        }
        this.clearPaneState(paneKey, { preserveTmuxInnerSubjects: true, statusUnavailable: true })
      }
    })
    return this.tmuxOwner
  }

  protected ingestTmuxHook(source: AgentHookSource, body: unknown): Promise<boolean> {
    return this.owner.ingest(source, body, this.env)
  }

  protected clearTmuxInnerSubjects(paneKey: string): void {
    this.tmuxOwner?.clearPane(paneKey)
  }

  protected clearTmuxTabSubjects(tabId: string): void {
    this.tmuxOwner?.clearTab(tabId)
  }

  protected stopTmuxStatus(): void {
    this.tmuxOwner?.stop()
    this.tmuxOwner = undefined
  }
}
