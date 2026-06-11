#!/usr/bin/env bash
# git credential prompt helper for cc.sh: the clone URL carries the username
# (x-access-token), so every prompt git makes gets answered with the PAT.
# Keeps the token out of argv, .git/config, and stored remotes.
echo "${GITHUB_TOKEN:?GITHUB_TOKEN not set}"
