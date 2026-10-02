import { createHash } from 'node:crypto'
import { normalizeHookPayload } from './agent-hook-listener'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentHookSource } from './agent-hook-relay'
import type { AgentStatusStore } from './agent-status-store'
import { normalizeAgentStatusPayload } from './agent-status-types'
import type { AgentStatusExecutionScope, AgentStatusPtySubject } from './agent-status-subject'
import {
  readTmuxHookPane,
  resolveTmuxClientAttachment,
  type TmuxHookPane
} from './tmux-client-attachment'
import { probeTmuxHostAttachments } from './tmux-host-attachment-probe'

export type TmuxManagedPty = {
  pid: number
  incarnation: string
  scope: AgentStatusExecutionScope
}
type OuterPane = {
  paneKey: string
  socket: string
  root: TmuxManagedPty
  inner: Map<string, { subject: AgentStatusPtySubject; normalization: HookListenerState }>
  projectedPane?: string
  selection?: string
  publication?: string
}
const INNER_PREFIX = 'tmux-inner:'

export function isTmuxInnerSubject(subject: { kind: string; paneKey?: string }): boolean {
  return subject.kind === 'pty' && subject.paneKey?.startsWith(INNER_PREFIX) === true
}

/** Inner observations live in the hook owner's canonical store; this index holds attachments only. */
export class TmuxAgentHookOwner {
  private readonly outers = new Map<string, OuterPane>()
  private timer: ReturnType<typeof setInterval> | undefined
  private refreshing: Promise<void> | undefined
  private stopped = false
  private lastRefreshAt = -Infinity

