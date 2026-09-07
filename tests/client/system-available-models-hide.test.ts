// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { stripHiddenProviders, type AvailableModelsResponse } from '@/api/hermes/system'

const GROUP = (overrides: Partial<{ provider: string; models: string[] }> = {}) => ({
  provider: overrides.provider ?? 'provider-a',
  label: 'Provider A',
  base_url: 'https://example.com/v1',
  models: overrides.models ?? ['m1', 'm2'],
  api_key: '',
})

describe('stripHiddenProviders', () => {
  it('removes opencode-free from groups while keeping other providers', () => {
    const res: AvailableModelsResponse = {
      default: '',
      default_provider: '',
      groups: [GROUP({ provider: 'opencode-free' }), GROUP({ provider: 'zai' })],
      allProviders: [],
    }
    const out = stripHiddenProviders(res)
    expect(out.groups.map(g => g.provider)).toEqual(['zai'])
  })

  it('removes opencode-free from allProviders', () => {
    const res: AvailableModelsResponse = {
      default: '',
      default_provider: '',
      groups: [],
      allProviders: [GROUP({ provider: 'zai' }), GROUP({ provider: 'opencode-free' })],
    }
    const out = stripHiddenProviders(res)
    expect(out.allProviders.map(g => g.provider)).toEqual(['zai'])
  })

  it('filters opencode-free inside profiles groups', () => {
    const res: AvailableModelsResponse = {
      default: '',
      default_provider: '',
      groups: [],
      allProviders: [],
      profiles: [
        {
          profile: 'default',
          default: '',
          default_provider: '',
          groups: [GROUP({ provider: 'zai' }), GROUP({ provider: 'opencode-free' })],
        },
      ],
    }
    const out = stripHiddenProviders(res)
    expect(out.profiles![0].groups.map(g => g.provider)).toEqual(['zai'])
    expect(out.profiles![0].groups.length).toBe(1)
  })

  it('preserves the rest of the response unchanged', () => {
    const res: AvailableModelsResponse = {
      default: 'm1',
      default_provider: 'zai',
      groups: [GROUP({ provider: 'zai', models: ['m1'] })],
      allProviders: [],
      model_aliases: { zai: { m1: 'Alias' } },
    }
    const out = stripHiddenProviders(res)
    expect(out.default).toBe('m1')
    expect(out.default_provider).toBe('zai')
    expect(out.model_aliases).toEqual({ zai: { m1: 'Alias' } })
    expect(out.groups).toHaveLength(1)
  })
})