---
"vxasr": patch
---

`qwen-audio` now turns on the vendor's native text polishing (`disfluency_removal_enabled`) by default, for both models. It drops fillers such as "um", and in testing it also kept English words in Latin instead of spelling them in Thai script and kept spoken numbers as digits. Pass `disfluencyRemoval: false` to the provider to turn it off.
