import { expect, mock, test } from 'claude-code/testing'

const PLAN = 'mcp__clean-view__plan_steps'
const REPORT = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const

const band = (surface: (typeof SURFACES)[number]) =>
  ({
    plugin: 'clean-view',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: true,
      maxRows: 20,
      bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const

const LONG = 'Organize every single photo from the summer trip into neat albums by city and date'

test('names are cleaned: code, paths and length', async $ => {
  await $.tool.call({
    tool: PLAN,
    steps: ['Build the pricing section in `src/Pricing.tsx`', 'Update src/app/main.ts config', LONG],
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /^Build the pricing section in$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Update config$/ })).toBeDefined()
    const trimmed = await ui.find({ type: 'Text', text: /^Organize every.*…$/ })
    expect(trimmed).toBeDefined()
    expect(trimmed!.text.length).toBeLessThanOrEqual(40)
    await ui.unmount()
  }
})

test('a to-do list and a 60% report draw done, current, next and queued rows', async ($, on) => {
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: 'ok' }))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  })
  await $.tool.call({ tool: REPORT, task: 'Build the pricing section', percent: 60 })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /✓/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▶/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /60%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Concluído/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Próximo/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Na fila/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a permission prompt shows Precisa de você', async ($, on) => {
  mock.clock(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('classic.Notification', () => ({}))
  await $.turn.start({ text: 'Monte minha landing page', turnId: 't1' })
  await $.classic.Notification({
    message: 'Claude needs your permission to use Bash',
    notification_type: 'permission_prompt',
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /Precisa de você/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /precisa do seu OK/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /‖/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/simple off hides the band but keeps the button, and shows tool rows', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('command.run', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  await $.tool.call({ tool: PLAN, steps: ['Read the notes', 'Write the page'] })
  await $.command.run({ command: 'simple', args: 'off' } as never)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /Read the notes/ })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'clean-view-toggle' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /DESLIGADO/ })).toBeDefined()
    await ui.unmount()
  }
  const row = await $.ui.mount({
    plugin: 'clean-view',
    surface: 'terminal',
    component: 'ToolUse',
    props: { tool_use_id: 'toolu_1', tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
  })
  expect(await row.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await row.unmount()
})

test('the button turns Clean View back on', async ($, on) => {
  mock.store(on)
  on('command.run', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  await $.command.run({ command: 'simple', args: 'off' } as never)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'clean-view-toggle' })
  expect(await ui.find({ type: 'Text', text: /LIGADO/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /DESLIGADO/ })).toBeUndefined()
  await ui.unmount()
})

test('plan_steps then a report at 100 checks off step one and starts step two', async $ => {
  const planned = await $.tool.call({ tool: PLAN, steps: ['Read the notes', 'Write the page', 'Check the result'] })
  expect(planned.text ?? JSON.stringify(planned.result)).toMatch(/Planned 3 steps/)
  const reported = await $.tool.call({ tool: REPORT, task: 'Read the notes', percent: 100 })
  expect(reported.text ?? JSON.stringify(reported.result)).toMatch(/100%/)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ type: 'Text', text: /Concluído/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Trabalhando/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Próximo/ })).toBeDefined()
    await ui.unmount()
  }
})

test('tool rows are hidden while on', async $ => {
  for (const surface of SURFACES) {
    const row = await $.ui.mount({
      plugin: 'clean-view',
      surface,
      component: 'ToolUse',
      props: { tool_use_id: 'toolu_1', tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect(await row.find({ type: 'Text' })).toBeUndefined()
    await row.unmount()
  }
})

test('a tool is denied before a plan exists and allowed after', async ($, on) => {
  on('tool.call', { tool: 'Read' }, () => ({ result: 'file contents' }))
  const before = await $.tool.call({ tool: 'Read', file_path: '/tmp/notes.txt' })
  expect(before.isError || before.deny !== undefined).toBe(true)
  expect(before.text ?? before.deny).toMatch(/plan_steps/)
  await $.tool.call({ tool: PLAN, steps: ['Read the notes', 'Write the page'] })
  const after = await $.tool.call({ tool: 'Read', file_path: '/tmp/notes.txt' })
  expect(after.isError).toBeFalsy()
  expect(after.deny).toBeUndefined()
})

test('a finished job gets its Haiku name, says Tudo pronto and shrinks to one line after 5 seconds', async ($, on) => {
  const clock = mock.clock(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: '"Montar a página inicial."', usage: {} } }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.start({ text: 'Monte minha landing page', turnId: 't1' })
  await $.tool.call({ tool: PLAN, steps: ['Read the notes', 'Write the page'] })
  await $.tool.call({ tool: REPORT, task: 'Write the page', percent: 100 })
  await $.turn.complete({ answer: 'Pronto.', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.advance(1)
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /Tudo pronto/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Montar a página inicial · levou/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Read the notes/ })).toBeDefined()
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /Tudo pronto/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Read the notes/ })).toBeUndefined()
  await ui.unmount()
})

test('Esc shows Parado, and an unfinished plan waits for the reply', async ($, on) => {
  mock.clock(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.start({ text: 'Monte minha landing page', turnId: 't1' })
  await $.tool.call({ tool: PLAN, steps: ['Read the notes', 'Write the page'] })
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
  let ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /Parado/ })).toBeDefined()
  await ui.unmount()
  await $.turn.start({ text: 'Outra coisa', turnId: 't2' })
  await $.tool.call({ tool: PLAN, steps: ['Ask a question', 'Write the page'] })
  await $.turn.complete({ answer: 'Qual cor?', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /esperando sua resposta/ })).toBeDefined()
  await ui.unmount()
})
