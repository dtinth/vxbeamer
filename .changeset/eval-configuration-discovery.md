---
"backend": minor
---

Add `GET /asr/configurations`, so a client can discover which model configurations it may transcribe with instead of hardcoding them — the list an eval fans out over.

There is deliberately no separate eval-set setting. An eval opens one `/ws` per configuration, so an eval-only list could only ever be a subset of what `/ws` already accepts, and a second env var could only disagree with `ASR_CONFIGURATIONS` — advertising configurations the socket rejects, or hiding ones it serves. The selectable set already is the answer, and the endpoint reports exactly it.

Each entry carries its id, a label, and its identity components (`providerId`, `model`, `postProcessing`), so a client never has to parse an id back apart — the id is derived from those, not the other way round. `primaryConfigurationId` is named once at the top rather than flagged per entry, and the primary appears in the list like any other candidate.

Credentials never appear in the response: not their values, and not the names of missing env vars either. A token authenticates a subject, not an operator, so the server's environment is not described here; a `configured` boolean answers whether a configuration will work, and the `/ws` close reason still tells an operator which variable to set.
