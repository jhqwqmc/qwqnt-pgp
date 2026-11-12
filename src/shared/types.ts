/**
 * 主进程 / preload / renderer 共用的类型与常量。
 */

/** 发送策略：手动快捷键 / 发送时自动加密 / 不加密 */
export type SendPolicy = 'manual' | 'auto' | 'off';

/** 插件配置 */
export interface PgpConfig {
  /** 自动解密（默认 true = 扫到密文/转发卡片就直接显示解密内容，仍可切回原文） */
  autoDecrypt: boolean;
  /** 发送策略：manual = 按快捷键才加密；auto = 拦截纯文本发送并加密；off = 不加密 */
  sendPolicy: SendPolicy;
  /** 手动发送的快捷键（如 Ctrl+/、Alt+Q） */
  hotkey: string;
  /** 单条文本切片长度（字符数） */
  sliceLength: number;
  /** gpg 可执行文件路径，空 = 自动探测 */
  gpgPath: string;
  /** gpg homedir，空 = 系统默认 */
  gpgHome: string;
  /** 默认 keyserver（只写域名，如 keys.openpgp.org） */
  keyserver: string;
  /** 自己的公钥 keyID（默认取有私钥的那把；加密时给自己也发一份） */
  ownKeyID: string;
  /** 调试日志 */
}

export interface KeyBinding {
  uin: string;
  keyID: string;
}

/** 解析后的密钥信息（来自 gpg --with-colons） */
export interface KeyInfo {
  keyID: string;
  /** 完整指纹 */
  fingerprint: string;
  /** 主密钥算法（数字/字母代码） */
  algo: string;
  /** 位数 */
  bits: number;
  /** 创建时间（Unix 秒） */
  created: number;
  /** 过期时间（Unix 秒，0 = 永不过期） */
  expires: number;
  /** 是否已过期 */
  expired: boolean;
  /** 是否已吊销 */
  revoked: boolean;
  /** 是否有私钥 */
  secret: boolean;
  /** 信任度（gpg --with-colons 的 validity 字段） */
  validity: string;
  /** 用户 ID 列表 */
  userIds: string[];
  /** 子密钥 */
  subkeys: KeyInfo[];
}

/** gpg 检测结果 */
export interface GpgStatus {
  ok: boolean;
  /** 实际使用的可执行文件路径 */
  path: string;
  /** gpg --version 第一行 */
  version: string;
  /** homedir */
  home: string;
  /** 失败原因 */
  error?: string;
}

/** 密钥搜索结果的单条 */
export interface KeySearchResult {
  keyID: string;
  fingerprint: string;
  algo: string;
  bits: number;
  created: number;
  expires: number;
  userIds: string[];
  source: 'keyserver' | 'github';
  /** 已经拿到的 armored 公钥（GitHub 来源） */
  armored?: string;
}

/** 发送结果 */
/** 签名验证结果 */
export interface SignatureInfo {
  status: 'none' | 'good' | 'bad' | 'error' | 'nokey';
  signer?: string;
  keyID?: string;
  fingerprint?: string;
  trust?: 'full' | 'marginal' | 'undefined' | 'never';
}

/** 解密结果：明文 + 签名状态 */
export interface DecryptResult {
  plaintext: string;
  signature: SignatureInfo;
}

export interface SendResult {
  ok: boolean;
  /** 实际发送的切片数 */
  slices: number;
  /** 素材消息 ID（伪造转发只有一条卡片，这里是卡片 msgId） */
  msgId?: string;
  /** 失败原因 */
  error?: string;
}

/** 加密测试结果 */
export interface CryptoTestResult {
  ok: boolean;
  encrypted?: string;
  decrypted?: string;
  error?: string;
  /** 解密时的签名验证结果 */
  signature?: SignatureInfo;
  /** 各阶段耗时（ms） */
  timings?: { encrypt: number; decrypt: number; total: number };
}

/** PGP 消息头 */
export const PGP_HEADER = '-----BEGIN PGP MESSAGE-----';
export const PGP_FOOTER = '-----END PGP MESSAGE-----';

/** 判断文本是否是 PGP 密文（要求开头就是标准头） */
export function isPgpMessage(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith(PGP_HEADER)) return false;
  return t.trimEnd().endsWith(PGP_FOOTER) || t.includes(PGP_FOOTER);
}
