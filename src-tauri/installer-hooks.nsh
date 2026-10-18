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

; 数据根目录（#145，ADR-0009）：设置、打标模型等程序数据在 $INSTDIR\data。
; Tauri 的卸载模板只逐个删除自己装的文件，最后 RMDir "$INSTDIR" 不带 /r，不会连带删掉 data。
; 自动更新（/UPDATE）、静默（/S）与被动（/P）卸载一律保留。交互式卸载问一次，默认“否”；
; 确认页上 Tauri 自带的“删除应用数据”勾选框只管旧版本的 %APPDATA%／%LOCALAPPDATA% 目录。
; 注意：手动运行新版安装包、在“已安装”页选“先卸载再安装”时，旧版卸载程序也以交互方式运行，
; 同样会问这一句；选默认的“否”即保留。
!macro NSIS_HOOK_POSTUNINSTALL
  ; 实例锁（data 旁边的 data.lock），程序已退出，删掉它好让 RMDir "$INSTDIR" 能成功。
  Delete "$INSTDIR\data.lock"
  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
  ${AndIfNot} ${Silent}
  ${AndIf} ${FileExists} "$INSTDIR\data\*.*"
    ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "同时删除设置与打标模型？（资料库不受影响）$\r$\n$\r$\n$INSTDIR\data" /SD IDNO IDYES`
      RMDir /r "$INSTDIR\data"
    ${EndIf}
  ${EndIf}
  RMDir "$INSTDIR"
!macroend
