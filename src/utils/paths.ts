import { join, relative, sep, normalize } from 'path';

export function normalizePath(path: string, repoRoot: string): string {
  // Handle Windows paths and file:// URIs
  let cleanPath = path;
  if (cleanPath.startsWith('file://')) {
    cleanPath = cleanPath.replace('file://', '');
  }
  // Remove leading slashes on Windows
  if (process.platform === 'win32' && cleanPath.match(/^\/[A-Z]:/)) {
    cleanPath = cleanPath.substring(1);
  }
  
  const normalized = normalize(cleanPath);
  const repoRelative = relative(repoRoot, normalized);
  // Convert to forward slashes (normalize separators)
  // Handle case where path is outside repo (returns with ..)
  if (repoRelative.startsWith('..')) {
    // If outside repo, just use the filename
    return normalized.split(sep).pop() || normalized;
  }
  return repoRelative.split(sep).join('/');
}

export function isJunkDir(dirname: string): boolean {
  const junkPatterns = [
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    '.venv',
    '__pycache__',
    '.cursor',
    '.vscode',
    '.idea',
    'coverage',
    '.nyc_output',
    '.cache',
    'tmp',
    'temp',
  ];
  return junkPatterns.includes(dirname) || dirname.startsWith('.');
}
