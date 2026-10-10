import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Plan } from '../types'

// Catppuccin Mocha
const C = {
  green: '#a6e3a1',
  teal: '#94e2d5',
  red: '#f38ba8',
  maroon: '#eba0ac',
  pink: '#f5c2e7',
  peach: '#fab387',
  mauve: '#cba6f7',
  lavender: '#b4befe',
  text: '#cdd6f4',
  subtext: '#a6adc8',
  overlay: '#6c7086',
  surface: '#313244',
}

const PLAN_TOOL = 'mcp__clean-view__progress'

const isOn = atom({ plugin: 'clean-view', key: 'isOn' } as const, true)
const narration = atom({ plugin: 'clean-view', key: 'narration' } as const, [])
const plan = atom({ plugin: 'clean-view', key: 'plan' } as const, null)
const now = atom({ plugin: 'clean-view', key: 'now' } as const, 0)

// Tools whose own drawing the person has to see to answer.
const KEEP = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'])

const GUIDE = `# Clean view

The person sees a progress band instead of your narration and tool output. Drive it with the \`${PLAN_TOOL}\` tool:
- When a task will take more than one tool call, first call it with \`title\` (the task in a few words) and \`steps\` (2–6 short, outcome-shaped labels in the person's language, e.g. "Ler a configuração atual"), and \`current: 1\`.
- Each time you move to another step, call it with only \`current\` (1-based). Revise \`steps\` if the plan changes.
- Do not narrate between tool calls: the band already says what you are doing. Write prose only for the final answer.`

const base = (path: unknown) => String(path ?? '').split('/').pop() || String(path ?? '')
const cut = (s: unknown, n = 50) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

