# 联网搜索、抓取与来源图标

使用入口：[联网搜索](../features/web.md)。搜索工具属于桌面扩展，浏览器预览属于用户界面，两者没有浏览器自动化关系。

## 请求管线

WebSearch/WebFetch 使用 DeepSeek 工具服务的 `/v1/tools/search` 和 `/v1/tools/fetch`。凭据由主进程解析；能力快照控制会话是否具备工具，服务状态与凭据在请求时再次检查。

客户端每种操作每实例限制 5 QPS。30 秒总预算包含排队、请求、读取与重试；408、429 和 5xx 可重试，最多三次尝试，尊重 Retry-After。单响应限制 2 MiB，提供给模型的文本还有 32000 字符预算。等待与读取均可取消。

fetch 目标只允许公开 HTTP(S) URL，拒绝 credentials、局域网 IP 和本地主机名。这里校验传给远端服务的目标，不在本机执行目标 DNS/页面抓取；远端解析及访问策略仍属于服务端责任。认证请求禁止重定向，防止 headers 被带到其他主机。

## 结果和引用

模型结果包含网页标题、URL、内容和来源数据，UI 从结构化结果建立来源列表。来源可在正文中引用并在面板展开。显示图标不阻塞工具结果；失败图标退回文字/默认占位，不把图标请求错误变成搜索失败。

## 图标是另一条网络边界

图标下载限制 HTTPS 默认端口，所有 DNS 结果都必须是公共地址，并固定已校验 IP 进行请求；禁用代理、cookie、认证和 Referer，禁止重定向。这样图标加载不会顺带访问本机服务。

单请求总预算 5 秒，并发 4、队列 50，下载最多 256 KiB、解码最多 100 万像素。输出规范化为 32 像素 PNG，最多 16 KiB；缓存最多 128 项，并缓存短期失败，避免每次渲染重复打同一个坏站点。

实际字节嗅探支持 PNG/JPEG/GIF/WebP/ICO，不只信 Content-Type，不接收 SVG。ICO 解码限制帧数、尺寸和位图结构；Windows BMP 型图标只接受实现支持的 BI_RGB 布局，防止异常尺寸引起大内存分配。

## 源码与回归入口

- [工具](../../packages/desktop/src/main/web-tools.ts)、[服务客户端](../../packages/desktop/src/main/web-client.ts)、[图标网络](../../packages/desktop/src/main/web-source-icons.ts)、[图标解码](../../packages/desktop/src/main/web-icon-image.ts)、[来源 UI](../../packages/ui/src/components/AnswerSources.tsx)。
- [工具测试](../../packages/desktop/test/web-tools.test.ts)、[凭据 IPC](../../packages/desktop/test/web-credentials-ipc.test.ts)、[图标测试](../../packages/desktop/test/web-source-icons.test.ts)、[解码测试](../../packages/desktop/test/web-icon-image.test.ts)。
