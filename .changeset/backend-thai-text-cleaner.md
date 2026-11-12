---
"backend": patch
---

Pass every transcript through `normalizeThaiText` from `@thai/text-cleaner`, unconditionally, for partials and finals on every path that hands one out (live messages, the eval socket, a chosen eval winner). It fixes Thai Unicode encoding mistakes such as a doubled `เ` for `แ`, and touches only runs of Thai script, so other languages and mixed text are unchanged.
