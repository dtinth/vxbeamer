---
"vxasr": minor
"backend": patch
"website": patch
---

Export "fast dump" support as real data: `ProviderSpec.supportsFastDump`, and the matching fields on `ProviderDefinition` and `ConfigurationDefinition`. The backend's `GET /asr/configurations` endpoint now includes this data too. "Fast dump" means the provider accepts a whole audio clip sent all at once, not paced over time.

Before, this data only existed as a fixed list, `FAST_DUMP_PROVIDERS`, inside the website's eval-replay code. So, any other program using the `vxasr` package had no way to know which providers support fast dump. It would have had to guess, or copy that same list. Now, the website's eval dialog reads this data from the server. It no longer keeps its own copy of the list.
