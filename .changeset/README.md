# Release versioning

Add a changeset for `@callstack/tracesift` for each user-facing release. The root app is private and is not discovered as an npm workspace package by Changesets. `npm run release:version` versions the CLI, then synchronizes the root app version and its exact CLI dependency before updating `package-lock.json`. The app is never published to npm.
