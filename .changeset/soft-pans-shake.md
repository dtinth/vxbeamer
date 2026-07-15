---
"vxasr": minor
---

Add a provider registry that maps a provider id to a factory building an `ASRProvider` from environment config plus a model name. Each provider declares its own config shape, so providers needing more than an API key (a region, IAM credentials, a pre-flight step) can join without reshaping the registry.

Exposes `createProviderRegistry`, `defineProvider`, and `createDefaultProviderRegistry`, with `qwen`, `byteplus`, and `mock` registered. This makes `createBytePlusProvider` reachable for the first time. `BytePlusProviderConfig` gains an optional `model` field, defaulting to the previously hardcoded `bigmodel`.
