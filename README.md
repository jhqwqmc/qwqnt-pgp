# qwqnt-pgp

QwQNT 的 PGP 加密插件，使用本机 GnuPG 对 QQ 文本消息加密、签名和解密

> [!WARNING]
> 当前仅在 QQ **9.9.36-53644** 上进行了开发和测试，且仅支持 Windows x64 平台

## 安装

运行时依赖：

| 依赖                    | 版本要求     | 下载                                                                            |
|-----------------------|----------|-------------------------------------------------------------------------------|
| qwqnt-hako            | `^1.0.0` | [Releases](https://github.com/qwqnt-community/qwqnt-hako/releases)            |
| qwqnt-ipc-interceptor | `^1.2.1` | [Releases](https://github.com/qwqnt-community/qwqnt-ipc-interceptor/releases) |

1. 安装 QwQNT 框架、上表的两个依赖和 [Gpg4win](https://gpg4win.org/thanks-for-download.html)
2. 将 [`qwqnt-pgp.zip`](https://github.com/jhqwqmc/qwqnt-pgp/releases) 解压到 QwQNT 插件目录下的 `qwqnt-pgp` 文件夹内

## 使用

先在 GnuPG 钥匙串中准备自己的密钥和好友的公钥，再在插件基本设置的加密解密中选择「我的公钥」

- **绑定**：在好友管理的绑定公钥可选择未绑定的好友，未添加好友可输入 QQ 号绑定，可给多个好友绑定同一把公钥。每个 QQ 号只能绑定一个公钥
- **私聊**：绑定公钥后在聊天界面的「...」启用「加密」即可
- **群聊**：在群聊天界面的「...」的「加密成员」中，开启至少一位已绑定公钥的其他成员
- **发送**：默认按 `Ctrl+/` 加密发送。启用自动加密发送后，使用 QQ 原有的发送按钮或快捷键即可。加密消息会用自己的私钥签名，自己也会被加入收件人
- **解密**：默认可右键消息选择「解密」，也可以在基本设置开启自动解密。绿色表示签名有效且身份受本机信任，黄色表示身份未验证或无签名，红色表示缺少签名公钥或验签失败

## 从源码构建

目前仅能在 Windows x64 平台上构建，首次构建会自动下载 [Zig 0.15.2](https://ziglang.org/download/0.15.2/zig-x86_64-windows-0.15.2.zip)

```sh
pnpm install
pnpm build
```

## 鸣谢

- [LiteLoaderQQNT-PGP-Encryption](https://github.com/TransparentLC/LiteLoaderQQNT-PGP-Encryption) 项目灵感
- [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 参考了部分协议方面的代码
- [lite-tools](https://github.com/xiyuesaves/lite-tools) 参考了部分 UI 设计
- [QwQNT-PluginTemplate-Vite-pnpm](https://github.com/adproqwq/QwQNT-PluginTemplate-Vite-pnpm) 项目模板
