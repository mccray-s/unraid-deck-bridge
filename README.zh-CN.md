# Unraid Deck Bridge

[English](README.md) | 简体中文

为 **Unraid Deck** 提供 Docker、主机、插件和阵列管理能力的 Unraid 插件，通过官方 `/graphql` 接口使用，沿用官方身份认证和资源权限，不替换官方 Docker API。

## 功能

- 创建、读取和编辑受支持的独立 Docker 容器，预览配置变更。
- 导入 URL、XML、本地 User/Default 模板，显式接管容器或从选定 User 模板重装。
- 检查镜像更新，执行单项或批量更新、重启容器，取消符合条件的 Docker 任务。
- 查询 Docker 网络、运行环境、创建默认值和宿主设备。
- 预览并执行关机、重启、受支持的插件卸载、阵列启停和校验控制。
- 查询任务结果与恢复信息，断线重连后继续订阅进度。

接口说明见 [API 文档](docs/api.md)。宿主支持范围以 [兼容性合同](contracts/compatibility.json) 为准，最低 OS 版本不代表所有新版本均支持写操作。

## 使用要求

- Linux x86_64 Unraid，配有兼容的官方 API 和现有 x64 Node 运行时。安装器不会安装这些依赖。
- 安装和卸载需要管理员权限，期间可能短暂重启官方 API。

## 安装

1. 打开 Unraid WebUI，进入 **Plugins（插件）**。
2. 选择 **Install Plugin（安装插件）**。
3. 将以下地址粘贴到输入框：
   ```text
   https://raw.githubusercontent.com/mccray-s/unraid-deck-bridge/main/unraid-deck-bridge.plg
   ```
4. 点击 **Install（安装）**，等待安装完成。
5. 打开 **Unraid Deck**，选择对应服务器，在 **设置 → Unraid Deck Bridge** 刷新状态，确认显示 **可用**。如果 API 重启导致连接中断，先重新连接。

安装器会自动下载并校验配套安装包。插件已登记不代表启用已完成；如有安装或可用性错误，先解决问题再使用管理功能。

## 卸载

1. 打开 Unraid WebUI，进入 **Plugins（插件）→ Installed Plugins（已安装插件）**。
2. 找到 **Unraid Deck Bridge**（`unraid-deck-bridge`）。
3. 点击 **Remove（卸载）**，确认后等待卸载完成。

卸载会删除 Bridge 自身的设置和任务记录，不会删除现有 Docker 容器、镜像、卷或用户模板。卸载期间官方 API 可能短暂重启。

## 许可

Bridge 源码采用 **GPL-2.0-or-later**，见 [LICENSE](LICENSE)。第三方组件保留各自许可，见 [第三方归属声明](vendor/README.md)。
