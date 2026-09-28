import { COMMON_PASSWORDS_TEXT } from './common-passwords.generated.js';

let commonPasswords: Set<string> | undefined;

export function isCommonAdminPassword(password: string): boolean {
  commonPasswords ??= new Set(COMMON_PASSWORDS_TEXT.split('\n'));
  return commonPasswords.has(password);
}
