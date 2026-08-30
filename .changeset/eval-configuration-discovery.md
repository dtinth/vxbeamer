---
"backend": minor
---

Add a new endpoint: `GET /asr/configurations`. A client can call this endpoint to find out which model configurations it may use. Before, a client had to hardcode this list.

There is no separate setting for the eval list. An eval opens one `/ws` connection per configuration. So, an eval-only list could only ever be a smaller version of what `/ws` already accepts. A second setting could disagree with the `ASR_CONFIGURATIONS` setting. It could advertise configurations that the `/ws` socket then rejects. Or, it could hide configurations that the socket does serve. The list of allowed configurations is already the right answer. This endpoint reports that same list.

Each entry has an ID, a label, and its identity parts: `providerId`, `model`, and `postProcessing`. A client never needs to take an ID apart to find these parts. The ID is built from these parts, not the other way around. The field `primaryConfigurationId` names the primary configuration once, at the top level. The primary configuration also appears in the list, like every other configuration.

The response never includes credentials. It does not include credential values. It also does not include the names of missing setting variables. A login token identifies a user, not a server operator. So, this endpoint does not describe the server's setup. A `configured` field on each entry tells the client if that configuration will work. If a socket connection is refused, its close reason still tells the operator which setting to fix.
