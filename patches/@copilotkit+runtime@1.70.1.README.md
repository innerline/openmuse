# @copilotkit/runtime 1.70.1 — Intelligence thread-init compatibility patch

The pinned runtime's thread-init predates the deployed Intelligence schema:
createThread sent no `tools` (now required) and `userId` (now `endUserId`),
and the GET thread probe 400s on the same schema. This patch makes the
runtime compatible create-first.

Re-apply after any `bun install` that refreshes this package:

    patch -p1 -d node_modules/@copilotkit/runtime < patches/@copilotkit+runtime@1.70.1.patch
    # then restart com.innerline.openmuse-larry

Until upstream OpenMuse bumps @copilotkit/runtime to a version matching the
deployed Intelligence build.
