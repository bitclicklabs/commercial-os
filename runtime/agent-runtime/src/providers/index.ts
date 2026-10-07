import { AnthropicProvider } from './anthropic-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import type { ModelProvider } from './model-provider.js';
import { StubProvider } from './stub-provider.js';

export * from './model-provider.js';
export { StubProvider } from './stub-provider.js';
export { AnthropicProvider, ANTHROPIC_PRICING, DEFAULT_ANTHROPIC_MODEL } from './anthropic-provider.js';
export { GeminiProvider, GeminiApiError, DEFAULT_GEMINI_MODEL, geminiUsage } from './gemini-provider.js';
export * from './gemini-pricing.js';

export const MODEL_PROVIDERS = ['stub', 'anthropic', 'gemini'] as const;
export type ModelProviderName = (typeof MODEL_PROVIDERS)[number];

export type ProviderFactory = (name: string) => ModelProvider;

export interface ProviderRegistryOptions {
  anthropicApiKey?: string | undefined;
  geminiApiKey?: string | undefined;
  /** Default Gemini model when the agent version has none (GEMINI_MODEL). */
  geminiModel?: string | undefined;
}

/** Lazily instantiates providers by name; network clients are only built when first needed. */
export function createProviderRegistry(opts: ProviderRegistryOptions = {}): ProviderFactory {
  const cache = new Map<string, ModelProvider>();
  return (name: string) => {
    const existing = cache.get(name);
    if (existing) return existing;
    let provider: ModelProvider;
    switch (name) {
      case 'stub':
        provider = new StubProvider();
        break;
      case 'anthropic':
        provider = new AnthropicProvider(opts.anthropicApiKey ? { apiKey: opts.anthropicApiKey } : {});
        break;
      case 'gemini':
        provider = new GeminiProvider({
          ...(opts.geminiApiKey ? { apiKey: opts.geminiApiKey } : {}),
          ...(opts.geminiModel ? { defaultModel: opts.geminiModel } : {}),
        });
        break;
      default:
        throw new Error(`Unknown model provider: ${name}`);
    }
    cache.set(name, provider);
    return provider;
  };
}
