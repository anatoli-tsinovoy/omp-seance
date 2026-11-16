# Changelog

## [Unreleased]

### Added

- Add read-only historical-session consultants with synchronous reports and live Agent Hub attachments.

### Fixed

- Open the native searchable session picker for `/seance` with no arguments, scoped to the current folder with Tab for all projects; selection forks without resuming the source, switching the main session, or invoking a model.

- Resolve relative file reads in the historical source project; disclose an unavailable source directory instead of reading from the caller's project.