const actionOf = (tool: string, i: Record<string, unknown>): string => {
  switch (tool) {
    case 'Read':
      return `lendo ${base(i.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `editando ${base(i.file_path)}`
    case 'Write':
      return `escrevendo ${base(i.file_path)}`
    case 'Bash':
      return i.description ? cut(i.description, 40).toLowerCase() : `rodando ${cut(i.command, 30)}`
    case 'Grep':
      return `buscando “${cut(i.pattern, 24)}”`
    case 'Glob':
      return `procurando ${cut(i.pattern, 24)}`
    case 'WebFetch':
    case 'WebSearch':
      return 'pesquisando na web'
    case 'Agent':
    case 'Task':
      return `delegando: ${cut(i.description, 30)}`
    default:
      return tool.startsWith('mcp__') ? tool.split('__')[2] ?? tool : tool.toLowerCase()
  }
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// Linear blend between hex colors along a gradient.
const blend = (stops: string[], t: number) => {
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = stops[i]!
  const b = stops[i + 1]!
  const ch = (h: string, k: number) => parseInt(h.slice(1 + k * 2, 3 + k * 2), 16)
  const mix = [0, 1, 2].map(k => Math.round(ch(a, k) + (ch(b, k) - ch(a, k)) * f))
  return '#' + mix.map(v => v.toString(16).padStart(2, '0')).join('')
}

export const register: Register = on => {
  let isWorking = false

  const bar = (Box: any, Text: any, width: number, filled: number, stops: string[]) => {
    const cells = []
    const full = Math.round(Math.min(1, Math.max(0, filled)) * width)
    for (let k = 0; k < width; k++) {
      cells.push(
        <Text color={k < full ? blend(stops, k / Math.max(1, width - 1)) : C.surface}>█</Text>,
      )
    }
    return <Box flexDirection="row">{cells}</Box>
  }

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('isOn')
    if (typeof saved === 'boolean') await update($, isOn, () => saved)
    await $.command.register({
      name: 'clean',
      description: 'Liga/desliga o clean view (painel de passos em vez de narração)',
    })
    await $.tool.register({
      name: 'progress',
      description:
        'Updates the progress band the person watches. Set `title` and `steps` when starting a multi-step task, then `current` (1-based) whenever you move to another step.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The task in a few words' },
          steps: { type: 'array', items: { type: 'string' }, description: '2–6 short step labels' },
          current: { type: 'number', description: 'The step now being worked on, 1-based' },
        },
        required: ['current'],
      },
    })
    $.clock.every(1000, () => {
      if (isWorking) void update($, now, () => Date.now())
    })
    return next(e)
  })

  on('command.run', { command: 'clean' }, async $ => {
    const v = await update($, isOn, x => !x)
    await $.store.set('isOn', v)
    return { text: v ? 'Clean view ligado.' : 'Clean view desligado.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(await read($, isOn))) return r
    return { sections: [...r.sections, { id: 'clean-view:guide', text: GUIDE, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    const at = Date.now()
    await update($, now, () => at)
    await update($, plan, () => ({
      title: cut(e.text.split('\n')[0], 60),
      steps: [],
      current: 0,
      isDone: false,
      startedAt: at,
      endedAt: null,
      calls: [],
      action: '',
    }))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    isWorking = false
    const at = Date.now()
    await update($, now, () => at)
    await update($, plan, p =>
      p && { ...p, isDone: !e.isAborted, current: e.isAborted ? p.current : p.steps.length, endedAt: at, action: '' },
    )
    return next(e)
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e) => {
    if (!e.agentId) {
      const steps = Array.isArray(e.steps) ? e.steps.map(s => cut(s, 60)).slice(0, 8) : undefined
      const title = typeof e.title === 'string' ? cut(e.title, 60) : undefined
      const current = Math.max(1, Math.floor(Number(e.current) || 1))
      await update($, plan, p => {
        const base: Plan = p ?? {
          title: '', steps: [], current: 0, isDone: false, startedAt: Date.now(), endedAt: null, calls: [], action: '',
        }
        const list = steps ?? base.steps
        return {
          ...base,
          title: title ?? base.title,
          steps: list,
          current: Math.min(current, Math.max(1, list.length)),
          calls: list.map((_, k) => base.calls[k] ?? 0),
        }
      })
    }
    return { result: { content: [{ type: 'text' as const, text: 'ok' }] } }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId || e.tool === PLAN_TOOL) return next(e)
    const action = actionOf(String(e.tool), e as Record<string, unknown>)
    await update($, plan, p => {
      if (!p) return p
      const calls = [...p.calls]
      if (p.current > 0) calls[p.current - 1] = (calls[p.current - 1] ?? 0) + 1
      return { ...p, calls, action }
    })
    return next(e)
  })

  // A response that also called tools is narration: its text is hidden.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const said = r.answer.trim()
    if (r.toolUses.length > 0 && said) {
      await update($, narration, list => [...list, said].slice(-400))
    }
    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text.trim()
    if (!text || !(await read($, isOn))) return next(e)
    const list = await read($, narration)
    if (!list.some(said => said.includes(text))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (KEEP.has(e.props.tool) || !(await read($, isOn))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (KEEP.has(e.props.tool) || !(await read($, isOn))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || !(await read($, isOn))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId || !(await read($, isOn))) return next(e)
    const p = await read($, plan)
    if (!p) return next(e)
    const t = await read($, now)
    const { Box, Text } = $.ui.resolve(e)

    const total = p.steps.length
    const doneCount = p.isDone ? total : Math.max(0, p.current - 1)
    const pct = total ? Math.round((doneCount / total) * 100) : p.isDone ? 100 : 0
    const elapsed = clock((p.endedAt ?? t) - p.startedAt)
    const inner = Math.max(30, e.props.bodyColumns - 4)
    const labelW = Math.min(44, Math.max(...p.steps.map(s => s.length), 10) + 2)
    const miniW = 12
    const headW = Math.max(10, inner - 20)
    const accent = p.isDone ? C.green : C.pink

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={accent}>{p.isDone ? '✓ ' : '✦ '}</Text>
          <Text color={C.mauve} bold>
            {p.title || 'Trabalhando'}
          </Text>
        </Text>
        <Text color={C.subtext}>{elapsed}</Text>
      </Box>
    )

    if (total === 0) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
          {header}
          <Text color={C.subtext} wrap="truncate-end">
            {p.isDone ? 'Concluído' : p.action ? `● ${p.action}` : '● pensando…'}
          </Text>
        </Box>
      )
    }

    const summary = (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={C.text}>{p.isDone ? `${total} de ${total} passos  ` : `Passo ${p.current} de ${total}  `}</Text>
          {bar(Box, Text, Math.min(40, headW), p.isDone ? 1 : doneCount / total + 0.5 / total, [C.peach, C.red, C.pink])}
        </Box>
        <Text color={accent} bold>{`${pct}%`}</Text>
      </Box>
    )

    const rows = p.steps.map((label, k) => {
      const n = k + 1
      const state = p.isDone || n < p.current ? 'done' : n === p.current ? 'work' : 'next'
      const icon = state === 'done' ? '✓' : state === 'work' ? '●' : '○'
      const iconColor = state === 'done' ? C.green : state === 'work' ? C.pink : C.overlay
      const word =
        state === 'done' ? 'Concluído' : state === 'work' ? 'Em andamento' : n === p.current + 1 ? 'Próximo' : 'Na fila'
      const calls = p.calls[k] ?? 0
      const fill = state === 'done' ? 1 : state === 'work' ? Math.min(0.9, (calls + 1) / miniW) : 0
      return (
        <Box flexDirection="row">
          <Text color={iconColor}>{`${icon} `}</Text>
          <Box width={labelW}>
            <Text color={state === 'next' ? C.subtext : C.text} bold={state === 'work'} wrap="truncate-end">
              {label}
            </Text>
          </Box>
          {bar(Box, Text, miniW, fill, state === 'done' ? [C.green, C.teal] : [C.maroon, C.pink])}
          <Text color={state === 'work' ? C.pink : state === 'done' ? C.green : C.overlay} bold={state === 'work'}>
            {`  ${word}`}
          </Text>
          {state === 'work' && p.action ? (
            <Text color={C.overlay} wrap="truncate-end">{` · ${p.action}`}</Text>
          ) : null}
        </Box>
      )
    })

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
        {header}
        {summary}
        {rows}
      </Box>
    )
  })
}
