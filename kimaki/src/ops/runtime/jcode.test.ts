import { describe, expect, it, vi } from 'vitest'
import { createJcodeObserver } from './jcode.js'

describe('Jcode passive discovery', () => {
  it('does not claim or attempt discovery when ACP does not advertise it', async () => {
    const request = vi.fn()
    const observer = createJcodeObserver({ hostId: 'host', endpointId: 'endpoint', initialize: { agentInfo: { name: 'jcode', version: '0.99.1' }, agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } } }, request })
    if (observer instanceof Error) throw observer
    expect(observer.capabilities.discovery.kind).toBe('unsupported')
    expect(observer.capabilities.observe.kind).toBe('unsupported')
    expect(await observer.discover()).toBeInstanceOf(Error)
    expect(request).not.toHaveBeenCalled()
  })
  it('rejects invalid endpoint identity and non-Jcode handshakes', () => {
    expect(createJcodeObserver({ hostId: '', endpointId: 'x', initialize: {}, request: async () => null })).toBeInstanceOf(Error)
    expect(createJcodeObserver({ hostId: 'h', endpointId: 'x', initialize: {}, request: async () => null })).toBeInstanceOf(Error)
  })
})
