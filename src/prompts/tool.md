Use `seance` to import saved session context into a separate read-only child without switching the parent conversation.

- `sourceSession` accepts a non-current live session ID, saved-session ID or unambiguous prefix, or JSONL path. Current-session sources and sources whose artifact directory contains the caller's are rejected; there is no `current` alias.
- An import returns metadata for an idle child; it does not invoke a model.
- Optional `name` labels the child. Omit `model` to inherit the caller's model; overrides require an exact provider/model pair.
- Human `/seance` with no arguments opens the native searchable session picker: current-folder scope, Tab for all projects, arrows/Enter to select, Esc to cancel. Selection forks an idle child; it does not resume the source, switch the parent session, or invoke a model. Tool callers pass an ID or JSONL path as `sourceSession`.
- Import the source once. Send questions with the ordinary `write` tool to `agent://<id>` and use `wait` for replies. Reuse the child ID for follow-ups; `seance` only imports.
- The consultant gets only read-only `read`, `grep`, and `glob` tools.
