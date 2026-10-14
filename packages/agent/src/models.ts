import type { ProviderId } from './auth.js'

const DEFAULTS: Record<ProviderId, string> = {
  anthropic: 'anthropic/claude-sonnet-5-5',
  openai: 'openai/gpt-5.5',
  google: 'google/gemini-3.1-pro-preview',
  openrouter: 'openrouter/anthropic/claude-sonnet-5.5'
}

export function defaultModel(p: ProviderId): string {
  return DEFAULTS[p]
}

export function resolveModel(env: NodeJS.ProcessEnv, p: ProviderId): string {
  return env.IRONFLOW_AGENT_MODEL || DEFAULTS[p]
}
