/** Release file-list gate: external prerequisites must never enter the tgz. */
export function assertNoBundledNative(filePaths) {
  const forbidden = filePaths.filter(path => {
    const normalized = path.replaceAll('\\', '/');
    return /^vendor\//i.test(normalized) || /\.(exe|dll|so(?:\.\d+)*|dylib|lib|a)$/i.test(normalized);
  });
  if (forbidden.length) throw new Error('Native/prerequisite files are forbidden in the package: ' + forbidden.join(', '));
}
