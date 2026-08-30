---
"website": patch
---

Fix the retry button. Before, if a connection had failed a while ago, tapping retry did nothing. This happened because retry reused the login token from the first connection attempt. If that token had since expired, the backend's `/ws` connection step rejected it right away. This looked like the retry button did nothing at all. Now, retry always fetches a fresh login token before it reconnects. This matches how every other login-based request already works.
