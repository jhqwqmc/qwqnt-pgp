export const FORWARD_TEXT_TOO_LARGE = '字数超过上限，无法发送';

export function buildCiphertextCard(total: number, resId: string, id: string): string {
  return JSON.stringify({
    app: 'com.tencent.multimsg',
    config: { autosize: 1, forward: 1, round: 1, type: 'normal', width: 300 },
    desc: '[密文]',
    // 注意：extra / meta 必须是对象，字符串会让本机回显渲染失败（显示「暂不支持该消息类型」）
    extra: { filename: id, tsum: total },
    meta: {
      detail: {
        news: [{ text: ':' }],
        resid: resId,
        source: `密文`,
        summary: `密文`,
        uniseq: id
      }
    },
    prompt: '[密文]',
    ver: '0.0.0.5',
    view: 'contact'
  });
}
