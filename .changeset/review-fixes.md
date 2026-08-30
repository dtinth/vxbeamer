---
"vxasr": patch
---

Remove an unused `latencyMs` field — nothing ever set it. Share one `quoteId` function between the provider registry and the configuration list, instead of two separate copies. Have the frontend read its audio constants from `vxasr/audio`, instead of writing the same values a second time.
