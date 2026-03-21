---
name: release
description: Automate release operations for the cc-switch repository, including staging and committing changes, pushing the current branch, building a new release artifact set, and opening the generated dist folder. Use when asked to create a release, push all changes, build package artifacts, or open release outputs for cc-switch.
---

# Release

## Overview

Execute a repeatable release pipeline for this repository: check git state, commit pending changes, push current branch, run build, verify artifacts, and open the output directory.

## Workflow

### 1. Prepare release context

- Work inside the repository root.
- Confirm branch with `git branch --show-current`.
- Inspect status with `git status --short --branch`.
- Confirm tooling is available: `pnpm --version`.

### 2. Commit and push changes

- Stage all changes: `git add -A`.
- Commit staged changes with a release-oriented message.
- Push current branch to origin: `git push origin <current-branch>`.

### 3. Build release artifacts

- Run `pnpm build`.
- Expect this pipeline:
  - `scripts/bump-version.mjs` bumps package and tauri versions.
  - `pnpm tauri build` generates release binaries.
  - `scripts/postbuild.mjs` copies artifacts into `dist/`.

### 4. Verify release outputs

- List files in `dist/` and verify expected artifacts.
- Read the resulting version from `package.json`.
- Report artifact names and absolute output path.

### 5. Open output directory

- On Windows, run `explorer <repo-root>\dist`.

## Script

Use `scripts/release.ps1` for deterministic execution of the workflow.

Example invocation:

```powershell
powershell -ExecutionPolicy Bypass -File "<skill-dir>\scripts\release.ps1" -RepoPath "<repo-root>" -CommitMessage "chore: release"
```

Optional flags:

- `-SkipBuild` to skip `pnpm build`
- `-SkipOpen` to skip opening Explorer
- `-AllowEmptyCommit` to allow an empty commit when needed

## Expected Output

Return:

- current branch
- commit hash
- push target
- resulting version
- artifact list in `dist/`
- absolute `dist/` path
