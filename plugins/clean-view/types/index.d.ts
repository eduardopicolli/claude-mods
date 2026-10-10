export type TaskStatus = 'done' | 'active' | 'upcoming'

export type Task = {
  id: string
  name: string
  status: TaskStatus
  percent: number
  hasReported: boolean
}

export type Phase = 'working' | 'needsYou' | 'stuck' | 'stopped' | 'done'

export type Checklist = {
  /** Grows with each new job, so a late answer for an older job is ignored. */
  jobId: number
  title: string
  phase: Phase
  tasks: Task[]
  /** False while the rows are still the placeholders shown before a plan. */
  hasPlan: boolean
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  finishedAt: number | null
  isCollapsed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: Checklist | null
      tick: number
    }
  }
}
