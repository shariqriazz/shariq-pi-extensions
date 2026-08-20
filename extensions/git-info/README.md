# Git Info

Shows the current Git branch and working-tree state in Pi and provides an interactive changed-file viewer.

## Interface and commands

- The footer status displays the branch, changed-file count, and open pull-request number when known.
- `/lg` opens a TUI browser for changed and untracked files, line counts, and bounded textual diffs.
- `/pr` refreshes pull-request information for the current branch and reports its URL.

Status refreshes after user input and tool execution, with debounce and stale-result protection. Outside a Git repository, the footer is hidden and commands return a clear notice.

## Dependencies and limits

- Requires `git` for repository status and diffs.
- `/pr` additionally requires an authenticated GitHub CLI (`gh`); unavailable or non-open pull requests are treated as no matching open pull request.
- The changed-file viewer loads at most 250 files and bounds each textual diff to 20,000 lines.
- Binary file statistics may be unavailable and are displayed without fabricated counts.
- Repository paths and command output are sanitized before TUI rendering.

The extension reads repository state only. It does not stage, commit, push, or modify files.

## Validation

From the repository root, run `npm run validate`.
