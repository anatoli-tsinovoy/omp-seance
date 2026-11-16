Use `seance` to import saved session context into a separate read-only child without switching the parent conversation.

- `sourceSession` accepts a non-current live session ID, saved-session ID or unambiguous prefix, or JSONL path. Current-session sources and sources whose artifact directory contains the caller's are rejected; there is no `current` alias.
- The tool returns child metadata immediately. A nonblank optional `question` starts the initial parent-attributed IRC consultation; use `wait` on the returned child for its answer. Omitted or whitespace-only `question` leaves the child idle.
- Optional `name` labels the child. Omit `model` to inherit the caller's current model; overrides require an exact provider/model pair.
- Human `/seance` opens the session picker, then model selection (current model by default), then a question editor. Blank questions attach idle; canceling forks nothing. The parent session and its model remain unchanged.
- For follow-ups, send questions with ordinary `write` to `agent://<id>` and use `wait` for replies; reuse the child ID instead of importing again.
- The consultant can inspect evidence with `read`, `grep`, and `glob`, and completes each reply with the read-tier `yield` tool. Yielding leaves the child available for follow-ups; it does not grant filesystem write access.
