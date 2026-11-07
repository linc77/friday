// The native SwiftPM backend generates Bundle.module lookups at the .app root
// and at an absolute checkout path. Our signed apps keep package resources in
// Contents/Resources, which the Swift Build backend's accessor supports.
export function macSwiftBuildArguments(packagePath, configuration) {
  return ['build', '--package-path', packagePath, '--build-system', 'swiftbuild', '-c', configuration];
}
