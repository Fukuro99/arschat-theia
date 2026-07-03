# ビルド・起動メモ (足場構築時点)

作成: 2026-07-04 / 対象: 初期足場 (`generator-theia-extension` によるElectronアプリ生成〜起動確認まで)

## 環境

- OS: Windows 11 Pro
- Node: v24.14.1
- npm: 11.11.0
- Yarn: 1.22.22 (`npm install -g yarn` で導入。`corepack enable` は `C:\Program Files\nodejs\pnpx` への書き込みでEPERMになり失敗したため、npmグローバルインストールに切り替えた)
- Theia: **1.71.2** にピン留め (Community Release 2026-05相当の最終パッチ版。1.71.0/1.71.1/1.71.2が存在し、1.71.2を採用)
- generator-theia-extension: 0.1.48 (デフォルトのTheiaバージョンは1.73.1だったため `--theia-version 1.71.2` で明示指定)

## 生成手順

`npx --yes yo theia-extension --help` は「generatorが見つからない」エラーになった(npxのnpm実行コンテキストでは`generator-theia-extension`が解決されなかった)。
そのため、一時ディレクトリに `yo` と `generator-theia-extension` をローカルインストールし、`node .../yo/lib/cli.js theia-extension <name> [options]` の形で直接起動した。

非対話実行のポイント:
- `--extensionType=widget` を明示しないと `? The extension's type` の対話プロンプトで停止する(値は `hello-world` / `widget` / `labelprovider` / `tree-editor` / `tree-widget` / `empty` / `backend` / `no-extension` のいずれか)
- `--theia-version=1.71.2` でバージョンピン留め
- `--browser=false --electron=true` を指定したが、生成物のworkspacesには `browser-app` も含まれる(package.jsonのみで軽量なので実害なし。ビルド・起動はelectronのみ実行すれば要件を満たす)
- `--skip-install` でインストールは別途 `yarn install` に一本化

実行コマンド(記録):
```
node <tmp>/node_modules/yo/lib/cli.js theia-extension arschat-core \
  --extensionType=widget \
  --browser=false --electron=true --vscode=true \
  --author="Fukuro99" --version="0.0.1" \
  --description="ArsChat Theia PoC core extension" \
  --license="MIT" \
  --githubURL="https://github.com/Fukuro99/arschat-theia" \
  --theia-version="1.71.2" \
  --skip-install
```

## 遭遇した問題と解決策

### 1. corepack enable が EPERM で失敗
`corepack enable` が `C:\Program Files\nodejs\pnpx` の書き込みで `EPERM` エラー。管理者権限昇格はせず、`npm install -g yarn` (v1.22.22 = Yarn Classic) で代替した。Theiaのビルドスクリプト自体はyarn/npm workspacesどちらでも動くため実害なし。

### 2. `npx --yes yo theia-extension --help` がジェネレーターを発見できない
npxの一時実行コンテキストでは `generator-theia-extension` がグローバル解決されず「見つからない」エラー。`yo` と `generator-theia-extension` を明示的にローカルインストールしたディレクトリから `node .../yo/lib/cli.js` を直接呼ぶことで解決。

### 3. `theia rebuild:electron` でのネイティブモジュールビルド
`node-pty` / `keytar` / `drivelist` / `native-keymap` 等のネイティブアドオンの再ビルドは **無修正で成功**。既存ArsChatでnode-ptyが動く環境だったため、Windowsネイティブビルドツール(MSVC/Python等)は問題なく機能した。Node 24との互換性問題は今回発生しなかった。

### 4. `terser-webpack-plugin` が見つからずwebpackビルド失敗 【最重要】
`npm run build:electron` で以下のエラー:
```
[webpack-cli] Error: Cannot find module 'terser-webpack-plugin'
Require stack:
- electron-app\gen-webpack.node.config.js
```
原因: Theia 1.71.2の `@theia/application-manager` が生成するwebpack設定 (`gen-webpack.node.config.js`) は `terser-webpack-plugin` を `require` するが、`@theia/application-manager` および `@theia/native-webpack-plugin` の `package.json` のどちらの `dependencies` にも `terser-webpack-plugin` が含まれていない(webpack本体もこれをpeerDependency相当として同梱しない)。Theia本体パッケージの依存漏れと見られる。

**解決策(Theia本体は無改変)**: 自分たちの `electron-app/package.json` と `browser-app/package.json` の `devDependencies` に `"terser-webpack-plugin": "^5.3.11"` を追加し、`yarn install` で解決させた。node_modules内のTheiaパッケージ自体は一切変更していない。

### 5. Windows日本語コンソールの文字化け
`taskkill` 等のOSコマンド出力がGit Bash上で文字化けする(cp932関連)が、動作自体への影響はない。無視して問題ない。

