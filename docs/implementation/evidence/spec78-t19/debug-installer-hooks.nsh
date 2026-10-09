; Isolated T19 debug installer. Equivalent to the production hook, using this tree's debug DLL.
!macro NSIS_HOOK_POSTINSTALL
  SetOutPath "$INSTDIR"
  File "C:\Users\yuk1no\.codex\worktrees\spec78-t16-original-crop\kinshoko\target\debug\DirectML.dll"
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\DirectML.dll"
!macroend
