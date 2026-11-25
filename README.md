# omp-seance

`omp-seance` adds read-only session consultants to OMP. It forks a saved session into a read-only child, registers it as a live Agent Hub child, and uses OMP's scout wake-turn monitor to route completed answers back to their sender.

## Requirements

- OMP 19.2.1 or newer
- Bun 1.4.4 or newer

## Install

```sh
omp plugin install github:anatoli-tsinovoy/omp-seance
```

## Use

1. **Choose a source.** With no arguments, `/seance` opens OMP's searchable selector for sessions in the current folder. Longer lists support type-to-search; choose **Search all projects** to search every project, or Esc to cancel.
2. **Choose a model.** The native selector defaults to the current main model; the source's recorded historical model is offered when available, and other available models are searchable. The current session and main model remain unchanged.
3. **Ask or attach.** The native multiline question editor submits with Ctrl+Q or Ctrl+Enter. A blank question attaches an idle consultant; canceling any dialog creates no child.

In the TUI, `/seance <id|prefix|liveid|JSONL-path>` skips only the source picker; model selection and the question editor still appear. Outside the interactive TUI, an explicit source argument attaches an idle consultant without prompting.

Loading the plugin advertises the `seance` tool and its consultation instructions to the main model through the tool catalog; it does not inject a separate system-prompt paragraph.

The `seance` tool requires `sourceSession`; `name`, `model`, and `question` are optional. A nonblank `question` starts an initial parent-attributed IRC consultation, while an omitted or whitespace-only question leaves the child idle. The tool returns child metadata without waiting for inference; use `wait` for the initial answer.

For follow-ups, send each question with the ordinary `write` tool to `agent://<id>` and use `wait` for completion. Yield ends only that turn; the child remains attached and available, so reuse the same ID for follow-ups.

The consultant prompt requires `yield`, but OMP's IRC monitor does not enforce it with reminders: if the model stops with plain text instead, the monitor forwards that text. Unlike initial task/scout runs, IRC follow-ups have no missing-yield retry ladder. This extension preserves that native fallback rather than adding its own orchestration.

The source can be a JSONL path (including `~` paths), a known live registry ID, or a saved session ID/prefix. Saved IDs are resolved in the current project and then globally; ambiguous or missing sources are rejected. The caller and source must both have persistent session files. Current-session sources are rejected even when specified by ID or path. A source is also rejected if its canonical artifact directory contains the fork destination; this includes self and ancestor sources, with symlink aliases accounted for, to prevent copying an artifact tree into itself.

Tool callers use the caller's current model by default. Set `model` to select an exact available provider/model identifier; an unavailable override does not silently fall back. In the TUI, the source's recorded historical model is also offered when available; if unavailable, the dialog title identifies it rather than silently substituting another model.

Relative file paths are resolved in the historical session's recorded working directory, not the caller's project. If that directory no longer exists, consultation uses an empty fallback directory and reports `sourceCwdAvailable: false`; the consultant is told not to treat that empty directory as evidence about the original project.

## Isolation and storage

The consultant's only tools are the read-only `read`, `grep`, and `glob` tools plus the read-tier `yield` tool for terminal turn results. It does not inherit ambient extensions, custom tools, hooks, MCP or LSP access, context files, skills, or rules. This is not an operating-system sandbox, and file reads are not confined to the source session or project: the consultant can read files available through OMP's file access.

The child transcript (`<consultant-id>.jsonl`) and a full copy of the source artifacts (`<consultant-id>/`) are stored under the caller session's artifact tree. The extension reuses OMP's scout wake-turn monitor and normal agent registry location; the child appears in Agent Hub, and no OMP core changes are required. The source session is not modified. Inherited spend starts at zero, so only the consultant's new work counts toward its own usage. Interrupted tool-call repair applies only to the fork; unresolved calls are never replayed. Attachment disposal does not delete its transcript or copied artifacts.

Attachments are runtime-scoped and disposed on session switch or shutdown. They are not restored after restart and do not support standard `task` resume; use IRC for follow-ups.

Inherited `history://` and `agent://` identifiers are not explicitly rebound to the historical source. Use concrete transcript or artifact paths when those short references are ambiguous.

## Development

```sh
bun install
bun check
bun test
```
