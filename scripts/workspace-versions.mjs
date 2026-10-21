/**
 * The app depends on the CLI through the workspace protocol, so the manifest
 * records `workspace:*` rather than a literal version. npm resolves that to the
 * CLI's own version at install time, which `app.version === cli.version` pins.
 */
export function dependencyMatchesVersion(dependency, version) {
  return dependency === version || /^workspace:(\*|\^|~)$/.test(dependency);
}

export function versionsAligned(app, cli) {
  return app.version === cli.version && dependencyMatchesVersion(app.dependencies?.[cli.name], cli.version);
}
