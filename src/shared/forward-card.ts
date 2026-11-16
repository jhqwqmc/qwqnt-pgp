import { t } from './i18n';
export const FORWARD_TEXT_TOO_LARGE = '[PGP_FORWARD_TEXT_TOO_LARGE]';
const CIPHERTEXT_CARD_MARKER = '[密文]';

export function buildCiphertextCard(total: number, resId: string, id: string): string {
  return JSON.stringify({
    app: 'com.tencent.multimsg',
    config: { autosize: 1, forward: 1, round: 1, type: 'normal', width: 300 },
    desc: CIPHERTEXT_CARD_MARKER,
    // 注意：extra / meta 必须是对象，字符串会让本机回显渲染失败（显示「暂不支持该消息类型」）
    extra: { filename: id, tsum: total },
    meta: {
      detail: {
        news: [{ text: ':' }],
        resid: resId,
        source: t("forward.ciphertext"),
        summary: t("forward.ciphertext"),
        uniseq: id
      }
    },
    prompt: CIPHERTEXT_CARD_MARKER,
    ver: '0.0.0.5',
    view: 'contact'
  });
}
