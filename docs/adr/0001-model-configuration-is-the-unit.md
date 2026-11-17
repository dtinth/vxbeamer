# A model configuration, not a provider, is the unit of selection

Status: accepted. This record was written after the fact, from the decision as it is stated in the code (`packages/vxasr/src/builtin.ts`, `apps/backend/src/asr.ts`) and the `vxasr` README.

## Context

vxbeamer talks to many speech-recognition vendors. A vendor's output can also be run through a post-processing step, such as the Groq formatting pass. Evals pit candidate transcripts against each other, and the winner of an eval replaces the primary answer, so everything that can be a candidate has to be comparable with the rest on equal terms.

## Decision

The thing a client selects, an eval votes for and the catalogue lists is a **model configuration**: a provider, a model and its post-processing chain, written `provider/model` or `provider/model+post`. Post-processing is part of a configuration's identity, not a flag on the request.

So a model raw and the same model with Groq formatting are two configurations, declared separately, and a vote for one says something different from a vote for the other. A client names a configuration with `?configuration=` and cannot ask for a post-processing step on its own.

Every model is pinned to a dated snapshot wherever the vendor publishes one. An undated id floats, because the vendor repoints it without notice, and that would let a transcript change with nothing in the repository changing, and make a vote name a moving target. A model the vendor offers only undated is declared as such, with a comment saying so.

The `mock` provider is never paired with a real post-processing step: there is deliberately no `mock/mock+groq`, so no branch in selection can wrap it by accident.

## Consequences

- The list of configurations is a catalogue in `packages/vxasr/src/builtin.ts`; a new vendor or model is a new entry, and `GET /asr/configurations` lets a client discover the set instead of hardcoding it (see {doc}`../asr-configurations`).
- Ids contain `+` (and sometimes `/`), so clients must URL-encode them.
- A configuration is selectable once the environment carries every credential it needs, so the set a deployment offers follows from its keys.
- Models that already produce well-formatted output are declared raw only, since a second pass costs a vote slot and a call for nothing.