## ビルド・起動確認結果

- `yarn install`: 成功(deprecation warningのみ、致命的エラーなし)
- `npm run build:electron`(`theia rebuild:electron` → `theia build --mode development`): 成功
- `npm run start:electron`: 成功。ログ上の到達点:
  - `Theia app listening on http://127.0.0.1:<port>`
  - `Changed application state from 'initialized_layout' to 'ready'`
  - `All frontend contributions settled`
  - エラーなし(WARNのみ: 未設定preferenceの警告、一部コントリビューションの初期化が100ms/50ms目標を超過、いずれも致命的でない)
- プロセス生存確認: `electron.exe` が6プロセス(main/renderer/GPU/utility等)起動し、約40秒以上安定して稼働していることを確認後、`taskkill /F /IM electron.exe` で全プロセスを終了した。

## 次のステップ(PoC-1)へのメモ

- **electron-main の拡張ポイント**: `electron-app/src-gen/backend/electron-main.js` が `theia build` のたびに再生成される実際のelectron mainエントリポイントだが、ここは自動生成物なので直接編集しない。カスタマイズは `arschat-core` 拡張側で行う:
  - Theiaのelectron-main層は `@theia/core/lib/electron-main/electron-main-application-module` が提供する `ElectronMainApplication` をDIコンテナで扱っている。トレイ常駐・グローバルショートカット・第2ウィンドウ(BrowserWindow)などは、`arschat-core` 拡張の中で **electron-main向けのfrontendModule/backendModule相当のcontribution** (`ElectronMainApplicationContribution` のrebind、または `ElectronMainApplication` のサブクラス化 + `electronMainApplicationModule` のrebind)として実装するのがTheiaの標準パターン。
  - `arschat-core/package.json` の `theiaExtensions` に現状 `frontend` のみ登録されている。electron-main側のモジュールを追加する場合は `"electronMain": "lib/electron-main/xxx-module"` のようなエントリを追加する必要がある(要調査・POC-1で実施)。
  - `electron-app/package.json` の `dependencies` に `arschat-core` が既に含まれているため、`arschat-core` 側に electron-main 用モジュールを追加するだけで `theia rebuild:electron` 後に反映される見込み。
- yarn.lockはコミット対象(再現性確保のため)。node_modules配下のTheiaパッケージは一切改変していないので、EPL-2.0の開示義務は発生しない。

## PoC-1 実装メモ (electron-main カスタマイズ自由度検証)

### 使ったDIポイント

- **`rebind(ElectronMainApplication)`**: `@theia/core/lib/electron-main/electron-main-application.d.ts` の `ElectronMainApplication` クラスの doc comment に「`extend and rebind the ElectronMainApplication class` すればデフォルトの起動コマンドや挙動を上書きできる」と明記されている、公式にサポートされたパターン。今回は `onWindowAllClosed` protected メソッドをオーバーライドするためだけにサブクラス化した(`ArschatElectronMainApplication extends ElectronMainApplication`)。
- **`bind(ElectronMainApplicationContribution).toService(...)`**: `electron-main-application-module.js` で `bindRootContributionProvider(bind, ElectronMainApplicationContribution)` によりマルチバインド用のcontribution providerとして登録されている拡張ポイント。ここに `ArschatTrayContribution` と検証用の `ArschatPoc1AutotestContribution` を追加した。`onStart(application)` が electron-main起動シーケンスの `startContributions()` フェーズ(`app.whenReady()` 後、バックエンド起動・セキュリティトークン付与の後)で呼ばれるため、`Tray` / `globalShortcut` / `BrowserWindow` などElectron APIをそのまま安全に呼べるタイミングになっている。

これら2つの登録は `arschat-core/src/electron-main/arschat-electron-main-module.ts` の `ContainerModule((bind, unbind, isBound, rebind) => {...})` 内で行い、`arschat-core/package.json` の `theiaExtensions` に
```json
{ "electronMain": "lib/electron-main/arschat-electron-main-module" }
```
を追加することで、Theiaのelectron-mainビルド(webpack)が自動的にこのモジュールを検出してバンドルに含めた(`theia build` のログに `../arschat-core/lib/electron-main/*.js` が electron-main チャンクとして出力されることを確認)。

### rebindは必要だったか

**1-1(トレイ常駐)についてのみ必要だった。** 理由: `ElectronMainApplication#onWindowAllClosed` は
```js
onWindowAllClosed(event) {
    if (!this.restarting) {
        this.requestStop(); // = app.quit()
    }
}
```
という実装で、`window-all-closed` イベントで無条件に quit する。これを止めるための設定値・preference・contributionフックは一切存在しない(`hookApplicationEvents()` は `protected` で `app.on('window-all-closed', this.onWindowAllClosed.bind(this))` を直接呼んでいるだけ)。よって、動作を変えるには「クラスをサブクラス化してメソッドをオーバーライドし、DIコンテナ内の元のバインディングをrebindで差し替える」以外の方法がない。これがTheia側の唯一の想定拡張手段であり(doc commentにも明記)、node_modules配下を直接編集する必要はなかった。

