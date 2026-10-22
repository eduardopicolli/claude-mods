import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { Checklist, Phase, Task } from '../types'

// Dark Modern Soft (VS Code)
const C = {
  green: '#6AC483',
  teal: '#4FB0A6',
  red: '#E4506F',
  yellow: '#E8BD5F',
  blue: '#4690D2',
  link: '#51AED6',
  cyan: '#68CBE6',
  text: '#D4D6DD',
  subtext: '#AEB0B6',
  overlay: '#84858A',
  surface: '#3B3C3E',
  track: '#2E2F33',
  crust: '#1D1E22',
}

const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const REPORT_TOOL = 'mcp__clean-view__report_progress'

// Tools that never wait for a plan: loading the plan tools, the to-do lists
// that can stand in for a plan, and asking the person.
const UNGATED = new Set([PLAN_TOOL, REPORT_TOOL, 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion'])

// The person has to read the plan to approve it.
const KEEP_VISIBLE = new Set(['ExitPlanMode'])

const enabled = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklist = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tick = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

const PLACEHOLDERS = ['Entender seu pedido', 'Planejar os passos']
const FIRST_TITLE = 'Trabalhando no seu pedido'
const FALLBACK_NAME = 'Trabalhando nisso'
const MAX_NAME = 40
const METER = 10
const SWEEP = 5
const LABEL_W = 11
const FRAME_MS = 250
const COLLAPSE_MS = 5000
const FAILS_TO_STUCK = 3

const SAY = {
  needsOk: 'O Claude precisa do seu OK para continuar',
  question: 'O Claude tem uma pergunta para você',
  waiting: 'O Claude está esperando sua resposta',
  saidNo: 'você recusou uma etapa, então o Claude pausou',
  keepsFailing: 'uma etapa continua falhando, o Claude está tentando outro caminho',
  refused: 'o Claude não pôde ajudar com esse pedido',
  rateLimit: 'você atingiu seu limite de uso, tente de novo daqui a pouco',
  overloaded: 'os servidores do Claude estão ocupados, tente de novo em um minuto',
  tooLong: 'a conversa ficou longa demais, digite /compact e tente de novo',
  network: 'a conexão com a internet caiu',
  auth: 'sua sessão expirou, digite /login',
  unknown: 'algo deu errado do lado do Claude, tente de novo',
}

const GUIDE = `# Clean View

The person sees a simple checklist above the prompt instead of your tool calls. Keep it filled:
- For every request, even a quick question, first call \`${PLAN_TOOL}\` with every step of the job, 2 to 8 short names in order (load it with ToolSearch if it is deferred). Every other tool is refused until a plan exists.
- Then call \`${REPORT_TOOL}\` as real progress happens, and with percent 100 the moment a step finishes.
- If this session has TodoWrite or TaskCreate, your to-do list can be the plan instead.
- Write every step name in plain words a non-technical person understands, in the language the person writes in. Keep it under 40 characters and start it with a verb, like "Montar a seção de preços".
- Never put file paths, file names, commands, code or tool names in a step name.`

const GATE = `Clean View: call ${PLAN_TOOL} first with the steps of this job (load it with ToolSearch if it is deferred), then retry.`

const CODE_EXT =
  'tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|fish|ps1|lua|sql|' +
  'json|jsonc|ya?ml|toml|ini|env|lock|md|mdx|html?|css|scss|sass|less|vue|svelte|xml|gradle|dart|ex|exs|zig'
const CODE_FILE = new RegExp(`[\\w.-]*\\.(?:${CODE_EXT})\\b`, 'gi')

/** The one cleaner every name on the checklist passes through. */
export const cleanName = (raw: unknown): string => {
  const plain = String(raw ?? '')
    .replace(/`[^`]*`?/g, ' ')
    .replace(/\S*[/\\]\S*/g, ' ')
    .replace(CODE_FILE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return FALLBACK_NAME
  const named = plain[0]!.toUpperCase() + plain.slice(1)
  if (named.length <= MAX_NAME) return named
  const head = named.slice(0, MAX_NAME - 1)
  const space = head.lastIndexOf(' ')
  return (space > 0 ? head.slice(0, space) : head).replace(/[\s,.;:–-]+$/, '') + '…'
}

const errorSentence = (kind: string | undefined, text: string): string => {
  const said = `${kind ?? ''} ${text}`
  if (/prompt is too long|context|too many tokens|max_output/i.test(said)) return SAY.tooLong
  if (/rate_limit|billing|usage limit|\b429\b/i.test(said)) return SAY.rateLimit
  if (/overloaded|server_error|\b5(?:00|02|03|29)\b/i.test(said)) return SAY.overloaded
  if (/auth|oauth|credential|login|\b401\b|\b403\b|account_on_hold|verification/i.test(said)) return SAY.auth
  if (/ECONN|ENOTFOUND|ETIMEDOUT|network|fetch failed|socket|offline|connection/i.test(said)) return SAY.network
  return SAY.unknown
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

// The meter gradient of each phase, so a paused or failed step stops looking busy.
const GRAD: Record<Phase, string[]> = {
  working: [C.blue, C.cyan],
  needsYou: [C.yellow, blend([C.yellow, '#FFFFFF'], 0.45)],
  stuck: [C.red, blend([C.red, '#FFFFFF'], 0.4)],
  stopped: [C.overlay, C.subtext],
  done: [C.green, C.teal],
}

let nextId = 0
const task = (name: string, status: Task['status'] = 'upcoming'): Task => ({
  id: `step-${++nextId}`,
  name,
  status,
  percent: status === 'done' ? 100 : 0,
  hasReported: status === 'done',
})

const done = (t: Task): Task => ({ ...t, status: 'done', percent: 100, hasReported: true })

// With nothing active, the first step not yet done starts.
const withActive = (tasks: Task[]): Task[] => {
  if (tasks.some(t => t.status === 'active')) return tasks
  const k = tasks.findIndex(t => t.status === 'upcoming')
  return k < 0 ? tasks : tasks.map((t, i) => (i === k ? { ...t, status: 'active', percent: 0, hasReported: false } : t))
}

const working = (c: Checklist): Checklist => ({
  ...c,
  phase: 'working',
  needsYouReason: null,
  stuckReason: null,
  finishedAt: null,
  isCollapsed: false,
})

const newJob = (jobId: number, at: number): Checklist => ({
  jobId,
  title: FIRST_TITLE,
  phase: 'working',
  tasks: withActive(PLACEHOLDERS.map(name => task(name))),
  hasPlan: false,
  needsYouReason: null,
  stuckReason: null,
  startedAt: at,
  finishedAt: null,
  isCollapsed: false,
})

const ensure = (c: Checklist | null): Checklist => c ?? newJob(1, Date.now())

/** The real steps so far: none while the placeholders are showing. */
const realTasks = (c: Checklist) => (c.hasPlan ? c.tasks : [])

export const applyPlan = (c: Checklist, names: string[]): Checklist => {
  const wasDone = new Set(realTasks(c).filter(t => t.status === 'done').map(t => t.name.toLowerCase()))
  const tasks = names.map(name => task(name, wasDone.has(name.toLowerCase()) ? 'done' : 'upcoming'))
  return { ...working(c), tasks: withActive(tasks), hasPlan: true }
}

export const applyReport = (c: Checklist, name: string, percent: number): Checklist => {
  let tasks = [...realTasks(c)]
  let k = tasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase())
  if (k < 0) {
    // A step the plan did not name goes where the work is now.
    const at = tasks.findIndex(t => t.status !== 'done')
    k = at < 0 ? tasks.length : at
    tasks.splice(k, 0, task(name))
  }
  tasks = tasks.map((t, i): Task => {
    if (i < k) return done(t)
    if (i === k) return { ...t, status: 'active', percent, hasReported: true }
    return t.status === 'active' ? { ...t, status: 'upcoming' } : t
  })
  if (percent >= 100) {
    tasks[k] = done(tasks[k]!)
    tasks = withActive(tasks)
  }
  return { ...working(c), tasks, hasPlan: true }
}

type Todo = { content?: unknown; status?: unknown }

const applyTodos = (c: Checklist, todos: readonly Todo[]): Checklist => {
  const before = realTasks(c)
  const tasks = todos.map((todo): Task => {
    const name = cleanName(todo.content)
    const was = before.find(t => t.name === name)
    if (todo.status === 'completed') return { ...done(was ?? task(name)), name }
    if (todo.status === 'in_progress') {
      const isSame = was?.status === 'active'
      return {
        id: was?.id ?? task(name).id,
        name,
        status: 'active',
        percent: isSame ? was.percent : 0,
        hasReported: isSame ? was.hasReported : false,
      }
    }
    return { ...(was ?? task(name)), name, status: 'upcoming', percent: 0, hasReported: false }
  })
  return { ...working(c), tasks: withActive(tasks), hasPlan: true }
}

const addTask = (c: Checklist, id: string, name: string): Checklist => {
  const tasks = [...realTasks(c).filter(t => t.id !== id), { ...task(name), id }]
  return { ...working(c), tasks: withActive(tasks), hasPlan: true }
}

const changeTask = (c: Checklist, id: string, status: unknown, subject: unknown): Checklist => {
  const isRenamed = typeof subject === 'string' && subject.trim() !== ''
  let tasks = realTasks(c)
    .filter(t => !(t.id === id && status === 'deleted'))
    .map((t): Task => {
      if (t.id !== id) return status === 'in_progress' && t.status === 'active' ? { ...t, status: 'upcoming' } : t
      const named = isRenamed ? { ...t, name: cleanName(subject) } : t
      if (status === 'completed') return done(named)
      if (status === 'in_progress') return { ...named, status: 'active' }
      if (status === 'pending') return { ...named, status: 'upcoming', percent: 0, hasReported: false }
      return named
    })
  tasks = withActive(tasks)
  return { ...working(c), tasks, hasPlan: true }
}

const finish = (c: Checklist, phase: Phase, reason: string | null = null): Checklist => ({
  ...c,
  phase,
  needsYouReason: phase === 'needsYou' ? reason : null,
  stuckReason: phase === 'stuck' ? reason : null,
  tasks: phase === 'done' ? c.tasks.map(done) : c.tasks,
  finishedAt: c.finishedAt ?? Date.now(),
  isCollapsed: false,
})

const toText = (text: string) => ({ result: [{ type: 'text' as const, text }] })

let timer: Timer | null = null
let failStreak = 0
let apiError: string | null = null

// The frame clock runs only while a job works or waits on the person.
function syncClock($: EngineInterface, c: Checklist | null) {
  const isLive = c?.phase === 'working' || c?.phase === 'needsYou'
  if (isLive && !timer) {
    timer = $.clock.every(FRAME_MS, () => void update($, tick, n => n + 1))
  } else if (!isLive && timer) {
    timer.cancel()
    timer = null
  }
}

async function change($: EngineInterface, fn: (c: Checklist | null) => Checklist | null) {
  const c = await update($, checklist, fn)
  syncClock($, c)
  return c
}

async function setEnabled($: EngineInterface, want?: boolean) {
  const v = await update($, enabled, x => want ?? !x)
  await $.store.set('cleanViewEnabled', v)
  return v
}

async function nameJob($: EngineInterface, jobId: number, request: string) {
  try {
    const r = await $.model.complete({
      model: 'haiku',
      effort: 'low',
      maxTokens: 40,
      timeoutMs: 20000,
      system:
        'Name the job the request below asks for, in 2 to 6 plain words a non-technical person understands, ' +
        'starting with a verb, in the language the request is written in (e.g. "Montar a página inicial"). ' +
        'No file names, paths, code, quotes or final period. Reply with the name only.',
      prompt: request.slice(0, 4000),
    })
    if (!r.isAnswered) return
    const words = cleanName(r.text.split('\n')[0]!.replace(/["“”'*.]/g, '')).split(' ')
    const title = words.slice(0, 6).join(' ')
    await change($, c => (c && c.jobId === jobId ? { ...c, title } : c))
  } catch {
    // The placeholder title stays.
  }
}

export const registerCleanView = (on: On) => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('cleanViewEnabled')) ?? (await $.store.get('isOn'))
    if (typeof saved === 'boolean') await update($, enabled, () => saved)
    await $.command.register({
      name: 'simple',
      description: 'Liga ou desliga o Clean View (on, off, ou sem nada para alternar)',
      argumentHint: 'on|off',
    })
    await $.tool.register({
      name: 'plan_steps',
      isDeferred: false,
      description:
        'Lays out every step of the job up front for the checklist the person watches: 2 to 8 short names in order, ' +
        'plain words starting with a verb, under 40 characters, no paths, files, commands, code or tool names. The first step starts right away.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: 'The step names, in order' },
        },
        required: ['steps'],
      },
    })
    await $.tool.register({
      name: 'report_progress',
      isDeferred: false,
      description:
        'Reports progress on a step of the checklist. Every step before it is checked off; at 100 it is checked off and the next one starts. ' +
        'A name not in the plan becomes a new step.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The step name, as planned' },
          percent: { type: 'number', description: 'How far along the step is, 0 to 100' },
        },
        required: ['task', 'percent'],
      },
    })
    syncClock($, await read($, checklist))
    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const want = ['on', 'ligar', 'ligado'].includes(arg)
      ? true
      : ['off', 'desligar', 'desligado'].includes(arg)
        ? false
        : undefined
    if (arg && want === undefined) return { text: 'Use /simple on, /simple off, ou só /simple para alternar.' }
    const v = await setEnabled($, want)
    return { text: v ? 'Clean View ligado.' : 'Clean View desligado: tudo volta a aparecer.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(await read($, enabled))) return r
    return { sections: [...r.sections, { id: 'clean-view:guide', text: GUIDE, scope: 'session' as const }] }
  })

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    const c = await read($, checklist)
    const isReply = c?.phase === 'needsYou' && c.hasPlan && c.tasks.some(t => t.status !== 'done')
    if (text && !text.startsWith('/') && !isReply) {
      const jobId = (c?.jobId ?? 0) + 1
      failStreak = 0
      apiError = null
      await change($, () => newJob(jobId, Date.now()))
      if (await read($, enabled)) $.clock.after(1, () => void nameJob($, jobId, text))
    } else if (c && c.phase !== 'done') {
      apiError = null
      await change($, x => x && working(x))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>

    if (tool === PLAN_TOOL) {
      const names = (Array.isArray(args.steps) ? args.steps : []).map(cleanName).slice(0, 8)
      if (names.length === 0) return { deny: 'plan_steps needs at least one step name.' }
      if (!e.agentId) await change($, c => applyPlan(ensure(c), names))
      return toText(`Planned ${names.length} steps. The first one has started.`)
    }
    if (tool === REPORT_TOOL) {
      const percent = Math.round(Math.min(100, Math.max(0, Number(args.percent) || 0)))
      if (!e.agentId) await change($, c => applyReport(ensure(c), cleanName(args.task), percent))
      return toText(`Progress noted: ${percent}%.`)
    }
    if (e.agentId) return next(e)

    const c = await read($, checklist)
    if (!UNGATED.has(tool) && !c?.hasPlan && (await read($, enabled))) return { deny: GATE }

    if (tool === 'AskUserQuestion') {
      await change($, x => x && { ...working(x), phase: 'needsYou', needsYouReason: SAY.question })
    } else if (c?.phase === 'needsYou') {
      await change($, x => x && working(x))
    }

    const r = await next(e)
    if (r.deny !== undefined) return r

    if (r.isError) {
      if (/doesn't want to proceed|was rejected|user rejected|user denied/i.test(r.text ?? '')) {
        failStreak = 0
        await change($, x => x && { ...working(x), phase: 'stuck', stuckReason: SAY.saidNo })
      } else if (++failStreak >= FAILS_TO_STUCK) {
        await change($, x => x && { ...working(x), phase: 'stuck', stuckReason: SAY.keepsFailing })
      }
      return r
    }

    failStreak = 0
    if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
      await change($, x => applyTodos(ensure(x), args.todos as Todo[]))
    } else if (tool === 'TaskCreate') {
      const made = r.result as { task?: { id?: unknown } } | undefined
      const id = String(made?.task?.id ?? /#(\d+)/.exec(r.text ?? '')?.[1] ?? `task-${Date.now()}`)
      await change($, x => addTask(ensure(x), id, cleanName(args.subject)))
    } else if (tool === 'TaskUpdate') {
      await change($, x => changeTask(ensure(x), String(args.taskId), args.status, args.subject))
    } else {
      await change($, x => (x && (x.phase === 'stuck' || x.phase === 'needsYou') ? working(x) : x))
    }
    return r
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const isAsking =
      e.notification_type === 'permission_prompt' ||
      e.notification_type === 'elicitation_dialog' ||
      /permission/i.test(e.message)
    if (isAsking) {
      await change($, c => (c && c.phase !== 'done' ? { ...working(c), phase: 'needsYou', needsYouReason: SAY.needsOk } : c))
    }
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    apiError = errorSentence(e.error, e.error_details ?? '')
    await change($, c => c && finish({ ...c, phase: 'stuck' }, 'stuck', apiError))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    const c = await read($, checklist)
    if (c) {
      let after: Checklist
      if (e.reason === 'error') {
        after = finish(c, 'stuck', apiError ?? errorSentence(undefined, e.answer))
      } else if (e.reason === 'refusal') {
        after = finish(c, 'stuck', SAY.refused)
      } else if (e.isAborted) {
        after = c.stuckReason === SAY.saidNo ? finish(c, 'stuck', SAY.saidNo) : finish(c, 'stopped')
      } else if (c.hasPlan && c.tasks.some(t => t.status !== 'done')) {
        after = finish(c, 'needsYou', SAY.waiting)
      } else {
        after = finish(c, 'done')
        const jobId = c.jobId
        $.clock.after(COLLAPSE_MS, () => {
          void change($, x => (x && x.jobId === jobId && x.phase === 'done' ? { ...x, isCollapsed: true } : x))
        })
      }
      apiError = null
      await change($, () => after)
    }
    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (KEEP_VISIBLE.has(e.props.tool) || !(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (KEEP_VISIBLE.has(e.props.tool) || !(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await read($, enabled)) ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isOn = await read($, enabled)

    const toggle = (
      <Button
        key="clean-view-toggle"
        plain
        onPress={async () => {
          const v = await setEnabled($)
          $.ui.toast(v ? 'Clean View ligado' : 'Clean View desligado: mostrando tudo')
        }}
      >
        <Text color={isOn ? C.green : C.overlay}>{`[ ● Clean View: ${isOn ? 'LIGADO' : 'DESLIGADO'} ]`}</Text>
      </Button>
    )

    const c = await read($, checklist)
    if (!isOn) {
      const below = await next(e)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="flex-end">
            {toggle}
          </Box>
          {below}
        </Box>
      )
    }
    if (!c) {
      return (
        <Box flexDirection="row" justifyContent="flex-end">
          {toggle}
        </Box>
      )
    }

    const frame = await read($, tick)
    const elapsed = clock((c.finishedAt ?? Date.now()) - c.startedAt)

    const head = (() => {
      switch (c.phase) {
        case 'needsYou':
          return (
            <Text wrap="truncate-end">
              <Text backgroundColor={C.yellow} color={C.crust} bold>
                {' Precisa de você '}
              </Text>
              <Text color={C.yellow}>{` ${c.needsYouReason ?? SAY.needsOk}`}</Text>
            </Text>
          )
        case 'stuck':
          return (
            <Text wrap="truncate-end">
              <Text color={C.red} bold>
                {'⚠ Travou: '}
              </Text>
              <Text color={C.text}>{c.stuckReason ?? SAY.unknown}</Text>
            </Text>
          )
        case 'stopped':
          return (
            <Text wrap="truncate-end">
              <Text color={C.overlay} bold>
                {'■ Parado'}
              </Text>
              <Text color={C.subtext}>{` · ${c.title} · você apertou Esc`}</Text>
            </Text>
          )
        case 'done':
          return (
            <Text wrap="truncate-end">
              <Text color={C.green} bold>
                {'✓ Tudo pronto'}
              </Text>
              <Text color={C.subtext}>{` · ${c.title} · levou ${elapsed}`}</Text>
            </Text>
          )
        default:
          return (
            <Text wrap="truncate-end">
              <Text color={C.link} bold>
                {c.title}
              </Text>
              <Text color={C.subtext}>{` · ${elapsed}`}</Text>
            </Text>
          )
      }
    })()

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>{head}</Box>
        <Box flexShrink={0} marginLeft={1}>
          {toggle}
        </Box>
      </Box>
    )

    if (c.phase === 'done' && c.isCollapsed) return header

    const accent = { working: C.blue, needsYou: C.yellow, stuck: C.red, stopped: C.overlay, done: C.green }[c.phase]
    const inner = Math.max(20, e.props.bodyColumns - 4)
    const room = inner - 2 - 1 - METER - 2 - LABEL_W
    const longest = Math.max(...c.tasks.map(t => t.name.length), 6)
    const nameW = Math.max(6, Math.min(room, longest + 1, MAX_NAME + 1))
    const firstUpcoming = c.tasks.findIndex(t => t.status === 'upcoming')

    const meter = (t: Task) => {
      const cells: string[] = []
      const grad = GRAD[t.status === 'done' ? 'done' : c.phase]
      for (let k = 0; k < METER; k++) {
        const at = k / (METER - 1)
        if (t.status === 'done') {
          cells.push(blend(grad, at))
        } else if (t.status === 'active' && t.hasReported) {
          cells.push(k < Math.round(t.percent / 10) ? blend(grad, at) : C.track)
        } else if (t.status === 'active') {
          // No percent yet: a sweep, bright at its head, fades into the track so its edges never cut hard.
          const head = frame % (METER + SWEEP)
          const gap = head - k
          cells.push(gap >= 0 && gap < SWEEP ? blend([C.track, ...grad], 1 - gap / SWEEP) : C.track)
        } else {
          cells.push(C.track)
        }
      }
      return (
        <Text>
          {cells.map(color => (
            <Text color={color}>█</Text>
          ))}
        </Text>
      )
    }

    const rows = c.tasks.map((t, k) => {
      const isActive = t.status === 'active'
      const icon =
        t.status === 'done' ? '✓' : !isActive ? '○' : c.phase === 'needsYou' ? '‖' : c.phase === 'stopped' ? '■' : '▶'
      const iconColor =
        t.status === 'done'
          ? C.green
          : !isActive
            ? C.overlay
            : { working: C.link, needsYou: C.yellow, stuck: C.red, stopped: C.overlay, done: C.green }[c.phase]
      const label =
        t.status === 'done'
          ? 'Concluído'
          : isActive
            ? t.hasReported
              ? `${t.percent}%`
              : 'Trabalhando'
            : k === firstUpcoming
              ? 'Próximo'
              : 'Na fila'
      const labelColor = t.status === 'done' ? C.green : isActive ? iconColor : k === firstUpcoming ? C.subtext : C.overlay
      return (
        <Box key={t.id} flexDirection="row">
          <Text color={iconColor}>{`${icon} `}</Text>
          <Box width={nameW} flexShrink={0}>
            <Text
              color={t.status === 'done' ? C.subtext : isActive ? C.text : C.overlay}
              dimColor={t.status === 'done'}
              bold={isActive}
              wrap="truncate-end"
            >
              {t.name}
            </Text>
          </Box>
          <Text> </Text>
          {meter(t)}
          <Text color={labelColor} bold={isActive}>{`  ${label}`}</Text>
        </Box>
      )
    })

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1}>
        {header}
        {rows}
      </Box>
    )
  })
}
