---
"vxasr": minor
"backend": minor
---

Fix BytePlus. It can now transcribe the language the speaker actually uses.

The adapter connected to `/api/v3/sauc/bigmodel`. This is the two-way streaming mode. This mode does not accept a `language` field. The vendor's documentation says the `language` field works only with `/api/v3/sauc/bigmodel_nostream`. Without a language field, this mode only covers Mandarin, English, and a few Chinese dialects. It could not hear Thai. It did not fail with an error. Instead, it returned confident but wrong text, such as: `project Niagara typescript Chai framework Chai do deploy material way 来自 Chai MongoDB Atlassian common。` This is the worst kind of error. A human judge may believe it is correct.

**Each mode is now a separate model.** BytePlus serves each mode at its own address. So, `byteplus/bigmodel_nostream` and `byteplus/bigmodel` are now two separate items in the list. They are two separate configuration IDs. The two modes hear different languages from the same audio. So, they must be evaluated as different things. A vote must say which mode it is for. On the wire, both modes still send `model_name: bigmodel`. The vendor uses one model name for both. The two modes differ only by their address path.

**You can now set the language with `BYTEPLUS_LANGUAGE`** (for example, `th-TH`). The provider reads this setting and sends it in the `audio` object, not the `request` object. This setting is specific to BytePlus. It is not a shared `ASR_LANGUAGE` setting for all providers. Each vendor uses its own language codes. Qwen, for example, takes no language setting at all — it detects the language automatically. A shared setting could also affect other providers in ways we have not yet decided. The language setting is sent only to modes that support it. The `bigmodel` mode never receives a field that the vendor would reject.

**The `byteplus/bigmodel` configurations are removed from the default list.** A model that cannot be told the speaker's language wastes a vendor call. It is not a fair choice to evaluate. The `bigmodel+groq` combination was even worse. The Groq step rewrote the wrong text into text that reads like a correct answer. The provider still supports `bigmodel`. A deployment that mainly serves Mandarin or English speakers can still add it as a configuration. It is just not offered by default.

Note a trade-off: `bigmodel_nostream` only returns results after 15 seconds of audio, or after the final audio packet. So, it sends few or no partial results while recording. It favors accuracy over speed. This fits the eval feature well, since only the final result matters there. It fits the live recording feature less well.

This change also fixes a hang. Before, if you called `finish()` before the socket finished opening, the app dropped the last audio packet. The turn never ended.
