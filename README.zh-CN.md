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

接口说明见 [API 文档](docs/api.md)。最低宿主要求和模板协议切换边界以 [兼容性契约](contracts/compatibility.json) 为准，历史源码审计记录不是运行时版本白名单。

## 使用要求

- Linux x86_64 Unraid OS 6.12.0 或更新版本、官方 API 4.25.3 或更新版本，以及现有 x64 Node 运行时。安装器不会安装这些依赖。
- 安装和卸载需要管理员权限，期间可能短暂重启官方 API。
- 新版 OS/API 不会仅因缺少源码审计条目而被拒装或统一降为只读。实际运行依赖、官方权限、组件一致性和每项操作的接口／输入检查仍保留。

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

原生登记完成后，后台启用至少延迟 10 秒，再以 2 秒间隔确认连续 3 次 API 状态稳定，启动等待上限为 5 分钟。只有扩展文件或登记需要修复，或运行中的 API 尚未加载目标适配器时，才请求重启 API。启动、鉴权或连接状态无法确认时只等待或报告失败，不强制重启；Core 或 Docker 单独不可用也不会触发 API 重启。

生命周期日志跨重启保存在 `/boot/config/plugins/unraid-deck-bridge/logs/lifecycle.log`，另保留一个 `.1` 轮转文件，每个文件上限 256 KiB。日志记录启动阶段、目标和已加载适配器版本、重启／跳过决定及最终启用状态，不记录凭据。插件已登记不等于后台启用已达到 `READY`。

## 更新与版本标识

包括从 Bridge `0.1.1` 升级在内，均使用正常的 **Plugins（插件）→ Installed Plugins（已安装插件）→ Check for Updates / Update（检查更新／更新）** 流程。不要先卸载，也不要清除设置、任务日志或恢复记录。更新后按需重新连接，并在 Unraid Deck 中确认状态为 **可用**；原生插件已登记不代表后台已就绪。

原生插件、Bridge 和 Core 使用同一个版本标识，例如 `2026.10.29a`。版本采用 `YYYY.MM.DD`，可附加当天的 `a`–`z` 修订后缀，顺序为无后缀日期、`a` 至 `z`，再到下一天。包括 `2026.10.29` 在内的已发布版本保持不可变，修复必须使用新版本标识。完整原生更新历史维护在 [CHANGELOG.md](CHANGELOG.md)。

## 卸载

1. 打开 Unraid WebUI，进入 **Plugins（插件）→ Installed Plugins（已安装插件）**。
2. 找到 **Unraid Deck Bridge**（`unraid-deck-bridge`）。
3. 点击 **Remove（卸载）**，确认后等待卸载完成。

卸载会删除 Bridge 自身的设置和任务记录，不会删除现有 Docker 容器、镜像、卷或用户模板。卸载期间官方 API 可能短暂重启。

## 许可

Bridge 源码采用 **GPL-2.0-or-later**，见 [LICENSE](LICENSE)。第三方组件保留各自许可，见 [第三方归属声明](vendor/README.md)。
