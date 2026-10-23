#!/usr/bin/env bash
# Runner-side guard (ACTIONS_RUNNER_HOOK_JOB_STARTED): runs before every job, outside anything a
# workflow controls. A pull request's run executes its own workflow files and route script, so a
# fork could send its job here; this refuses every job whose code comes from another repository
# (a fork pull request, a deleted head repository, a workflow_run of a fork) before a step runs.
set -euo pipefail

: "${GITHUB_EVENT_PATH:?GITHUB_EVENT_PATH is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

head="$(jq -r --arg repo "$GITHUB_REPOSITORY" '
  if has("pull_request") then (.pull_request.head.repo.full_name // "")
  elif has("workflow_run") then (.workflow_run.head_repository.full_name // "")
  else $repo end' "$GITHUB_EVENT_PATH")"

if [[ "$head" != "$GITHUB_REPOSITORY" ]]; then
  echo "::error::This self-hosted runner only runs code from $GITHUB_REPOSITORY; refusing ${GITHUB_EVENT_NAME:-this} job from ${head:-an unknown repository}."
  exit 1
fi
echo "Runner guard: ${GITHUB_EVENT_NAME:-job} from $GITHUB_REPOSITORY"
