; WorkSylar 安装器扩展
;
; 部分终端安全软件（实测：深信服 UD Protect + 腾讯电脑管家）会：
;   1. 拦截未签名 Electron exe 的运行；
;   2. 拦截安装器写 HKCU 注册表与创建快捷方式（文件解压却可以成功）。
;
; 标准桌面快捷方式未创建成功时，回退到同目录下的浏览器应用模式安装器：
; 由受信任的 PowerShell / Edge / Chrome 完成快捷方式与控制面板卸载项，
; 保证在受管终端上仍然“装得上、点得开”。

!macro customInstall
  ${IfNot} ${FileExists} "$DESKTOP\WorkSylar.lnk"
    ${If} ${FileExists} "$INSTDIR\Install-WorkSylar.ps1"
      DetailPrint "标准快捷方式创建失败，回退到浏览器应用模式安装..."
      ; 不显式传 URL：脚本会读取环境变量 WORKBUDDY_URL，未设置时用默认地址。
      ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\Install-WorkSylar.ps1"'
    ${EndIf}
  ${EndIf}
!macroend
