---
"backend": minor
"website": minor
"vxasr": minor
---

Save every eval winner pick to cloud storage. The app always saves a **vote**. It also saves an **eval-set** when you check "save for eval".

The backend signs upload links. The browser uploads the file directly. The endpoint `POST /messages/:id/winner` now returns `{ ok, upload }`. The `upload` field holds signed upload links for this pick's vote and, if checked, its eval-set. The audio never passes through the backend server. This keeps the rule "the backend never stores recordings" true by design, not just by convention. No storage password ever reaches the browser. Signing happens offline, so creating the links adds no extra network delay. The links are created for the `configurationId` that the winner endpoint already checked. A separate endpoint would have to check it again, or it could create links for configurations the server does not serve.

A storage failure cannot block a vote. The app applies and shares the winner pick first. It creates the upload link after. So, if storage is down, not set up, or missing, you only lose the eval-set upload — the vote itself is not affected. The `upload` field is `null` when no storage bucket is configured. If the backend refuses the upload, nothing is sent.

A **vote** (`{"type":"vote",…}`) is created for every pick. It has the winning configuration's ID, the full list of options that were compared, each option's cost, response time, and any errors, plus the audio's length in time. It does not include the audio itself or any transcripts. This is what makes it safe to store without limits. The list of options and the ID of the original primary answer make the vote log useful to read later. Without the list of options, a win is just a count, not a rate. Without knowing the original primary answer, you cannot tell a new favorite from the old default. An **eval-set** (`{"type":"eval-set",…}`) has everything a vote has, plus the recording as a base64 WAV file, plus every option's transcript. An eval-set is built as a vote plus more data. This design means the two records can never disagree about the same pick.

Files are named by type first, then by UTC date, then by time and message ID. For example: `votes/2026/07/16/…-<messageId>.json`. This way, reading the vote log never requires loading megabytes of audio data. A pick's vote file and eval-set file share the same file name ending.

The `vxasr` package now has a `writeWav` function. It sits next to the existing `readPcm` function, which reads the same file format. This keeps one set of rules and one set of numbers for the format, checked by a test that writes a file and reads it back. This means the same code that saves today's audio will also be used to replay it against models later. This function is exported as `vxasr/audio`, so a browser can use it without loading the full provider code.

Configure this feature with `EVAL_STORAGE_BUCKET` (this turns the feature on), `EVAL_STORAGE_ACCESS_KEY_ID`, `EVAL_STORAGE_SECRET_ACCESS_KEY`, and, if needed, `EVAL_STORAGE_REGION`, `ENDPOINT`, `FORCE_PATH_STYLE`, and `PREFIX`. If you set a bucket name but no credentials, the server fails to start. This is safer than creating upload links that fail in the browser, where no one would see the error.
