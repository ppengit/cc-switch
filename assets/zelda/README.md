# Zelda 图标资源包

基于原图 `source/original-1.png` 与透明母版 `source/transparent-master.png` 整理的一套可直接复用的图标资源。

## 顶层快捷文件

- `app.ico`
  - Windows EXE 主图标
  - 内含 `16 / 32 / 48 / 64 / 128 / 256`
- `windows-app-icon-256.png`
  - Windows 图标预览 PNG
- `favicon.ico`
- `favicon-16x16.png`
- `favicon-32x32.png`
- `favicon-48x48.png`
  - Web favicon 资源
- `apple-touch-icon.png`
  - Safari / iOS 主屏快捷图标
- `android-chrome-192x192.png`
- `android-chrome-512x512.png`
  - PWA / Android Web 图标
- `android-monochrome-512.png`
  - Android 单色图标
- `ios-app-icon-1024.png`
  - iOS / App Store 主图标
- `logo-mark-1024.png`
- `logo-mark-mono-1024.png`
  - 品牌图标主文件

## 目录

- `sizes`
  - 常用尺寸透明 PNG：`16 / 32 / 48 / 64 / 96 / 128 / 180 / 192 / 256 / 512 / 1024`
- `source`
  - 原图与透明母版
- `delivery`
  - 已整理好的交付版，按平台分组
- `preview.png`
  - 关键资源预览图

## 使用建议

- Windows EXE：优先用 `app.ico`
- Web / PWA：优先用 `favicon.ico`、`android-chrome-192x192.png`、`android-chrome-512x512.png`、`apple-touch-icon.png`
- iOS：优先用 `ios-app-icon-1024.png` 或 `delivery/recommended/ios/AppIcon.appiconset`
- Android：优先用 `delivery/recommended/android/res`
- 品牌展示：优先用 `logo-mark-1024.png`
