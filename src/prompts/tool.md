Use `seance` to consult saved session context in a separate read-only child without switching the parent conversation.

- `spawn` accepts a non-current live session ID, saved-session ID or unambiguous prefix, or JSONL path. Current-session sources and sources whose artifact directory contains the caller's are rejected; there is no `current` alias.
- Add an initial `question` to receive a synchronous reply while retaining the child, or omit it to attach an idle child.
- Use `ask` for follow-ups to an attached child by its returned `id`; NEVER resume it through `task`.
- Use `list` to inspect attached children and `close` to end one.
- Human `/seance` with no arguments opens the native searchable session picker: current-folder scope, Tab for all projects, arrows/Enter to select, Esc to cancel. Selection forks an idle child; it does not resume the source, switch the parent session, or invoke a model. Tool callers still pass an ID or JSONL path as `spawn.sourceSession`.
- Omit `model` to inherit the caller's model; overrides require an exact provider/model pair.

Children are read-only. Ask focused questions and reuse the same child ID for follow-ups.
