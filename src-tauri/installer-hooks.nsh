; Kinshoko 的 NSIS 安装包钩子（#70），由 tauri.conf.json 的 bundle.windows.nsis.installerHooks 引入。
;
; 打标子进程（同一个 exe 的 `tagger` 子命令，#52）经 ONNX Runtime 用 DirectML 推理，
; DirectML.dll 必须放在 kinshoko.exe 旁边。cargo 构建时 ort 把它复制到 target/release/；
; 打包发生在构建之后，所以这里在安装时复制，而不是放进 bundle.resources（那会让没有先做
; release 构建的 cargo check／clippy 因为找不到文件而失败）。

; 在引入时记下本文件所在目录（src-tauri）；宏展开时 __FILEDIR__ 已是生成的安装脚本目录。
!define KINSHOKO_HOOKS_DIR "${__FILEDIR__}"

!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File "${KINSHOKO_HOOKS_DIR}\..\target\release\DirectML.dll"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\DirectML.dll"
!macroend
