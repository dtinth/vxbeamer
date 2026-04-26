# ADR 0001: Record architecture decisions

- Status: Accepted
- Date: 2026-04-26

## Context

vxbeamer spans multiple applications and packages, including a web frontend, a backend service, a desktop app, and shared libraries. While the repository already documents the current high-level architecture in the README, it does not provide a dedicated place to capture why major architectural decisions were made.

As the project evolves, design rationale can otherwise become scattered across pull requests, commits, and issue discussions. That makes it harder to understand past decisions, evaluate trade-offs, and safely evolve the system over time.

## Decision

We will record significant architecture decisions as Architecture Decision Records (ADRs) in `/docs/adr`.

Each ADR should:

- use a four-digit numeric prefix in the filename
- describe the context for the decision
- state the decision that was made
- summarize the consequences and trade-offs

This document initializes the ADR collection for the repository.

## Consequences

- Contributors have a single place to find architectural rationale.
- Future decisions can be added incrementally without expanding the README.
- When a decision changes, a new ADR can supersede an earlier one while preserving historical context.
