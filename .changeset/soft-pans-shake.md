---
"vxasr": minor
---

Add a provider registry and a catalogue of **model configurations**.

A provider maps an id to a factory building an `ASRProvider` from environment config plus a model name. Each provider declares its own config shape, so providers needing more than an API key (a region, IAM credentials, a pre-flight step) can join without reshaping the registry.

A configuration pairs a provider and model with a post-processing chain, and is the unit users select and evaluate. Post-processing belongs to a configuration's identity rather than being a request-time flag, so `qwen/qwen3-asr-flash-realtime` and `qwen/qwen3-asr-flash-realtime+groq` are two distinct configurations that compete on equal terms. Ids are derived from the composition, so they cannot drift from their content.

Exposes `createProviderRegistry`, `defineProvider`, `createDefaultProviderRegistry`, `createConfigurationCatalogue`, `defineDecorator`, `buildConfigurationId`, and `createDefaultConfigurationCatalogue`. This makes `createBytePlusProvider` reachable for the first time. `BytePlusProviderConfig` gains an optional `model` field, defaulting to the previously hardcoded `bigmodel`.
