import { expect, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('tool rows and results are hidden', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const row = await $.ui.mount({
      plugin: 'clean-view',
      surface,
      component: 'ToolUse',
      props: {
        tool_use_id: 'toolu_1',
        tool: 'Read',
        input: { file_path: '/home/x/src/foo.ts' },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      },
    })
    expect(await row.find({ type: 'Text' })).toBeUndefined()
    await row.unmount()
  }
})

test('the band draws the plan the model set', async $ => {
  await $.tool.call({
    tool: 'mcp__clean-view__progress',
    title: 'Montar o dashboard',
    steps: ['Ler a config', 'Escrever o código', 'Testar'],
    current: 2,
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'clean-view', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: 'Montar o dashboard' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Passo 2 de 3/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Em andamento/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Concluído/ })).toBeDefined()
    await band.unmount()
  }
})

test('a reply that is not narration is drawn as is', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => ({
    type: 'Text',
    props: {},
    children: ['engine reply'],
  }))
  const msg = await $.ui.mount({
    plugin: 'clean-view',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: 'Pronto, tudo certo.', isFirstOfReply: true },
  })
  expect(await msg.find({ type: 'Text', text: 'engine reply' })).toBeDefined()
  await msg.unmount()
})
