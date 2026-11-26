import { fileURLToPath } from 'node:url';

declare const PATRICK_BUNDLED_VAULT_KIT: boolean;

export function resolveVaultKit(callerUrl: string, sourceRelativePath: string) {
  const bundled = typeof PATRICK_BUNDLED_VAULT_KIT !== 'undefined' && PATRICK_BUNDLED_VAULT_KIT;
  return fileURLToPath(new URL(bundled ? '../assets/vault-kit/' : sourceRelativePath, callerUrl));
}
