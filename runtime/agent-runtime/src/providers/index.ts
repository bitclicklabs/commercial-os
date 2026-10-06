import { AnthropicProvider } from './anthropic-provider.js';
import type { ModelProvider } from './model-provider.js';
import { StubProvider } from './stub-provider.js';

export * from './model-provider.js';
export { StubProvider } from './stub-provider.js';
export { AnthropicProvider, ANTHROPIC_PRICING, DEFAULT_ANTHROPIC_MODEL } from './anthropic-provider.js';

export type ProviderFactory = (name: string) => ModelProvider;

/** Lazily instantiates providers by name; the Anthropic client is only built when first needed. */
export function createProviderRegistry(opts: { anthropicApiKey?: string | undefined } = {}): ProviderFactory {
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
      default:
        throw new Error(`Unknown model provider: ${name}`);
    }
    cache.set(name, provider);
    return provider;
  };
}
