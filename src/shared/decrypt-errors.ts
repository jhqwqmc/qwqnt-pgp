export const DECRYPT_COOLDOWN = '[PGP_DECRYPT_COOLDOWN]';
export const DECRYPT_SKIPPED = '[PGP_DECRYPT_SKIPPED]';
export const OPERATION_CANCELLED = '[PGP_OPERATION_CANCELLED]';

export function isOperationCancelled(error: unknown): boolean {
  const message = String(error);
  return message.includes(OPERATION_CANCELLED) ||
    /\boperation cancel(?:l)?ed\b|操作(?:已)?取消|操作已被取消/i.test(message);
}
