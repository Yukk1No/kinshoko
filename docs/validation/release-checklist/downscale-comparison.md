# 画师电脑：缩小对比（#48，验收约定“图片还原度”一节）

发布前必须完成一次，结果决定缩略图的默认缩小方式。

1. 从 CI 的 `downscale-probe` 工作流下载 artifact `kinshoko-downscale-probe-<提交>`，整个文件夹发给画师。
2. 画师在平时作画的显示器设置下双击 `kinshoko-downscale-probe.exe`，按 `使用说明.md` 做完 26 组，点“保存报告”，把桌面上的 `kinshoko-缩小对比报告-<数字>.zip` 发回。
3. 开发者看 `报告.md` 的计数与留言，把结果填进验收约定“图片还原度”一节的表格。
4. 只有画师明确更偏好编码值空间时才改默认值：把 `crates/kinshoko-core/src/fidelity/render.rs` 的 `DEFAULT_DOWNSCALE` 改成 `Downscale::EncodedValue`，并改 `crates/kinshoko-core/tests/downscale.rs` 里写着默认值的测试。缩略图管线版本随之变为 `v1-encoded`，旧缩略图在打开资料库时作废、按需重建。偏好线性光或看不出区别时保持现状。

- [ ] 已收到画师的报告（日期、显示器、缩放比例）：
- [ ] 结果已补记到验收约定，默认值：线性光／编码值空间（划掉一个）
