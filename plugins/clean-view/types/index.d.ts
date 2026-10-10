export type Plan = {
  title: string
  steps: string[]
  current: number
  isDone: boolean
  startedAt: number
  endedAt: number | null
  calls: number[]
  action: string
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      isOn: boolean
      narration: string[]
      plan: Plan | null
      now: number
    }
  }
}
