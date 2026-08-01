---
"vxasr": minor
"backend": patch
"website": patch
---

Export per-provider "fast dump" support as real metadata: `ProviderSpec.supportsFastDump` (and its type-erased `ProviderDefinition`/`ConfigurationDefinition` counterparts), carried through the backend's `GET /asr/configurations` response. Previously this lived only as a hardcoded `FAST_DUMP_PROVIDERS` set in the website's eval-replay pacing logic, so an external consumer of `vxasr` had no way to know which providers tolerate a fast dump without re-deriving or copying that list. The website's eval dialog now reads the flag from the server instead of keeping its own copy.
