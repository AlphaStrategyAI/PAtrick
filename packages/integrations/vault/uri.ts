export function editKey(
  operation: 'edit_original' | 'supplement_knowledge' | 'create_standard' | 'revise_standard',
  targetId: string | null,
  baseVersion: number | null,
  draftKey: string,
): string {
  return JSON.stringify([operation, targetId, baseVersion, operation === 'create_standard' ? draftKey : null]);
}

export function obsidianFileUri(vault: string, relativeFile: string): string {
  return 'obsidian://open?vault=' + encodeURIComponent(vault) + '&file=' + encodeURIComponent(relativeFile);
}
