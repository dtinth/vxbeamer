---
"vxasr": minor
---

Add a provider registry and a list of **model configurations**.

A provider connects an ID to a function. This function builds an `ASRProvider` from settings and a model name. Each provider defines its own settings shape. This means a provider that needs more than an API key — for example, a region code, full cloud credentials, or a setup step — can still be added, without changing the registry itself.

A configuration pairs one provider and one model with a chain of processing steps. This configuration is the item that users select and compare. The processing steps are part of a configuration's identity. They are not a separate, optional setting on each request. So, `qwen/qwen3-asr-flash-realtime` and `qwen/qwen3-asr-flash-realtime+groq` are two separate configurations. Users can compare them as equal, separate choices. Each configuration's ID is built from its parts. So, an ID can never drift out of sync with what it names.

This change exports these new functions: `createProviderRegistry`, `defineProvider`, `createDefaultProviderRegistry`, `createConfigurationCatalogue`, `defineDecorator`, `buildConfigurationId`, and `createDefaultConfigurationCatalogue`. This is also the first change that makes `createBytePlusProvider` usable from outside this package. `BytePlusProviderConfig` now has an optional `model` field. If you do not set it, it defaults to `bigmodel`, the same value that was hardcoded before.
