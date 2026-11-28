import { expect, test } from 'vitest'
import { followNoticeInput } from './ops.ts'

test('follow forwards the kcode profile into the notice request', () => {
  expect(followNoticeInput('kcode')).toEqual({ backend: 'jcode', profile: 'kcode' })
})

test('follow leaves the stock jcode label when no profile is supplied', () => {
  expect(followNoticeInput(undefined)).toEqual({ backend: 'jcode' })
})
