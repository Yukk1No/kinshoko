# Axolotl Launcher：图标侧栏与动效参考

调研日期：2026-10-03。对象为 [Mystic-Stars/Axolotl][repo]，官网是 [axlmc.org][site]；官网与仓库互相链接，并注明这是独立的 Minecraft 启动器。固定提交为 [`09d20e8e8433058ea819ce75685408b3808f1988`][commit]（2026-10-02），不是同名 Axolotl Client 或官网页面本身。

证据来自官网说明与固定源码；未安装、运行启动器，未对官网图片作视觉验收，也未测帧率、DPI、屏幕阅读器或窗口材质效果。下文时长是实现参数，不是实际响应测量。

## 图标导航的具体做法

| 部位 | 固定源码中的行为 | 依据 |
| --- | --- | --- |
| 左侧导航轨 | 应用主导航位于左侧，宽度 4rem；主要入口使用独立图标，设置、创建等入口放在下方；它与右侧信息栏是两个部件。 | [App.vue][app] |
| 图标按钮 | 48×48 CSS px，圆形点击面；hover 改变表面色与图标色；主页面和所属子页面分别有选中样式。 | [NavButton.vue][navbutton] |
| 名称提示 | 主要入口附带右侧 tooltip；悬停延迟 200ms，获得键盘焦点立即显示；提示层使用 `role=tooltip`，显示时关联 `aria-describedby`。这些机制不能代替按钮自身稳定的可访问名称。 | [入口配置][app]、[tooltip.ts][tooltip] |
| 焦点反馈 | 公共样式为链接、按钮等提供 `:focus-visible` 外环；不能仅根据这段样式宣称全应用无障碍通过。 | [accessibility.scss][focus] |
| 选中反馈 | 选中背景是位于按钮后方的独立滑块，路由切换后读取按钮位置；上下边各用 150ms 过渡，并按方向加入 120ms 错峰，形成伸缩跟随感。滑块为 `aria-hidden`。 | [NavRail.vue][navrail] |
| 右侧信息栏 | 300px，可收起；收起状态记在本机 localStorage；某些路由强制显示或隐藏。宽度过渡 320ms，并限制在 `prefers-reduced-motion: no-preference`。 | [App.vue][app]、[sidebar-state.ts][sidebar] |

可供 Kinshoko 借鉴的是：图标导航与任务内容分开、名字随 hover／focus 可见、当前位置持续明确、选中变化有方向感。具体图标含义和入口必须围绕资料库、查找参考与参考组确定，不能直接继承启动器的菜单。

## 动画与材质：参考什么，尚未证明什么

- **页面切换是淡入淡出。** 虽然类名叫 `page-slide`，该提交的实现只有 opacity：进入 180ms、退出 120ms。注释明确避免整页 transform 干扰 sticky 元素；进入层按路由变化挂载，不等待异步内容完成。应用开关和减少动画偏好控制这段过渡。[页面层][app]、[global.scss][global]
- **重任务与过渡安排分开。** 辅助函数等 200ms 后再安排空闲执行；这是减少首次数据请求与页面动画竞争的源码意图，未测其收益。[page-transition.ts][settle]
- **减少动画是局部实现。** 页面淡入、右栏展开及部分入口动画有偏好分支；公共样式禁用按钮按压 transform。不过已查看的 NavRail 滑块没有自身的减少动画分支，不能据此承诺所有动效均遵循系统偏好。[global.scss][global]、[App.vue][app]、[defaults.scss][defaults]、[NavRail.vue][navrail]
- **界面表面有主题层次。** 公共变量提供浅色、深色、OLED 表面与品牌色；官网说明可设置强调色、背景和透明效果。具体颜色对图片判断、对比度及视觉疲劳的影响没有本次验收证据。[variables.scss][variables]、[官网][site]
- **桌面毛玻璃与网页模糊不同。** 窗口透明且模糊开启时，源码调用 Tauri 窗口效果：Windows Acrylic、macOS UnderWindowBackground，Linux 跳过；另外存在自定义背景图和组件表面的 CSS 模糊。效果是否可用、开销多少、是否影响图片观感，需要在 Kinshoko 实机验证。[App.vue][app]

对绘画参考软件，动效可解释导航、展开和完成状态；原图展示的色彩、透明度和清晰度应独立验证。启动器的透明背景、发光和投影是可选视觉参考，不构成图片区域也要施加同样效果的依据。

## 框架、复用与许可

固定清单显示桌面为 Tauri 2，前端使用 Vue 3、TypeScript、Vite；图标来自本仓库 assets 包，其构建依赖包含 `lucide-static`。UI 包列有 `@floating-ui/vue`、`reka-ui`、`motion-v` 等依赖；这里核验的图标滑块和页面切换主要通过 Vue 与 CSS 实现，不能因为依赖表出现动画库，就把它视为这些效果的必要条件。[前端清单][frontendpackage]、[桌面清单][desktoppackage]、[assets 清单][assetpackage]、[UI 清单][uipackage]、[NavRail.vue][navrail]

桌面前端及 UI 源码为 **GPL-3.0-only**，不是 MIT 组件库；各包保留各自的许可，品牌素材另有复制限制。此调研只记录交互与实现思路，未把源文件、CSS、品牌或图标资产复制进 Kinshoko。若之后决定复用源码，需针对实际文件和项目许可另作选择；通用图标可从其原始发行项目评估，不把 Axolotl assets 包整体当成自由素材库。[前端 COPYING][frontendcopying]、[UI COPYING][uicopying]、[assets COPYING][assetcopying]、[总 COPYING][copying]

[repo]: https://github.com/Mystic-Stars/Axolotl
[site]: https://axlmc.org/
[commit]: https://github.com/Mystic-Stars/Axolotl/commit/09d20e8e8433058ea819ce75685408b3808f1988
[app]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/apps/app-frontend/src/App.vue
[navbutton]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/apps/app-frontend/src/components/ui/NavButton.vue
[navrail]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/apps/app-frontend/src/components/ui/NavRail.vue
[tooltip]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/packages/ui/src/directives/tooltip.ts
[focus]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/packages/assets/styles/accessibility.scss
[sidebar]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/apps/app-frontend/src/helpers/sidebar-state.ts
[global]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/apps/app-frontend/src/assets/stylesheets/global.scss
[settle]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/apps/app-frontend/src/helpers/page-transition.ts
[defaults]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/packages/assets/styles/defaults.scss
[variables]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/packages/assets/styles/variables.scss
[frontendpackage]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/apps/app-frontend/package.json
[desktoppackage]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/apps/app/package.json
[assetpackage]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/packages/assets/package.json
[uipackage]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/packages/ui/package.json
[frontendcopying]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/apps/app-frontend/COPYING.md
[uicopying]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/packages/ui/COPYING.md
[assetcopying]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/packages/assets/COPYING.md
[copying]: https://github.com/Mystic-Stars/Axolotl/blob/09d20e8e8433058ea819ce75685408b3808f1988/COPYING.md
