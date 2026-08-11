# Project policy

Standing decisions for this repository. A note records nuance and grants
nothing. A permission grants one action, and names the condition a session
must verify before acting on it.

Record them with `stdd policy add <text>` and
`stdd policy allow <action> --when "<condition>"`.

## Permissions

- merge — when: the closing review recorded an approved verdict or the change makes no review claim (no plan, no delegated slice), `stdd ci --watch` exited 0 on that PR, and the merge is a squash into main

## Notes
