# omp-seance

`omp-seance` adds read-only session consultants to OMP. It forks a saved session into a restricted consultant, returns reports synchronously, and keeps the consultant attached as a live registry child visible in Agent Hub. Use the extension's `seance` tool for follow-up questions.

## Requirements

- OMP 18.20.3 or newer
- Bun 1.4.4 or newer

## Install

```sh
omp plugin install github:anatoli-tsinovoy/omp-seance
```

## Use

`/seance` with no arguments opens input when the UI is available. `/seance <id-or-JSONL-path>` attaches an idle consultant; the full argument is accepted as a path, including spaces. The slash command only attaches a consultant and does not invoke a model. There is no `current` alias, and the current session cannot be used as a source.

Loading the plugin advertises the `seance` tool and its consultation instructions to the main model through the tool catalog; it does not inject a separate system-prompt paragraph. The model can use these actions:

- **spawn** forks a historical source session. `sourceSession` is required; optional `question`, `name`, and `model` can be supplied. With a question, it returns the consultant's report synchronously and retains the live child. Without one, it attaches an idle child.
- **ask** sends a follow-up question to an attached consultant by its ID and returns the reply synchronously.
- **list** shows consultants attached to the current session.
- **close** closes an attached consultant. Its fork files are retained.

A source can be a JSONL path (including `~` paths), a known live registry ID, or a saved session ID/prefix. Saved IDs are resolved in the current project and then globally; ambiguous or missing sources are rejected. The caller and source must both have persistent session files. Current-session sources are rejected even when specified by ID or path. A source is also rejected if its canonical artifact directory contains the fork destination; this includes self and ancestor sources, with symlink aliases accounted for, to prevent copying an artifact tree into itself.

Consultants use the caller's current model by default. Set `model` on `spawn` to select an exact available provider/model identifier; an unavailable override does not silently fall back. Follow-up is handled by `seance ask`; this extension does not resume the standard `task` workflow.

Relative file paths are resolved in the historical session's recorded working directory, not the caller's project. If that directory no longer exists, consultation uses an empty fallback directory and reports `sourceCwdAvailable: false`; the consultant is told not to treat that empty directory as evidence about the original project.

## Isolation and storage

The consultant is given only the read-only `read`, `grep`, and `glob` tools. It does not inherit ambient extensions, custom tools, hooks, MCP or LSP access, context files, skills, or rules. This is not an operating-system sandbox, and file reads are not confined to the source session or project: the consultant can read files available through OMP's file access.

The child transcript (`<consultant-id>.jsonl`) and a full copy of the source artifacts (`<consultant-id>/`) are stored under the caller session's artifact tree. The child uses OMP's normal agent registry location and appears in Agent Hub; no OMP core changes are required. The source session is not modified. Inherited spend starts at zero, so only the consultant's new work counts toward its own usage. Interrupted tool-call repair applies only to the fork; unresolved calls are never replayed. Closing a consultant does not delete its transcript or copied artifacts.

Attachments live only for the extension runtime and are disposed on session switch or shutdown. They are not cold-revived after a restart, do not run as asynchronous `task` jobs, and do not provide standard task-resume or IRC coordination parity.

Inherited `history://` and `agent://` identifiers are not explicitly rebound to the historical source. Use concrete transcript or artifact paths when those short references are ambiguous.

## Development

```sh
bun install
bun check
bun test
```
