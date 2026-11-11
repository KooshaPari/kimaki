import childProcess from 'node:child_process'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ConfigError } from '../../errors.js'
import { discoverHerdr } from './herdr.js'

const agent = {
  terminal_id: 'term-1', agent: 'codex', agent_status: 'idle',
  workspace_id: 'w1', tab_id: 't1', pane_id: 'w1:p1', focused: true,
  revision: 3, state_change_seq: 2, cwd: 'C:\\project',
  agent_session: { source: 'hook', agent: 'codex', kind: 'id', value: 'native-candidate' },
}
const envelope = (agents: unknown[]) => JSON.stringify({ id: 'cli:agent:list', result: { type: 'agent_list', agents } })

function output(stdout: string) {
  return vi.spyOn(childProcess, 'execFile').mockImplementation((_file, _args, _options, callback) => {
    if (typeof callback === 'function') callback(null, stdout, '')
    return {} as childProcess.ChildProcess
  })
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('discoverHerdr', () => {
  test('invokes only qualified read-only list with a global session flag and bounded execution', async () => {
    const exec = output(envelope([agent]))
    const result = await discoverHerdr({ binary: 'herdr-custom', session: 'work space', timeoutMs: 1234 })
    expect(exec).toHaveBeenCalledExactlyOnceWith('herdr-custom', ['--session', 'work space', 'agent', 'list'],
      expect.objectContaining({ timeout: 1234, maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false }), expect.any(Function))
    expect(result).toEqual({ source: 'herdr', observedAt: expect.any(Number), coverage: 'herdr-managed-panes-only', agents: [
      { terminal_id: 'term-1', agent: 'codex', agent_status: 'idle', workspace_id: 'w1', tab_id: 't1', pane_id: 'w1:p1',
        revision: 3, state_change_seq: 2, cwd: 'C:\\project',
        sessionCandidate: { source: 'hook', agent: 'codex', kind: 'id', value: 'native-candidate' } },
    ] })
  })

  test('default argv has no invented JSON flag and accepts empty inventory', async () => {
    const exec = output(envelope([]))
    expect(await discoverHerdr({})).toMatchObject({ agents: [] })
    expect(exec.mock.calls[0]?.slice(0, 2)).toEqual(['herdr', ['agent', 'list']])
  })

  test('allowlists metadata and retains path references only as unresolved candidates', async () => {
    output(envelope([{ ...agent, title: 'SECRET', transcript: 'SECRET', tokens: { secret: 'SECRET' },
      agent_session: { source: 'report', agent: 'codex', kind: 'path', value: '../private/session.jsonl', transcript: 'SECRET' } }]))
    const result = await discoverHerdr({})
    expect(result).toMatchObject({ agents: [{ sessionCandidate: { kind: 'path', value: '../private/session.jsonl' } }] })
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).not.toContain('nativeSessionId')
  })

  test('optional metadata can be absent or null', async () => {
    output(envelope([{ ...agent, agent: null, cwd: undefined, agent_session: null }]))
    expect(await discoverHerdr({})).toMatchObject({ agents: [{ agent: null }] })
  })

  test.each(['SECRET malformed', 'null', '[]', '{}', '{"result":{"type":"agent_info","agents":[]}}',
    envelope([{ ...agent, terminal_id: 1 }]), envelope([{ ...agent, agent_status: 'invented' }]),
    envelope([{ ...agent, agent_session: { ...agent.agent_session, kind: 'url' } }]),
    envelope([{ ...agent, revision: -1 }])])('rejects malformed or invalid CLI output without leaking it: %s', async (stdout) => {
    output(stdout)
    const result = await discoverHerdr({})
    expect(result).toBeInstanceOf(ConfigError)
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  test.each([0, -1, NaN, Infinity, 60_001])('rejects unsafe timeout %s before spawning', async (timeoutMs) => {
    const exec = output(envelope([]))
    expect(await discoverHerdr({ timeoutMs })).toBeInstanceOf(ConfigError)
    expect(exec).not.toHaveBeenCalled()
  })

  test.each([{ binary: '' }, { binary: 'bad\0binary' }, { session: '' }, { session: 'bad\0session' }])('validates options before spawning: %j', async (options) => {
    const exec = output(envelope([]))
    expect(await discoverHerdr(options)).toBeInstanceOf(ConfigError)
    expect(exec).not.toHaveBeenCalled()
  })

  test('missing executable returns a sanitized error value', async () => {
    const result = await discoverHerdr({ binary: 'kimaki-nonexistent-herdr-fixture-991', timeoutMs: 1000 })
    expect(result).toBeInstanceOf(ConfigError)
    expect(JSON.stringify(result)).not.toContain('stdout')
  })

  test('parses the qualified wire envelope from an isolated executable without a live herdr', async () => {
    const script = `process.stdout.write(${JSON.stringify(envelope([agent]))});process.exit(0)`
    vi.stubEnv('NODE_OPTIONS', `--import=data:text/javascript,${encodeURIComponent(script)}`)
    expect(await discoverHerdr({ binary: process.execPath })).toMatchObject({
      source: 'herdr', agents: [{ terminal_id: 'term-1', sessionCandidate: { kind: 'id', value: 'native-candidate' } }],
    })
  })

  test('nonzero child exit never exposes secret stdout, stderr or captured error cause', async () => {
    const script = 'process.stdout.write("SECRET");process.stderr.write("SECRET");process.exit(1)'
    vi.stubEnv('NODE_OPTIONS', `--import=data:text/javascript,${encodeURIComponent(script)}`)
    const result = await discoverHerdr({ binary: process.execPath })
    expect(result).toBeInstanceOf(ConfigError)
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  test('real isolated child is killed on timeout without exposing output', async () => {
    vi.stubEnv('NODE_OPTIONS', '--import=data:text/javascript,console.log(%22SECRET%22);await%20new%20Promise(()=>setInterval(()=>{},1000))')
    const result = await discoverHerdr({ binary: process.execPath, timeoutMs: 150 })
    expect(result).toBeInstanceOf(ConfigError)
    expect(result).toMatchObject({ reason: expect.stringContaining('timed out') })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  test('real isolated child exceeding output budget returns a sanitized error', async () => {
    vi.stubEnv('NODE_OPTIONS', '--import=data:text/javascript,process.stdout.write(%22SECRET%22.repeat(300000));setInterval(()=>{},1000)')
    const result = await discoverHerdr({ binary: process.execPath, timeoutMs: 3000 })
    expect(result).toBeInstanceOf(ConfigError)
    expect(result).toMatchObject({ reason: expect.stringContaining('output limit') })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })
})
