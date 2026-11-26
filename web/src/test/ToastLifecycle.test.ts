import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bdHideToast, bdShowToast, bdToast } from '../composables/useBunDeckUi'

describe('global toast lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    bdHideToast()
  })

  afterEach(() => {
    bdHideToast()
    vi.useRealTimers()
  })

  it('automatically hides a toast after its finite display duration', () => {
    bdShowToast('Calendar is not configured')
    expect(bdToast.value?.message).toBe('Calendar is not configured')

    vi.advanceTimersByTime(5999)
    expect(bdToast.value).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(bdToast.value).toBeNull()
  })

  it('does not keep extending the deadline when the same error repeats', () => {
    bdShowToast('Calendar is not configured')
    vi.advanceTimersByTime(4000)

    // Repeated polling/WS errors should not perpetually renew this toast.
    bdShowToast('Calendar is not configured')
    vi.advanceTimersByTime(2000)
    expect(bdToast.value).toBeNull()
  })

  it('a stale timer cannot hide a newer toast', () => {
    bdShowToast('First message')
    vi.advanceTimersByTime(5000)
    bdShowToast('Second message')

    vi.advanceTimersByTime(1000)
    expect(bdToast.value?.message).toBe('Second message')
    vi.advanceTimersByTime(5000)
    expect(bdToast.value).toBeNull()
  })

  it('bounds explicit durations so no caller can create a permanent toast', () => {
    bdShowToast('Long error', undefined, 60_000)
    vi.advanceTimersByTime(6000)
    expect(bdToast.value).not.toBeNull()
    vi.advanceTimersByTime(4000)
    expect(bdToast.value).toBeNull()
  })
})