1-2(globalShortcut)・1-3(ウィジェットウィンドウ)は、Electron本体のAPI(`globalShortcut.register`, `new BrowserWindow(...)`)を `ElectronMainApplicationContribution#onStart` 内で直接呼ぶだけで済み、rebindは不要だった(通常のcontribution追加のみ)。

### ハマった点

1. **`Tray` / `BrowserWindow` 等の型解決元**: `arschat-core` は `@theia/core` にしか依存しておらず、素直に `import { Tray } from 'electron'` すると型解決できるかが不明だった。調べたところ、Theia本体のelectron-main層自身が `@theia/core/electron-shared/electron`(実体は `@theia/electron/shared/electron` 経由で本物の `electron` パッケージを `export =` で再輸出しているだけ)経由でElectron型・APIを参照している。これに倣い `import { app, Tray, Menu, globalShortcut, BrowserWindow, nativeImage } from '@theia/core/electron-shared/electron'` とすることで、追加のpackage.json依存なしに型・実体とも解決できた。webpack側もこの `electron-shared` エイリアスを解決してバンドルする(ログの `external "electron"` 出力からも、最終的に実行時は素の `electron` モジュールとして解決される構成と確認)。
2. **トレイアイコンのアセット**: `tsc` は `.png` 等の非TSファイルを `src/` → `lib/` に自動コピーしないため、`resources/tray-icon.png` を単純に置くだけではビルド後に読めなくなる(パス解決の問題以前に、コピー漏れでファイル自体が存在しない)。回避策として、16x16単色PNGをNode標準の `zlib.deflateSync` のみで自前生成するスクリプトを一度実行し、生成物をBase64文字列として `arschat-tray-icon.ts` に埋め込み、実行時に `nativeImage.createFromDataURL('data:image/png;base64,...')` で読み込む方式にした。ファイルコピーの仕組みに依存しない、確実な方法。
3. **GUIが見えない検証環境での自動確認**: 手動でホットキーを押したりトレイをクリックしたりできないため、`ARSCHAT_POC1_AUTOTEST=1` 環境変数でのみ有効化される `ArschatPoc1AutotestContribution` を追加。起動3秒後に `ArschatTrayContribution.toggleWidgetWindow()` をコードから直接呼んでウィジェットウィンドウ生成を検証、10秒後に全ウィンドウを `close()` してトレイ常駐(=quitされないこと)を検証、という流れをログの `[PoC-1]` プレフィックスで追跡できるようにした。デフォルト(環境変数未設定)では何もしない完全な no-op になるようフラグ化済みで、本番相当の起動(`npm run start:electron` 素の実行)でもこのコードが悪影響を与えないことを確認済み。
4. **rebindの構文**: `ContainerModule` のファクトリ関数は `(bind, unbind, isBound, rebind)` の4引数を受け取れる(inversifyの仕様)。最初 `bind(...).toService(...)` で置き換えようとして誤りに気づき、正しくは第4引数の `rebind(ElectronMainApplication).toService(ArschatElectronMainApplication)` を使う必要があった。

### 実機ログでの確認結果(要旨)

`ARSCHAT_POC1_AUTOTEST=1` 起動時:
```
[PoC-1] tray created successfully - app will stay resident after all windows are closed
[PoC-1] globalShortcut.register('CommandOrControl+Shift+Space') === true
[PoC-1] globalShortcut.register('CommandOrControl+Shift+W') === true
...
[PoC-1][autotest] t+3s: programmatically opening widget window (simulating hotkey)
[PoC-1] widget window created successfully (360x480, frameless, always-on-top)
[PoC-1][autotest] t+3s: widget window alive === true -> PASS
[PoC-1][autotest] t+10s: closing 2 window(s) total (main Theia window(s) + widget)
[PoC-1] widget window closed (main Theia windows unaffected)
[PoC-1] onWindowAllClosed suppressed (tray-resident mode) - app stays alive
[PoC-1][autotest] t+13s: process still alive after closing all windows -> PASS (tray-resident behavior confirmed)
```
エラー・例外は一切出力されなかった。通常起動(環境変数なし)でも `[PoC-1][autotest]` 系のログは一切出力されず(no-op確認)、tray生成・globalShortcut登録は成功、`ready` 状態まで到達し、`electron.exe` プロセス(main/renderer/GPU/utility等、5〜6プロセス)の生存を確認後 `taskkill /F /IM electron.exe` で終了した。