  constructor(
    private readonly options: {
      store: () => AgentStatusStore
      getRoot: (paneKey: string) => Promise<TmuxManagedPty | null>
      publish: (event: AgentHookEventPayload, observedAt: number) => void
      unavailable: (paneKey: string) => void
      probe?: typeof probeTmuxHostAttachments
      isRetired?: (paneKey: string) => boolean
      now?: () => number
    }
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  async ingest(source: AgentHookSource, body: unknown, env: string): Promise<boolean> {
    if (source !== 'opencode' && source !== 'opencode2') {
      return false
    }
    if (typeof body !== 'object' || body === null || !('tmux' in body)) {
      return false
    }
    const tmux = readTmuxHookPane(body.tmux)
    if (!tmux || !('paneKey' in body) || typeof body.paneKey !== 'string' || this.stopped) {
      return true
    }
    const paneKey = body.paneKey
    const root = await this.options.getRoot(paneKey).catch(() => null)
    if (
      !root ||
      this.stopped ||
      this.options.isRetired?.(paneKey) ||
      !('worktreeId' in body) ||
      body.worktreeId !== root.scope.workspaceId
    ) {
      return true
    }
    let outer = this.outers.get(paneKey)
    if (
      outer &&
      (outer.root.incarnation !== root.incarnation ||
        outer.root.pid !== root.pid ||
        outer.socket !== tmux.socket)
    ) {
      this.clearPane(paneKey)
      outer = undefined
    }
    if (!outer) {
      if (this.outers.size >= 64) {
        return true
      }
      outer = { paneKey, socket: tmux.socket, root, inner: new Map() }
      this.outers.set(paneKey, outer)
    }
    const inner = this.inner(outer, tmux)
    if (!inner) {
      return true
    }
    const store = this.options.store()
    const previousParent = store.getParent(inner.subject)
    const previous = previousParent?.status
    const event = normalizeHookPayload(inner.normalization, source, body, env, {
      previousOpenCodeMainAgent: previous?.mainAgent
    })
    if (!event || event.paneKey !== paneKey) {
      return true
    }
    const observedAt = this.now()
    const stateStartedAt =
      previous?.state === event.payload.state ? previous.stateStartedAt : observedAt
    store.applyMutation({
      parent: {
        subject: inner.subject,
        firstObservedAt: previousParent?.firstObservedAt ?? observedAt,
        status: {
          ...event.payload,
          paneKey: inner.subject.paneKey,
          tabId: event.tabId,
          worktreeId: root.scope.workspaceId,
          connectionId: null,
          receivedAt: observedAt,
          evidenceObservedAt: observedAt,
          stateStartedAt,
          providerSession: event.providerSession,
          promptInteractionKey: event.promptInteractionKey,
          launchToken: event.launchToken
        }
      }
    })
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refresh()
      }, 1000)
      this.timer.unref?.()
    }
    this.project(outer)
    await this.refresh()
    return true
  }

  private inner(outer: OuterPane, tmux: TmuxHookPane) {
    let inner = outer.inner.get(tmux.pane)
    if (!inner && outer.inner.size < 32) {
      const digest = createHash('sha256')
        .update(`${outer.paneKey}\0${outer.socket}\0${tmux.pane}`)
        .digest('hex')
      const subject: AgentStatusPtySubject = {
        ...outer.root.scope,
        kind: 'pty',
        paneKey: INNER_PREFIX + digest
      }
      inner = { subject, normalization: createHookListenerState() }
      outer.inner.set(tmux.pane, inner)
    }
    return inner
  }

  refresh(): Promise<void> {
    if (this.refreshing) {
      return this.refreshing
    }
    if (this.stopped || this.now() - this.lastRefreshAt < 1000) {
      return Promise.resolve()
    }
    this.lastRefreshAt = this.now()
    const work = this.refreshAttachments().finally(() => {
      if (this.refreshing === work) {
        this.refreshing = undefined
      }
    })
    this.refreshing = work
    return work
  }

  private async refreshAttachments(): Promise<void> {
    const groups = new Map<string, OuterPane[]>()
    for (const outer of this.outers.values()) {
      const group = groups.get(outer.socket) ?? []
      group.push(outer)
      groups.set(outer.socket, group)
    }
    if (groups.size > 16) {
      return
    }
    await Promise.all(
      [...groups].map(async ([socket, outers]) => {
        const proof = await (this.options.probe ?? probeTmuxHostAttachments)(
          socket,
          outers.map((outer) => outer.root.pid)
        ).catch(() => null)
        if (!proof || this.stopped) {
          return
        }
        for (const outer of outers) {
          if (this.outers.get(outer.paneKey) !== outer) {
            continue
          }
          const current = await this.options.getRoot(outer.paneKey).catch(() => null)
          if (this.options.isRetired?.(outer.paneKey)) {
            this.clearPane(outer.paneKey)
            continue
          }
          if (!current) {
            continue
          }
          if (current.incarnation !== outer.root.incarnation || current.pid !== outer.root.pid) {
            this.clearPane(outer.paneKey)
            this.options.unavailable(outer.paneKey)
            continue
          }
          const client = resolveTmuxClientAttachment(outer.root.pid, proof.clients, proof.rows)
          if (!client) {
            continue
          }
          outer.selection = client.pane
          this.project(outer)
        }
      })
    )
  }

  private project(outer: OuterPane): void {
    if (!outer.selection || this.outers.get(outer.paneKey) !== outer) {
      return
    }
    const inner = outer.inner.get(outer.selection)
    const parent = inner && this.options.store().getParent(inner.subject)
    const status = parent?.status
    const key = `${outer.selection}:${parent?.revision ?? 'unavailable'}`
    if (outer.publication === key) {
      return
    }
    outer.publication = key
    const changed = outer.projectedPane !== undefined && outer.projectedPane !== outer.selection
    outer.projectedPane = outer.selection
    if (changed && status) {
      this.options.unavailable(outer.paneKey)
    }
    if (!status) {
      this.options.unavailable(outer.paneKey)
      return
    }
    const payload = normalizeAgentStatusPayload(status)
    if (!payload) {
      return
    }
    const source = status.agentType === 'opencode2' ? 'opencode2' : 'opencode'
    this.options.publish(
      {
        paneKey: outer.paneKey,
        source,
        tabId: status.tabId,
        worktreeId: status.worktreeId,
        connectionId: null,
        launchToken: status.launchToken,
        providerSession: status.providerSession,
        hasExplicitPrompt: status.prompt.length > 0,
        promptInteractionKey: status.promptInteractionKey,
        hookEventName:
          status.state === 'done'
            ? 'SessionIdle'
            : status.state === 'waiting'
              ? status.toolName
                ? 'PermissionRequest'
                : 'AskUserQuestion'
              : 'SessionBusy',
        payload
      },
      status.evidenceObservedAt ?? status.receivedAt
    )
  }

  clearPane(paneKey: string): void {
    const outer = this.outers.get(paneKey)
    if (!outer) {
      return
    }
    this.outers.delete(paneKey)
    for (const { subject } of outer.inner.values()) {
      this.options.store().applyMutation({ removeParent: subject })
    }
    if (this.outers.size === 0) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  clearTab(tabId: string): void {
    for (const paneKey of this.outers.keys()) {
      if (paneKey.startsWith(`${tabId}:`)) {
        this.clearPane(paneKey)
      }
    }
  }

  stop(): void {
    this.stopped = true
    for (const paneKey of this.outers.keys()) {
      this.clearPane(paneKey)
    }
  }
}
