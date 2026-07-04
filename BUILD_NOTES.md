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

## PoC-2 実装メモ (チャット主役のワークベンチレイアウト検証)

### 変更したファイル

- `arschat-core/src/browser/arschat-core-widget.tsx`: 生成テンプレートの「ボタン付きサンプルウィジェット」をダミーチャットUI(ヘッダー/メッセージ吹き出し/入力欄)に改装。`title.closable = false` にして、ユーザーがチャットビューそのものを閉じられないようにした(2-1の「常にメインを占有」を強める設計判断)。
- `arschat-core/src/browser/arschat-core-contribution.ts`: `ArschatCoreContribution` の `defaultWidgetOptions.area` を `'left'` → `'main'` に変更。加えて `FrontendApplicationContribution` を実装し `initializeLayout` / `onStart` の両方でウィジェットを開く(理由は下記「ハマった点1」)。
- `arschat-core/src/browser/arschat-ide-dilution.ts`(新規): `ArschatMenuFilterContribution`(`FilterContribution` 実装)。Selection/Go/Terminalメニューを`MenuContribution`型に限定してフィルタで除去。
- `arschat-core/src/browser/arschat-core-frontend-module.ts`: 上記2つのDI登録を追加(`bind(FilterContribution).toService(...)`)。
- `arschat-core/package.json`: `dependencies` に `@theia/editor` / `@theia/monaco` / `@theia/terminal` を追加(フィルタ対象クラスの型・実体を直接importするため)。いずれも `electron-app` 経由で既にワークスペースに解決済みのバージョン(1.71.2)で、新規ダウンロードは発生しなかった(`yarn.lock` に差分なし)。
- `arschat-core/src/electron-main/arschat-electron-main-application.ts`: `getDefaultOptions()` をオーバーライドし、PoC-1のトレイアイコン(base64埋め込みPNG)をウィンドウアイコンとしても流用。
- `arschat-core/src/electron-main/arschat-poc2-autotest-contribution.ts`(新規): `ARSCHAT_POC2_AUTOTEST=1` 時のみ、起動15秒後にメインウィンドウを `capturePage()` でスクリーンショット化し `poc-artifacts/poc2-main-window.png` に保存。
- `arschat-core/src/electron-main/arschat-electron-main-module.ts`: 上記autotestコントリビューションを登録。
- `electron-app/package.json`: `theia.frontend.config` に `applicationName: "ArsChat"` と `preferences: { "workbench.statusBar.visible": false }` を追加。
- `.gitignore`: `poc-artifacts/` を追加(スクリーンショット成果物はコミットしない)。

### 使ったDIポイント・設定ポイント

- **`defaultWidgetOptions.area: 'main'`**(`AbstractViewContribution` 標準オプション): ウィジェットをメインのドックパネルへ配置する、ごく通常のTheia API。特別な拡張は不要。
- **`FrontendApplicationContribution#initializeLayout` / `#onStart`**: どちらも `@theia/core/lib/browser/frontend-application-contribution.d.ts` で定義された標準インターフェースのオプショナルメソッド。`initializeLayout` は「永続化されたシェルレイアウトが存在しない場合のみ」呼ばれるドキュメント通りの挙動を実機でも確認(後述)。
- **`FilterContribution` / `ContributionFilterRegistry`**(`@theia/core/lib/common/contribution-filter`): `ContributionProvider`(`contribution-provider.js:48`)が全ての多重バインド型(`CommandContribution`, `MenuContribution`, `KeybindingContribution`, `FrontendApplicationContribution` 等)に対して汎用的に `applyFilters(contributions, type)` を呼ぶ仕組みを利用。型を `MenuContribution` に限定して `addFilters` することで、対象クラスの「メニュー登録」だけを止め、同じクラスが持つコマンド/キーバインディング/パネル機能は無傷のまま残せる(`@theia/terminal` の `TerminalFrontendContribution` は1クラスが `CommandContribution` / `MenuContribution` / `KeybindingContribution` / `FrontendApplicationContribution` / `TabBarToolbarContribution` / `ColorContribution` に個別バインドされているため、この粒度のフィルタが可能— `terminal-frontend-module.js:79`)。
- **`theia.frontend.config.preferences`**(package.json、コード不要): Theiaにビルトインの `FrontendConfigPreferenceContribution`(`@theia/core/lib/browser/preferences/frontend-config-preference-contributions.js`)が `FrontendApplicationConfigProvider.get().preferences` を読み、各エントリを `PreferenceSchemaService.registerOverride(key, undefined, value)` として登録する。つまり「preferenceのデフォルト値をコードなしで上書きする」公式の仕組みがTheia側に既に存在しており、`workbench.statusBar.visible: false` はここに書くだけで済んだ(独自の `PreferenceContribution` 実装は不要だった — 一度書いてから、この組み込み機構に気づいて置き換えた)。
- **`theia.frontend.config.applicationName`**(package.json): `ApplicationPackage#props` が `package.json` の `theia` フィールドを `ApplicationProps.DEFAULT`(`frontend.config.applicationName` のデフォルトは `'Eclipse Theia'`)に `deepmerge` する(`application-package.ts:82`、`application-props.ts:124-133`)。electron-main側では `getDefaultOptions()` が `title: this.config.applicationName` としてそのままウィンドウタイトルに使う(`electron-main-application.js:496`)。
- **`ElectronMainApplication#getDefaultOptions()` のoverride**: PoC-1で導入済みの `ArschatElectronMainApplication`(rebind済みサブクラス)に追加。`super.getDefaultOptions()` の戻り値に `icon` プロパティを足すだけで、Theia本体が毎回のウィンドウ生成時にこの値を使う(`electron-main-application.js:391` で `...this.config.electron?.windowOptions` と一緒にスプレッドされる)。

### ハマった点

1. **`initializeLayout` が1回目の起動でしか発火しない**: 最初、`ArschatCoreContribution` に `initializeLayout` だけを実装してビルド・起動したところ、**2回目以降の起動でメインエリアが白紙のまま**になった(スクリーンショットで実際に確認)。原因は `initializeLayout` の仕様通り「永続化されたシェルレイアウトが存在しない場合のみ」呼ばれるためで、Electronの `userData` ディレクトリ(`%APPDATA%/electron-app/`)に前回起動時の(チャットウィジェット導入前の)シェル状態が残っていたことが直接の引き金だった。対策として `onStart` でも無条件にウィジェットを open+activate するようにし、「初回はinitializeLayoutで」「以降はonStartで毎回強制」という二段構えにした。加えてウィジェット自身を `closable: false` にして、ユーザー操作でメインエリアが空になる経路自体を塞いだ。PoCの検証環境ではプロセスを `taskkill`/`timeout` で強制終了することが多く、レイアウトが正常に永続化されないケースが多々あったため、この「毎回強制」の設計は実利があった。
2. **`FilterContribution`/`PreferenceSchemaService` は `@theia/core` のメインバレルから型解決できるが、フィルタ対象クラス(`MonacoEditorMenuContribution` 等)は各パッケージのサブパスから直接importする必要がある**: `arschat-core` は元々 `@theia/core` にしか依存していなかったため、`@theia/monaco/lib/browser/monaco-menu` 等をimportするには `arschat-core/package.json` の `dependencies` に `@theia/editor` / `@theia/monaco` / `@theia/terminal` を追加する必要があった。追加後 `yarn install` を実行したが、これらは既に `electron-app` 経由でワークスペースに解決済み(バージョンピン留めのおかげでバージョン衝突なし)だったため、`yarn.lock` に差分は一切発生しなかった。
3. **`npm install` が `yarn.lock` を意図せず巻き込んで書き換えた**: 依存追加後に(誤って)ルートで `npm install` を実行したところ、`yarn.lock` の中身がnpmレジストリURL形式に書き換わる大規模な差分(1798行変更)が発生した。このプロジェクトは yarn 管理(`yarn.lock` がコミット対象、`package-lock.json` は非対象)なので、`git checkout -- yarn.lock` で差分を破棄し、生成された `package-lock.json` を削除した上で `yarn install` に統一してやり直した。教訓: このリポジトリでは依存関係の変更後は必ず `yarn install` を使うこと(`npm install` を混在させない)。
4. **`MenuModelRegistry` にサブメニュー丸ごと削除するAPIが無い**: `unregisterMenuAction(id | Command | MenuAction, menuPath?)` は「特定のリーフ項目」をid単位で消す関数であり、「Selection」「Go」「Terminal」のような**トップレベルメニューまるごと**を消すAPI(`unregisterSubmenu`のようなもの)は存在しない。そのため、個々の `registerMenuAction` 呼び出しを後から取り消すのではなく、`FilterContribution` で「メニュー登録処理そのものを実行させない」アプローチを取った。これはTheia本体を一切変更せず、かつ副作用(コマンド・キーバインディング)を残したまま実現できる、より上流での除去方法として機能した。
5. **package.json の `theia` 設定ブロックに直接アイコン用のキーは存在しない**: `FrontendApplicationConfig`(`application-props.ts`)には `applicationName` はあるが専用の `icon` キーは無い。ただし `theia.frontend.config.electron.windowOptions` は Electronの `BrowserWindowConstructorOptions` 型がそのまま `getDefaultOptions()` にスプレッドされる実装になっており(`electron-main-application.js:391`)、理論上は `windowOptions.icon` にファイルパスを書けば設定自体は可能。ただし、JSON文字列としてファイルパスを書く場合の実行時カレントディレクトリ依存の解決リスクを避けるため、今回はPoC-1と同じ「base64埋め込み + `nativeImage.createFromDataURL` をコードで生成」方式を採用し、`getDefaultOptions()` のoverrideで注入した(package.json設定ではなくコードベースの手段だが、これもTheia本体は無改変)。実行ファイル自体のアイコン(タスクバー上のexeアイコン)はelectron-builderのパッケージング段階の設定であり、このPoCのビルド(`theia build` + `electron .` 相当の起動)のスコープ外。

### 実機ログでの確認結果(要旨)

`ARSCHAT_POC2_AUTOTEST=1` 起動時(プロファイルクリア後の初回起動):
```
[PoC-1] tray created successfully - app will stay resident after all windows are closed
[PoC-1] globalShortcut.register('CommandOrControl+Shift+Space') === true
[PoC-1] globalShortcut.register('CommandOrControl+Shift+W') === true
[PoC-2][autotest] enabled
...
[PoC-2] MenuContribution filtered out: EditorMenuContribution
[PoC-2] MenuContribution filtered out: MonacoEditorMenuContribution
[PoC-2] MenuContribution filtered out: TerminalFrontendContribution
[PoC-2] onStart: chat widget activated (id=arschat-core:widget)
...
[PoC-2] initializeLayout: chat widget opened in main area (fresh layout)
...
[PoC-2][autotest] t+15s: 1 window(s) open, capturing the first one
[PoC-2][autotest] screenshot saved -> C:\Users\takep\source\arschat-theia\poc-artifacts\poc2-main-window.png -> PASS
```
2回目以降の起動(同一プロファイル、ただし前回セッションは `timeout` コマンドによる強制終了で正常終了していない)でも同じログが再現し、`initializeLayout` も含めて毎回発火した(レイアウトが正しく永続化されていなかったため)。いずれの実行でもスクリーンショット上でメインエリアのチャットUI・4項目のみのメニューバー・ステータスバー非表示・ウィンドウタイトル「ArsChat - ArsChat」を確認した。エラー・例外は出力されなかった(スクリプトを`timeout`で強制終了した際に出る `Network service crashed` / `GPU process exited unexpectedly` は検証プロセスの強制終了に起因するものでPoC-2のコードとは無関係)。

## PoC-3 実装メモ (VS Code拡張の実動作検証)

### 追加した依存関係 (electron-app/package.json、すべて1.71.2)

- `@theia/plugin-ext` — VS Code拡張ホスト基盤(plugin host プロセス、API実装)
- `@theia/plugin-ext-vscode` — VS Code互換レイヤー(vscodeスキームのプラグイン解決、`plugin-vscode-init`)
- `@theia/vsx-registry` — Open VSX 連携+拡張ビュー(Extensions)UI

この3つを追加すると推移的に約20の@theiaパッケージが入る(`ai-core`/`ai-mcp`/`scm`/`debug`/`task`/`test`/`console`/`notebook`/`timeline`/`bulk-edit`/`callhierarchy`/`typehierarchy`/`editor-preview`/`search-in-workspace`/`output`/`file-search`/`outline-view`/`userstorage`/`variable-resolver`/`terminal-manager` 等)。すべて1.71.2でピン留めされていることを確認済み(バージョン衝突なし)。**副作用として、PoC-2で「依存に入れないことで構造的に消していた」Run メニューや ActivityBar 項目(検索/SCM/デバッグ/テスト)が復活する。** Phase 1 で `FilterContribution` の対象を拡大して再希釈が必要。

`arschat-core/package.json` にも autotest 用に `@theia/plugin-ext` / `@theia/markers` / `@theia/workspace` を追加(いずれもワークスペース解決済みでyarn.lockへの新規追加なし)。

### プラグインの配置方法(実行時ロード)

- **`theiaPluginsDir`(package.json トップレベル)は実行時に読まれない。** これは `theia download:plugins` (ビルド時ヘルパー)専用の設定。
- 実行時のプラグイン探索は `THEIA_DEFAULT_PLUGINS=local-dir:<絶対パス>` 環境変数、または `theia start --plugins=local-dir:plugins` CLI引数(相対パスはcwd基準)。`electron-app/package.json` の `start` スクリプトに `--plugins=local-dir:plugins` を組み込んだので、通常の `npm run start:electron` で `electron-app/plugins/` が読まれる。
- **`local-dir` に `.vsix` をそのまま置いてもロードされない**: `Only user plugins will be handled by file handlers, please unpack the plugin 'xxx.vsix' manually.` 警告が出てスキップされる。VSIXのzipを `plugins/<publisher>.<name>/` に展開(展開ルートに `extension.vsixmanifest` と `extension/` が来る形)すれば読まれる。これは `theia download:plugins` が生成するレイアウトと同じ。
- VSIX入手は Open VSX REST API: `https://open-vsx.org/api/{namespace}/{name}/latest` のJSONの `files.download` がVSIX直リンク。

### ハマった点

1. **`@vscode/windows-ca-certs` のネイティブビルド失敗でwebpackが停止(最重要)**: `@theia/plugin-ext` → `@vscode/proxy-agent` → `@vscode/windows-ca-certs`(optionalDependency)という依存で、この native addon のビルドが MSVC の「Spectre 軽減ライブラリ」(VSインストーラーの個別コンポーネント)未導入だと `MSB8040` で失敗する。optional なので `yarn install` は成功するが、**モジュールが node_modules に存在しない状態**になり、`theia build` の webpack (node ターゲット) が `Can't resolve '@vscode/windows-ca-certs'` でエラー停止する。Theia生成の `gen-webpack.node.config.js` は `process.platform !== 'win32'` のときだけこのモジュールを IgnorePlugin に入れる実装のため、**Windowsでビルドしているのにモジュールが無い**というこのケースが素通りする。**解決策(Theia本体無改変)**: 自前の `electron-app/webpack.config.js` で `nodeConfig.ignoredResources.add('@vscode/windows-ca-certs')` を無条件追加。実行時は `@vscode/proxy-agent` の `getCaCertificates` が `.catch()` でログして `undefined` にフォールバックするため安全(企業プロキシのTLS傍受環境でWindows証明書ストアを読む機能のみ失われる)。なお `webpack.config.js` は従来 `.gitignore` の `*-app/*` に巻き込まれて未追跡だったため、`!*-app/webpack.config.js` の例外を追加してコミット対象にした(このignore修正が無いとクローン直後のビルドが再現しない)。
2. **ワークスペーストラストダイアログがプラグインactivateをブロック**: 初回起動時に「Do you trust the authors of the files in this folder?」モーダルが出て、応答するまで全プラグインのactivate(テーマ適用含む)が保留される。GUIレス環境では操作できないため、`theia.frontend.config.preferences` に `"security.workspace.trust.enabled": false` を追加して無効化した(preferenceデフォルト上書きのゼロコード機構、PoC-2と同じ)。
3. **素のTheiaには言語定義(language contribution)が無い**: `.js` を開いても languageId が `plaintext` になり、ESLint拡張のlanguage probeが発火せず**エラーも出ずに沈黙する**。monaco-editor-core は言語定義を持たず、`.js`→`javascript` の関連付け・TextMateグラマーはVS Codeビルトイン拡張(`vscode.javascript`)が供給するため。Open VSX の `vscode/javascript`(1.95.3)を plugins/ に追加して解決。原因特定には autotest にlanguageIdのログ出力を足して確認した。**実移行ではビルトイン拡張パック(eclipse-theia.builtin-extension-pack 等)の同梱が必須。**
4. **フロントエンド(レンダラー)から `process.env` が見えない**: frontend コントリビューションで `process.env.ARSCHAT_POC3_AUTOTEST` を見るゲートは silent に無効化される(webpackのshimで空)。Theia標準の `EnvVariablesServer`(`@theia/core/lib/common/env-variables`)のRPC経由でバックエンドの環境変数を取得する方式に変更して解決。electron-main 側コントリビューションでは従来どおり `process.env` が直接使える。
5. **ESLint拡張はワークスペースローカルの `eslint` ライブラリが必要**: vscode-eslint はワークスペースの `node_modules/eslint` を解決して使う(見つからないと lint しない)。検証ワークスペースに `eslint@8.57.1` を `npm install` して解決(eslint 8系は `.eslintrc.json` をそのまま読む)。
6. **`npx theia start` は使えない**: パス解決が壊れて `node_modules\node_modules\@theia\cli\bin\theia.js` を探しに行き失敗する。`node ../node_modules/@theia/cli/bin/theia start ...` の直接呼び出し、またはnpmスクリプト経由(`npm run start:electron`)を使う。
7. **検証run同士の干渉**: バックグラウンドで起動した検証runの後始末 `taskkill //F //IM electron.exe` が、後続runのelectronを誤って殺す事故が起きた(イメージ名指定のため全electronプロセスが対象)。runを直列化して解決。同種の検証をする際は注意。

### 検証コード(autotest、いずれも `ARSCHAT_POC3_AUTOTEST=1` 時のみ動作)

- `arschat-core/src/browser/arschat-poc3-autotest-contribution.ts`(frontend): t+10s に `HostedPluginSupport.plugins` のデプロイ済みプラグイン一覧をログ出力+ワークスペースの `sample.js` をエディタで開いてlanguageIdをログ、t+18s に `vsxExtensions.toggle` で拡張ビューを開く、t+26s に `ProblemManager.findMarkers()` の全マーカー(owner/uri/message)をダンプしESLint由来マーカーの有無を判定。
- `arschat-core/src/electron-main/arschat-poc3-autotest-contribution.ts`(electron-main): PoC-2と同じ `webContents.capturePage()` 方式で t+22s に `poc3-main-window.png`、t+30s に `poc3-extensions-view.png` を保存。

### ビルドサイズ・起動時間への影響

- ビルド成果物: `electron-app/lib` 全体で約235MB(frontend 176MB / backend 57MB、development modeビルド)。プラグイン4種(VSIX+展開後)は約25MB。node_modules の @theia パッケージ数は 25→45。
- 起動時間: warm profile で「All frontend contributions settled: ~1.7〜3.5s / backend起動から ready まで ~3.2〜6.7s」。PoC-2時点と同オーダーで、plugin host の起動は非同期のため体感の起動時間への影響は軽微。プラグインのデプロイ自体は ~30ms、4プラグインのsync ~30ms。
- plugin host は別プロセス(`PLUGIN_HOST(pid) starting instance`)として起動し、GitLensのような重量級拡張のロードもフロントエンドをブロックしない。

## PoC-4 実装メモ (Theia AI + Anthropic + MCP 検証)

### 追加した依存関係 (electron-app/package.json と arschat-core/package.json、すべて1.71.2)

- `@theia/ai-core` — Theia AI基盤(LanguageModelRegistry、AIActivationService等)。PoC-3で`@theia/plugin-ext`の推移的依存として既にnode_modulesに存在していたが、明示的な直接依存として追加。
- `@theia/ai-chat` — チャットセッション/エージェントのモデル層(バックエンド)。
- `@theia/ai-chat-ui` — チャットビューUI(`ChatViewWidget`、`ChatResponsePartRenderer`拡張ポイント)。
- `@theia/ai-anthropic` — Anthropicプロバイダ(`@anthropic-ai/sdk`を内部依存)。
- `@theia/ai-mcp` — MCPクライアント(`@modelcontextprotocol/sdk`を内部依存)。PoC-3で`@theia/plugin-ext`経由で既にnode_modulesに存在。

いずれも1.71.2でnpm registry上に実在することを`npm view @theia/<pkg> versions --json`で事前確認済み(依頼文で例示されたパッケージ名そのままで組めた。撤退条件に該当する事象は発生しなかった)。`yarn install`で追加、`@vscode/windows-ca-certs`のoptionalネイティブビルド失敗(PoC-3から既知、無害)以外のエラーは無し。

### 重要な訂正: Theia AIはデフォルト無効ではない

依頼文の前提「Theia AIはデフォルト無効のはず」は実機調査の結果誤りと判明した。`node_modules/@theia/ai-core/lib/browser/ai-activation-service.js`の`AIActivationServiceImpl`はコンストラクタで`this.isActive = true`と設定するデフォルト実装であり、ソースコード自身のコメントに以下の記載がある:

> Default implementation of AIActivationService marks the feature active by default.
> Adopters may override this implementation to provide custom activation logic.
> Note that '@theia/ai-ide' also overrides this service to provide activation based on preferences, disabling the feature by default.

つまり「`ai-features.ai.enable`のようなpreferenceでAI機能をトグルする」実装は`@theia/ai-ide`パッケージ側が提供するものであり、`@theia/ai-core`単体にその仕組みは無い。本PoCでは`@theia/ai-ide`を依存に加えていないため、`@theia/ai-anthropic`・`@theia/ai-mcp`・`@theia/ai-chat-ui`を依存に追加した時点でAI機能は既に有効状態だった。「AI機能を有効化する」という作業項目自体が不要だったことは、それ自体1.71時点のTheia AI構成の理解として記録に値する。

### 4-1 Anthropic接続: APIキーの経路

`AnthropicLanguageModelsManagerImpl`(`node_modules/@theia/ai-anthropic/lib/node/anthropic-language-models-manager-impl.js`)の`apiKey`ゲッターは:
```js
get apiKey() {
    return this._apiKey ?? process.env.ANTHROPIC_API_KEY;
}
```
という実装で、(1) `ai-features.anthropic.AnthropicApiKey` preference経由で明示設定されたキー、(2) 未設定ならバックエンドプロセスの環境変数`ANTHROPIC_API_KEY`、の優先順位でフォールバックする。preference経由は平文保存になる旨がスキーマのmarkdown descriptionに明記されており(「Use the environment variable ANTHROPIC_API_KEY to set the key securely.」)、本PoCでは環境変数経路をそのまま使う設計にし、preferenceへの書き込みは行っていない。

モデル一覧(`ai-features.anthropic.AnthropicModels`)はデフォルトで`claude-opus-4-7`等5モデルが登録済みのため、追加設定なしでそのまま`FrontendLanguageModelRegistry.getLanguageModels()`から列挙できた。APIキー未設定時は各モデルの`status`が`{ status: 'unavailable', message: 'No Anthropic API key set' }`になる(`calculateStatus()`の実装)。これはUIでも「プロバイダは正しく登録されているが使えない」ことを区別可能にする設計になっている。

### 4-2 MCP: ワークスペーストラストとの相互作用

`McpFrontendApplicationContribution.autoStartServers()`は`WorkspaceTrustService.getWorkspaceTrust()`を見て、ワークスペースが信頼されていない場合は`autostart: true`のサーバーであっても起動をブロックする(`blockedUntrustedServers`に積むだけ)実装になっている。PoC-3で導入済みの`"security.workspace.trust.enabled": false`(preference)がここでも効いており、追加対応は不要だった。もしこのpreferenceが無かった場合、初回起動時の信頼ダイアログに応答するまでMCPサーバーの自動起動が保留される。

サーバーには`@modelcontextprotocol/server-everything`(MCP公式のリファレンス実装、APIキー等の外部認証情報が一切不要で、echo/get-sum等の固定デモツール一式を提供)を選択。`electron-app/package.json`の`theia.frontend.config.preferences`に`ai-features.mcp.mcpServers`として:
```json
"everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"], "autostart": true }
```
を追加するだけで、起動時に自動的に`npx`経由でstdioサーバーが起動し、`MCPServerManager.getTools()`で14個のツール一覧が取得できることを確認した。

### 4-3 カスタムレンダラー: ターゲット選定の理由

`ChatResponsePartRenderer`(`bindRootContributionProvider`によるマルチバインド、`canHandle(response): number`でスコアを返し最高得点のレンダラーが選ばれる設計)は素直な拡張ポイントで、rebind等の特殊な手段は不要だった。

ターゲットに`InformationalChatResponseContent`(kind: `'informational'`)を選んだ理由は、Theia AI自身の未完成箇所を明確に実証できるため。標準の`MarkdownPartRenderer`(`node_modules/@theia/ai-chat-ui/lib/browser/chat-response-renderer/markdown-part-renderer.js`)の`canHandle()`はこのkindにスコア10を返して受理するが、`render()`は:
```js
if (common_1.InformationalChatResponseContent.is(response)) {
    // null is valid in React
    return null;
}
```
と、TODOコメント(`// TODO let the user configure whether they want to see informational content`)付きで意図的に何も描画しない。つまり素の状態ではinformational contentはUI上に一切現れない。`ArschatInformationalPartRenderer`は同じkindに対して`canHandle()`で11を返すことで選択を勝ち取り、実際にバッジ風のReactコンポーネント(アイコン+Markdown本文)で描画する。「ビルドが通る」以上の実証として、素の状態(何も見えない)とPoC後の状態(見える)の差分が明確な題材になった。

### ハマった点

1. **`ContributionProvider`を直接injectしてコントリビューション一覧をログ出力する際のnamedタグ**: `bindRootContributionProvider(bind, ChatResponsePartRenderer)`は内部で`bind(ContributionProvider).toDynamicValue(...).whenTargetNamed(ChatResponsePartRenderer)`という`named`バインディングを使っている。そのため単純に`@inject(ContributionProvider)`するだけでは解決できず、consumer側も`@inject(ContributionProvider) @named(ChatResponsePartRenderer)`とinversifyの`named`デコレータで対にする必要があった(`@theia/core/shared/inversify`から`named`をimport)。
2. **`UserRequest`の必須フィールド**: `LanguageModel.request()`の引数型`UserRequest`は`LanguageModelRequest`(`messages`のみ)を拡張し`sessionId`/`requestId`を必須にしている。autotestから直接呼ぶ際はダミー値(`'arschat-poc4-autotest'`、`Date.now()`ベースのID)を補う必要があった。
3. **`PreferenceService`のimport元**: `@theia/core/lib/browser/preferences`からは型が見つからず(`PreferenceService`はcommon層のシンボル)、Anthropic本体の実装コードに倣い`@theia/core`のトップレベルバレルからimportする必要があった。
4. **`MCP_SERVERS_PREF`はサブパスimportが必要**: `@theia/ai-mcp/lib/common`のバレル(`index.d.ts`)は`MCPServerManager`等のインターフェースのみを再エクスポートしており、preferenceキー定数(`MCP_SERVERS_PREF`)は`@theia/ai-mcp/lib/common/mcp-preferences`から直接importする必要があった(PoC-2でも`FilterContribution`対象クラスの直接サブパスimportで同種のことが起きている)。
5. **チャットビューのスクリーンショットが狭い**: `aiChat:toggle`だけだとAI Chatパネルが右端に極小幅で開く場合があった。`ApplicationShell#resize(600, 'right')`で明示的に幅を広げてからスクリーンショットを撮ることで解決(見た目だけの問題で、コマンド実行自体の合否には無関係)。

### 検証コード(autotest、いずれも `ARSCHAT_POC4_AUTOTEST=1` 時のみ動作)

- `arschat-core/src/browser/arschat-poc4-autotest-contribution.ts`(frontend): t+8sにAnthropicプロバイダ登録・モデル一覧・status・`ANTHROPIC_API_KEY`有無をログ(キーがあれば実際に`LanguageModel.request()`を発火して応答をログ)、t+14sにMCPサーバーの設定・起動状態・ツール一覧をログ、t+17sに`ChatResponsePartRenderer`コントリビューション一覧をログして`ArschatInformationalPartRenderer`の存在を確認、t+20sに`aiChat:toggle`でチャットビューを開いてパネル幅を広げる。
- `arschat-core/src/electron-main/arschat-poc4-autotest-contribution.ts`(electron-main): PoC-2/3と同じ`webContents.capturePage()`方式でt+26sに`poc4-chat-view.png`を保存。
- `arschat-core/src/browser/arschat-informational-part-renderer.tsx`: 4-3のカスタムレンダラー本体(常時有効、autotestフラグに依存しない)。

### 実機ログでの確認結果(要旨、`ANTHROPIC_API_KEY`未設定)

```
[PoC-4][autotest] enabled (frontend)
[PoC-4][autotest] t+8s: 5 language model(s) registered total, 5 anthropic/* model(s)
[PoC-4][autotest]   model id='anthropic/claude-opus-4-7' status='unavailable' message='No Anthropic API key set'
  ...(5モデル分)
[PoC-4][autotest] 4-1 provider registration -> PASS (Claude models enumerable via LanguageModelRegistry)
[PoC-4][autotest] t+8s: backend process.env.ANTHROPIC_API_KEY present = false
[PoC-4][autotest] 4-1 live call SKIPPED - ANTHROPIC_API_KEY not set in this environment. ...
[PoC-4][autotest] t+14s: configured MCP server(s): everything
[PoC-4][autotest] t+14s: running MCP server(s): everything
[PoC-4][autotest] t+14s: MCP server 'everything' exposes 14 tool(s): echo, get-annotated-message, get-env, get-resource-links, get-resource-reference, get-structured-content, get-sum, get-tiny-image, gzip-file-as-resource, toggle-simulated-logging, toggle-subscriber-updates, trigger-long-running-operation, get-roots-list, simulate-research-query
[PoC-4][autotest] 4-2 MCP server start + tool listing -> PASS
[PoC-4][autotest] t+17s: 15 ChatResponsePartRenderer contribution(s) registered: ..., ArschatInformationalPartRenderer
[PoC-4][autotest] 4-3 custom renderer registration -> PASS (...)
[PoC-4][autotest] t+20s: executing command 'aiChat:toggle'
[PoC-4][autotest] chat view opened -> PASS (ai-chat-ui wiring confirmed)
[PoC-4][autotest] screenshot saved -> .../poc-artifacts/poc4-chat-view.png -> PASS
```
エラー・例外は一切出力されなかった(末尾の`Network service crashed`/`GPU process exited unexpectedly`はPoC-2/3同様、検証プロセスを`timeout`で強制終了したことに起因するものでPoC-4のコードとは無関係)。

### ライブAPI検証手順(ユーザー向け)

1. Anthropic APIキーを用意する(`sk-ant-...`形式)。
2. シェルで`ANTHROPIC_API_KEY`環境変数を設定してから`electron-app`を起動する:
   - PowerShellの例: `$env:ANTHROPIC_API_KEY = "sk-ant-..."; $env:ARSCHAT_POC4_AUTOTEST = "1"; npm --prefix electron-app run start`
   - bashの例: `ANTHROPIC_API_KEY=sk-ant-... ARSCHAT_POC4_AUTOTEST=1 npm --prefix electron-app run start`
3. 起動後約8秒で、ログに`[PoC-4][autotest] t+8s: ANTHROPIC_API_KEY detected -> attempting a live request against '...'`に続いて`live Anthropic response: 'PONG'`(または類似の応答)が出力されれば、Anthropicへのライブストリーミング呼び出しが成功している。
4. 手動でチャットを試す場合は、アプリのウィンドウ右上のチャットアイコン(またはコマンドパレットで`AI Chat: Open`に相当する操作、内部コマンドID`aiChat:toggle`)からAI Chatパネルを開き、メッセージを入力して送信する。応答がストリーミングで表示されれば4-1のフル合格。
5. MCPツールの実呼び出しを確認したい場合は、チャットで「echoツールを使ってHelloと返して」のように明示的にツール利用を促す、またはエージェント設定でMCPツールの利用を有効化した上で試す(現時点のautotestはツール一覧取得までを自動検証しており、チャット経由の実呼び出しはAPIキー必須のため未実施)。
6. カスタムレンダラー(4-3)は、エージェントの応答にinformational content(処理中のステータス等)が含まれる場面で、ArsChat独自のバッジ風UI(左に色付きボーダー、infoアイコン付き)として表示されるはずである。標準UIでは同種の情報が非表示になる(意図的な仕様)ため、表示されること自体が差分の証拠になる。

### Theia AI APIの流動性についての所感(1.71.2時点)

- `InformationalChatResponseContent`の扱いが未完成(TODOコメント付きでrender()がno-op)であることからも分かる通り、Theia AIのチャットUI周りは活発に開発中で、コンテンツ種別の追加・レンダリング方針がまだ固まっていない箇所がある。将来バージョンでこの部分の挙動(informational contentをデフォルトで見せるかどうかの設定等)が変わる可能性があり、独自レンダラーで`canHandle()`スコアだけに依存する拡張は、アップストリームが同じkindに対して異なるスコアを返すよう変更された場合に優先順位が崩れるリスクがある(バージョン跨ぎで固定した方が安全)。
- `ReasoningApi`/`EFFORT_REASONING`/`XHIGH_EFFORT`等、Anthropic側のモデル対応表(`DEFAULT_MODEL_MAX_TOKENS`等)が「Claude 4.6+」のような将来モデル名を正規表現で先取りする形でハードコードされている。Theia AI側がAnthropic SDKの世代交代に追従する形でこの種の定数を更新し続ける必要があり、実際のモデルリリースとTheia AI側のリリースサイクルがずれると「新モデルは動くがreasoning UIが出ない」等のギャップが生じ得る。
- MCPの`ai-features.mcp.mcpServers`はJSON形式のfree-form preferenceであり、専用のGUI設定画面は無い(1.71.2時点)。サーバー追加は生JSON編集が前提になっており、VS Code等と比べるとMCP管理体験はまだ最小限。
- `@theia/ai-ide`という「Theia AIのデフォルト無効化+preferenceベースの明示的有効化」を担うパッケージが別途存在すること自体、1.71時点でTheia AI機能群のパッケージ境界がまだ細かく分割されている途中(adopter側がどこまで機能を持ち込むかの裁量が大きい)ことを示している。今回のPoCのように`ai-ide`を経由せず`ai-core`+個別プロバイダ+`ai-chat-ui`だけを直接組み合わせる構成は、Theia公式のフルIDE構成(Theia IDEディストリビューション)とは異なる非標準ルートであり、将来のマイナーバージョンで`ai-core`のデフォルト値自体が変わる可能性は否定できない(現に「デフォルト有効」という前提の食い違いが実際に発生した)。

## Phase 1 M1 実装メモ (パッケージ再編)

作成: 2026-07-04 / 対象: PHASE1_DESIGN.md §2・§9 M1。肥大化した単一パッケージ `arschat-core` を解体し、後続Phaseで差し替え・拡張する単位でドメイン別Theia拡張5個に再編した。**Theia本体(node_modules配下)は一切改変していない。全パッケージ 1.71.2 ピン留め維持。**

### 再編後のパッケージ構成

```
arschat-theia/
├── electron-app/          アプリ本体(依存を新5パッケージに更新)
├── browser-app/           生成物の残置(このワークフローではビルド/起動しない)。arschat-core参照を解消
├── arschat-branding/      「アプリの皮」: electron-main(トレイ/ホットキー/ウィジェットwindow/
│                          ウィンドウアイコン/quit抑止)+ frontendのIDE希釈(メニューフィルタ)
│                          + PoC回帰autotest(1/2/3/4)を集約
├── arschat-providers/     空スケルトン(M2で実装)
├── arschat-chat/          チャットWidget(ArschatChatWidget)+ViewContribution+
│                          カスタムChatResponsePartRenderer
├── arschat-agents/        空スケルトン(M4で実装)
└── arschat-tools/         空スケルトン(M5で実装)
```

### 移動対応表(旧 arschat-core → 新)

| 旧(arschat-core) | 新パッケージ / ファイル | 改名 |
|---|---|---|
| `browser/arschat-core-widget.tsx` (`ArschatCoreWidget`) | `arschat-chat/browser/arschat-chat-widget.tsx` (`ArschatChatWidget`) | クラス名+widget id `arschat-core:widget`→`arschat-chat:widget` |
| `browser/arschat-core-contribution.ts` (`ArschatCoreContribution`) | `arschat-chat/browser/arschat-chat-contribution.ts` (`ArschatChatContribution`) | クラス名+command id `arschat-core:command`→`arschat-chat:command` |
| `browser/arschat-informational-part-renderer.tsx` | `arschat-chat/browser/arschat-informational-part-renderer.tsx` | 同名(チャット応答描画なのでchatに所属) |
| `browser/style/index.css` | `arschat-chat/browser/style/index.css` | 同一 |
| `browser/arschat-core-widget.test.ts` + `configs/jest*` | `arschat-chat/browser/arschat-chat-widget.test.ts` + `configs/` | 参照クラス名のみ更新 |
| `browser/arschat-core-frontend-module.ts` | 分割 → `arschat-chat-frontend-module.ts`(chat) + `arschat-branding-frontend-module.ts`(branding) | — |
| `browser/arschat-ide-dilution.ts` (`ArschatMenuFilterContribution`) | `arschat-branding/browser/arschat-ide-dilution.ts` | 同一 |
| `browser/arschat-poc3/poc4-autotest-contribution.ts` | `arschat-branding/browser/…` | poc4はinformational renderer importを `arschat-chat/lib/...` に変更 |
| `electron-main/arschat-electron-main-application.ts` | `arschat-branding/electron-main/…` | 同名 |
| `electron-main/arschat-tray-contribution.ts` + `arschat-tray-icon.ts` | `arschat-branding/electron-main/…` | 同一(`[PoC-1]`ログ接頭辞は回帰検証のため維持) |
| `electron-main/arschat-poc1/2/3/4-autotest-contribution.ts` | `arschat-branding/electron-main/…` | 同一(REPO_ROOT算出 `../../..` はbranding直下でもリポルート一致) |
| `electron-main/arschat-electron-main-module.ts` | `arschat-branding/electron-main/arschat-branding-electron-main-module.ts` | module名 |

### 判断根拠(PHASE1_DESIGN.md §2 が委ねた点)

1. **レイアウト強制(initializeLayout/onStart)はarschat-brandingではなくarschat-chatに置いた。** §2はfrontendのIDE希釈とレイアウト強制を「アプリの皮」としてbrandingに含めてもよいとしたが、レイアウト強制は「*この*チャットビューを開いてアクティブにする」処理で、対象ウィジェットと不可分。brandingがchatのwidget id/クラスを逆参照する循環気味の依存を避け、ViewContributionはwidgetと同じarschat-chatに同居させた。brandingにはトレイ/ウィンドウ/メニューフィルタという真にシェルレベルの関心だけを残した。
2. **PoC autotest群は全てarschat-brandingに集約した。** §2は「各機能の所属パッケージ、またはbrandingにまとめる — 判断して記録」とした。autotestは複数ドメインを横断し(poc1=トレイ, poc2=レイアウト/ブランディング, poc3=拡張, poc4=AI/MCP)、electron-main側の共通処理がスクリーンショット取得というシェルレベルの操作。回帰検証の入口を1パッケージに集約する方が保守しやすいと判断。poc4のfrontend autotestが検証対象とする `ArschatInformationalPartRenderer` はarschat-chat所属なので、brandingはarschat-chatをworkspace依存する(cross-package DIが正しく機能することは実機のPoC-4 4-3 PASSで確認済み)。
3. **informational-part-rendererはchatに置いた**(brandingではなく)。チャット応答の描画コンポーネントであり、M3の本チャット実装と同じ関心のため。
4. **version は 0.0.0 ではなく 0.0.1 を採用。** 依頼文は「version 0.0.0」と「arschat-coreと同じ規約」の両方を記したが、実際のarschat-coreは0.0.1であり、electron-app/browser-appのworkspace参照も `"arschat-*": "0.0.1"` 形式。既存規約(=arschat-coreの実値)とworkspace解決の一貫性を優先し全パッケージ0.0.1で統一した。
5. **browser-app** は生成物の残置(BUILD_NOTES足場節参照、このワークフローではelectronのみビルド/起動)。dangling になる `arschat-core` 参照を解消するため新パッケージ(chat+3スケルトン)に張り替え、frontendが要求する `@theia/ai-*`/`plugin-ext` 依存も追加してworkspace解決の一貫性を保った。electron専用の `arschat-branding`(electronMainモジュールを持つ)はbrowser-appには含めていない。

### widget id 改名とレイアウトキャッシュ

`arschat-core:widget`→`arschat-chat:widget` へ改名したため、旧セッションで永続化された `%APPDATA%/electron-app/` のシェルレイアウトには古いidが残る。これは**自己修復**する: Theiaは未知widget id(=対応するWidgetFactoryが無い)を復元時に単に破棄し、`ArschatChatContribution#onStart` が毎起動で新idのウィジェットを強制open+activateする。実機ログで `[arschat-chat] onStart: chat widget activated (id=arschat-chat:widget)` を確認、旧idに起因するエラーや空メインエリアは発生しなかった。

### ビルド・検証結果(PHASE1_DESIGN.md §9 M1 完了条件)

1. **`yarn` 全パッケージビルド**: PASS。`arschat-*/lib` を全削除してから `yarn install` → lerna `prepare` が5パッケージを正しいトポロジ順(chat→branding)で `tsc` ビルド、TSエラー0。`npm run build:electron`(rebuild:electron + theia build)も webpack `compiled successfully`。生成された src-gen に5 frontendモジュール + brandingのelectronMainモジュールが登録され、`arschat-core` 参照は0。
2. **Electron起動でエラーなし**: PASS。全autotest実行で `started_contributions` 到達、frontend contributions ロード完了、コード起因のエラー/例外なし(末尾のGPU/Network serviceは検証プロセスの強制終了由来で従来同様無関係)。
3. **`ARSCHAT_POC1_AUTOTEST=1`**: PASS。`tray created successfully` / `globalShortcut.register(...) === true`(Space・W両方) / widget window `alive === true -> PASS` / 全ウィンドウclose後も `process still alive -> PASS`(トレイ常駐)。
4. **`ARSCHAT_POC2_AUTOTEST=1`**: PASS。メニューフィルタ発火(Editor/Monaco/Terminal)、`[arschat-chat] onStart: chat widget activated (id=arschat-chat:widget)`、スクリーンショット取得成功→`poc-artifacts/m1-regression.png` として保存。目視でチャットUIがメインエリア占有・ウィンドウタイトル/タブ「ArsChat」ブランディング維持を確認(初回runは `capturePage` が display surface未準備で失敗、再runで成功 — 従来からのGUIレス環境の既知の揺らぎ。コード起因ではない)。
5. **VSIXデプロイログ**: PASS。`--plugins=local-dir:plugins` が従来通り honored、4 VSIXの `Only user plugins will be handled ... unpack the plugin 'xxx.vsix' manually` 警告(=展開済みディレクトリ側が実デプロイされる従来仕様)、`Deploy plugins list: 35.2 ms` / `PLUGIN_HOST(...) starting instance` を確認。plugins配置と--plugins指定は再編で壊れていない。
6. **参考: PoC-4**(4-1/4-2/4-3) も全PASS。特に 4-3 で arschat-chat 所属の `ArschatInformationalPartRenderer` が ChatResponsePartRenderer contribution provider に登録済み(cross-package DI 正常)を実機確認。

### ハマった点

- **lerna依存順**: branding は arschat-chat の `lib`(informational renderer)を import する。`yarn install`→`lerna run prepare` は package.json の依存関係からトポロジ順を解決するため、branding に `"arschat-chat": "0.0.1"` を宣言しておけば chat が先にビルドされる。宣言し忘れると branding の tsc が `arschat-chat/lib/...` を解決できず失敗する(宣言済みで問題なし)。
- **poc4 autotest の renderer import パス**: 旧 `./arschat-informational-part-renderer`(同一パッケージ相対)を、renderer移動先の `arschat-chat/lib/browser/arschat-informational-part-renderer`(workspace越えのビルド出力参照)に変更する必要があった。TS的にはソース(`src`)ではなく `lib`(=package `files`/`main`解決)を指す点に注意。
- **electron-main autotest の REPO_ROOT**: `path.resolve(__dirname, '..','..','..')` は `arschat-branding/lib/electron-main/` から3つ上=リポルート。arschat-core も arschat-branding もリポ直下の同階層なので算出結果は不変、修正不要だった(確認済み)。

## Phase 1 M2 実装メモ (プロバイダ4種切替)

作成: 2026-07-04 / 対象: PHASE1_DESIGN.md §3・§4・§9 M2・§10・§11。OpenAI / Anthropic / LM Studio / Unsloth Studio の4プロバイダを設定でき、チャットヘッダーのドロップダウンから即時切替できる状態を実装。**Theia本体(node_modules配下)は一切改変していない。全パッケージ 1.71.2 ピン留め維持。**

### §10 リスク精査の結論(最重要): AISettingsService の上書きは agent のモデル解決に自動反映される

M2冒頭で node_modules を読み(改変なし)、§4.2/§10 の未確認事項「`AbstractStreamParsingChatAgent` が `AISettingsService.updateAgentSettings` で上書きした `languageModelRequirements` を自動で読むか」を確定させた。**結論: フロントエンドの LanguageModelRegistry 実装が AISettingsService を自動参照し、しかも agent 自身のセレクタより優先する。** 根拠は以下2ファイル:

1. `node_modules/@theia/ai-core/lib/browser/frontend-language-model-registry.js` の `selectLanguageModels()`:
   ```js
   const userSettings = (await this.settingsService.getAgentSettings(request.agent))
       ?.languageModelRequirements?.find(req => req.purpose === request.purpose);
   const identifier = userSettings?.identifier ?? request.identifier;
   ```
   → `request.identifier`(=agent のインスタンスフィールド由来のセレクタ)より、AISettingsService 側の `identifier` が **`??` の左辺として優先**される。
2. `node_modules/@theia/ai-chat/lib/common/chat-agents.js` の `AbstractChatAgent`:
   ```js
   getLanguageModelSelector(purpose) { return this.languageModelRequirements.find(r => r.purpose === purpose); }
   selectLanguageModel(selector) { return this.languageModelRegistry.selectLanguageModel({ agent: this.id, ...selector }); }
   ```
   → agent は自分の `languageModelRequirements`(インスタンスフィールド)からセレクタを作って registry に渡すだけ。registry 側が上記(1)で AISettingsService を上乗せする。

補足: `node_modules/@theia/ai-core/lib/common/language-model.js` の**バックエンド/common 実装**の `selectLanguageModels()` は AISettingsService を読まない(TODOコメントあり)。**この違いは重要**で、ArsChat agent はフロントエンドで動き `LanguageModelRegistry` はフロントエンド実装にバインドされるため、AISettingsService 参照経路が有効になる。

**設計判断: 両方式を併用(belt-and-suspenders)。** ProviderSwitchService は切替時に (a) `AISettingsService.updateAgentSettings(agentId, { languageModelRequirements })`(registry が native に参照する経路)と (b) ライブ agent インスタンスの `languageModelRequirements` フィールド直書き(base class の fallback 経路)の**両方**を更新する。将来の Community Release で優先順位が変わっても、どちらか一方が効けば解決が壊れない。§4.2 が推奨した「agent 側で明示参照」は、(b) を agent インスタンスに保持することで満たしている(実測では (a) だけで解決していることも autotest ログの `agentRequirementIdentifier` 一致で確認済み)。

### 実装構成

新規パッケージ実装(§2 のスケルトンを実体化):

- **arschat-providers**(§4 の中核):
  - `arschat-provider-preferences.ts`: ArsChat独自の `arschat.provider.active` / `arschat.provider.model` preference(PreferenceContribution + PreferenceProxy)と、4プロバイダの記述子 `PROVIDERS`(各プロバイダの LanguageModel id 生成規則を含む)。
  - `provider-switch-service.ts`: `ProviderSwitchService`。active preference → registered LanguageModel id を解決し、上記(a)(b)両経路で agent のモデル要求を駆動。`ARSCHAT_CHAT_AGENT_ID = 'ArsChat'` 定数もここに置き(agents/autotest が循環依存なしに共有)。
  - `arschat-providers-seed-contribution.ts`: 起動時に LM Studio(`http://localhost:1234/v1`)/ Unsloth Studio(`http://localhost:8000/v1`)を `ai-features.openAiCustom.customOpenAiModels` に id `lmstudio` / `unsloth` で**未登録時のみ**追加(ユーザー編集は上書きしない)。
  - `arschat-m2-autotest-contribution.ts`(frontend): `ARSCHAT_M2_AUTOTEST=1` 時のみ、登録 LanguageModel 一覧ログ・各プロバイダのライブ往復(可能なら)・切替動作の検証。
- **arschat-agents**(M4本実装とは別の暫定 agent、§4.2/§6):
  - `arschat-chat-agent.ts`: `ArschatChatAgent extends AbstractStreamParsingChatAgent`。固定システムプロンプト(`getSystemMessageDescription` を override して返す)、`languageModelRequirements` は非readonly でProviderSwitchServiceが書き換え可能、`defaultLanguageModelPurpose = 'chat'`。
  - `arschat-agents-frontend-module.ts`: 起動時に `ChatAgentService.registerChatAgent` + `AgentService.registerAgent`(Theia純正 `CustomAgentFactory` と同じ二段登録パターン)、続けて `ProviderSwitchService.registerAgent` で agent をswitch serviceに接続。
- **arschat-chat**(ヘッダーUI + 実配線、§4.2/§5):
  - `arschat-chat-widget.tsx`: M1のダミーUIを実装化。ヘッダーにプロバイダ/モデルの2ドロップダウン(ProviderSwitchServiceと双方向同期)、入力欄→`ChatService.sendRequest`→ArsChat agent→ストリーミング応答表示。

依存追加(すべて1.71.2、`@theia/ai-openai` を electron-app / browser-app / arschat-providers に追加。ai-openai の frontend+backend モジュールは theiaExtensions で自動登録)。

### プロバイダごとの LanguageModel id 規則(node_modules 実測)

- Anthropic: `anthropic/<model>`(`anthropic-frontend-application-contribution.js` の `${ANTHROPIC_PROVIDER_ID}/${modelId}`)
- OpenAI official: `openai/<model>`(`openai-frontend-application-contribution.js` の `createOpenAIModelDescription`、`OPENAI_PROVIDER_ID='openai'`)
- LM Studio / Unsloth(custom): **id はプレフィックスなしの生の `id`**。`createCustomModelDescriptionsFromPreferences` が `id: pref.id ?? pref.model` とするため、`customOpenAiModels[].id='lmstudio'` なら LanguageModel id はそのまま `lmstudio`。この差分(custom は無プレフィックス)を ProviderSwitchService の id 解決に反映済み。

### 検証結果(ARSCHAT_M2_AUTOTEST=1、実機ログ)

- **登録 LanguageModel 一覧**: PASS。13モデルが登録され4プロバイダ全て可視:
  - `anthropic/*` 5件(status=unavailable「No Anthropic API key set」)
  - `openai/*` 6件(status=unavailable「No OpenAI API key set」)
  - `lmstudio` 1件(status=ready ※custom は url があれば常時 ready 扱い)
  - `unsloth` 1件(status=ready)
- **切替動作**: PASS。4プロバイダそれぞれに切替 → agent の `languageModelRequirements[chat].identifier` が解決 id と一致することをログで確認(`resolvedModelId === agentRequirementIdentifier`、全4件一致)。これが§10リスク解消の実証。
- **ライブ往復(プロンプト "Reply with exactly: PONG")**: **4/4 SKIP**(この検証環境の制約):
  - Anthropic: SKIP(`ANTHROPIC_API_KEY` 未設定)
  - OpenAI: SKIP(`OPENAI_API_KEY` 未設定)
  - LM Studio: SKIP(`http://localhost:1234/v1/models` 無応答)
  - Unsloth Studio: SKIP(`http://localhost:8000/v1/models` / `:8888` 無応答)
- **スクリーンショット**: PASS。`poc-artifacts/m2-provider-switch.png`(94KB)にチャットUIのヘッダーでプロバイダ「Unsloth Studio」/モデル「unsloth」ドロップダウンが見える状態を保存。
- **ビルド**: PASS。全5パッケージ tsc エラー0、`theia build --mode development` webpack `compiled successfully`。生成 frontend に ai-openai / arschat-providers / arschat-agents モジュール登録、backend に ai-openai backend モジュール登録を確認。
- **jest**(arschat-chat): PASS(2/2、ドロップダウンにプロバイダ選択肢が出ることを含む)。

### ライブ検証手順(ユーザー向け、環境が整ったら)

各プロバイダを実際に往復確認する手順。`ARSCHAT_M2_AUTOTEST=1` を付けると起動12秒後に自動でライブ往復を試行しログ(`[M2][autotest]`)に出力する。手動確認はヘッダーのドロップダウンで対象プロバイダを選び、入力欄に `Reply with exactly: PONG` と送って `PONG` が返ればOK。

1. **Anthropic**: `sk-ant-...` を用意。PowerShell 例:
   ```powershell
   $env:ANTHROPIC_API_KEY = "sk-ant-..."; $env:ARSCHAT_M2_AUTOTEST = "1"; npm --prefix electron-app run start
   ```
   ログに `Anthropic: live round-trip reply='PONG' -> PASS` が出れば合格。
2. **OpenAI**: `sk-...` を用意し `$env:OPENAI_API_KEY` を設定して同様に起動。official モデルは `ai-features.openAiOfficial.officialOpenAiModels`(デフォルトで gpt-5.x 系が登録済み)。
3. **LM Studio**: LM Studio アプリでモデルをロードし「Local Server」を起動(標準 `http://localhost:1234`)。preference の `customOpenAiModels[id=lmstudio].model` を実際にロードしたモデル名に合わせると確実。起動後、ヘッダーで「LM Studio」を選び往復。`http://localhost:1234/v1/models` が応答すれば autotest も自動実行する。
4. **Unsloth Studio**: Unsloth Studio の OpenAI互換サーバを起動(`http://localhost:8000/v1`、環境により `:8888`)。`customOpenAiModels[id=unsloth]` の `url` と `apiKey`(`sk-unsloth-...`)を実値に更新。ヘッダーで「Unsloth Studio」を選び往復。ポートが `:8888` の場合は `url` を `http://localhost:8888/v1` に変更する。

いずれも API キー / URL は preference(`ai-features.anthropic.*` / `ai-features.openAiOfficial.*` / `ai-features.openAiCustom.customOpenAiModels`)または環境変数で設定する。**preference 平文保存の注意**は Theia 純正のスキーマ説明に明記されており(「安全にしたければ環境変数を使え」)、Phase 1 では preference+環境変数運用。KeyStoreService(OSキーチェーン)連携は §4.2 通り M5 ストレッチ。

### ハマった点

1. **preference 系シンボルの import 元**: `PreferenceService` / `PreferenceContribution` / `PreferenceProxy` / `createPreferenceProxy` は `@theia/core/lib/browser/preferences` のバレルには**無く**(そこは preference-contribution と validation のみ再輸出)、`@theia/core` トップレベルバレルから取る(ai-openai 本体もそうしている)。`PreferenceSchema` 型だけは `@theia/core/lib/common/preferences/preference-schema` のサブパスから。M1/PoC で繰り返し出ている「型は core バレル、定数はサブパス」パターンの続き。
2. **`PreferenceSchema` にトップレベル `type: 'object'` は書けない**: スキーマ型は `{ properties, scope?, ... }` で `type` を持たない(ai-core の schema 定義に倣う)。書くと TS2353。
3. **custom endpoint の LanguageModel id が無プレフィックス**: 上述の通り official は `openai/` 付き、custom は生 id。最初 `openai/lmstudio` になると勘違いしかけたが、`createCustomModelDescriptionsFromPreferences` を読んで `id: pref.id ?? pref.model` と確定。ProviderSwitchService の `fixedModelId` で吸収した。
4. **GUIレス環境のスクリーンショットが loading spinner のまま撮れる**: この環境ではワークベンチシェルの attach が frontend page start から ~30秒と遅く、電メイン側の固定ディレイ(t+18s)では読み込み中オーバーレイ(~6KB PNG)しか撮れなかった。対策として capturePage をリトライ化し、**PNGサイズがしきい値(30KB)未満なら「まだ描画前」と判断して4秒間隔でリトライ**、描画済みシェル(~94KB)を撮れるまで待つ方式にした(`show()`/`focus()`/`moveTop()` でサーフェス可用化も併用)。M1 の「初回失敗・再runで成功」の揺らぎを、単一runで自己解決する形に強化。
5. **`ChatService.getAgent` によるルーティング**: `ChatService.sendRequest` は `getAgent(parsedRequest, session)` でハンドラを決める(pinnedAgent / @mention / default agent)。ArsChat agent に確実に流すため、`createSession(undefined, { focus: false }, agent)` で agent を **pinnedAgent** として渡す方式にした(default agent preference に依存しない)。

## Phase 1 M3 実装メモ (自前チャットWidget + セッション永続化 + 履歴パネル)

作成: 2026-07-04 / 対象: PHASE1_DESIGN.md §5・§9 M3。M2 のダミー UI を本実装に格上げし、標準 `ChatSessionStore` によるセッション永続化と左サイドバー履歴パネルを追加した。**Theia本体(node_modules配下)は一切改変していない。全パッケージ 1.71.2 ピン留め維持。旧 ArsChat は参照のみ(ChatWindow.tsx / MessageBubble.tsx の UX)。**

### 実装構成(arschat-chat)

- `arschat-chat-widget.tsx`(本実装): streaming 表示は旧 ChatWindow の `pendingChunksRef`/`rafIdRef` を踏襲し **requestAnimationFrame バッチ描画**(`scheduleRender()`/`flushRender()`)。応答は `ChatResponseModel.onDidChange` で `content[].asString()` を連結。Markdown は自前ユーティリティ、`<think>` は自前パーサで折り畳み表示。画像は貼り付け(`onPaste`)+ドラッグ&ドロップ(`onDrop`/`onDragOver`)で `pendingImages` に溜め、送信時に `ImageContextVariable.createRequest` へ変換して `ChatRequest.variables` に載せる。送信中は **中断ボタン**(`ChatService.cancelRequest(sessionId, requestId)`、requestId は `invocation.requestCompleted` から取得)。M2 のプロバイダ/モデルドロップダウンは維持。
- `arschat-markdown.ts`: **marked 14 + highlight.js + DOMPurify**。§5 が求めた「@theia/core の MarkdownRenderer が使えるか確認」に対する結論は BUILD_NOTES下部「判断: markdownライブラリ」参照。`code` レンダラを override して highlight.js で色付け、出力を DOMPurify でサニタイズしてから `dangerouslySetInnerHTML`。依存は **遅延 require**(module-eval で例外を出すと frontend DI モジュールごと落ちるため、初回描画時に解決)。
- `arschat-think.ts`: 旧 MessageBubble の `parseThinkBlocks` を移植(完全ペア / 孤立クローズ / 未クローズ=思考中 の3ケース)。**Theia の stream パーサは `<think>` テキストタグを thinking パートに変換しない**(native reasoning part のみ変換。`chat-agents.js` 実測)。従って `<think>` は自前で処理する必要がある。
- `arschat-history-widget.tsx` + `arschat-history-contribution.ts`: 左エリアの View。`ChatService.getPersistedSessions()`(= `ChatSessionStore.getSessionIndex()`)で一覧を日時降順表示、クリックで `getOrRestoreSession()` → Widget に復元、新規/削除も。
- `arschat-chat-ui-service.ts`: Widget ⇄ 履歴パネルの疎結合用シングルトン(Emitter 4本)。相互 import による循環を回避。
- autotest: frontend `arschat-m3-autotest-contribution.ts`(モック LanguageModel 登録 + streaming 往復 + 永続化/復元検証)、electron-main `arschat-branding/.../arschat-m3-autotest-contribution.ts`(スクショ)。

### セッション永続化(§5 の確定方針どおり、自前ストア不要)

- electron-app `theia.frontend.config.preferences` に `ai-features.chat.persistedSessionLimit: -1`(無制限)/ `ai-features.chat.sessionStorageScope: "global"` を追加。**default は `workspace` なので global 明示が必須**(node_modules 実測: `SESSION_STORAGE_PREF` default='workspace')。
- `ChatSessionStore` / `ChatSessionNamingService` は **ai-chat の frontend module が既に bind 済み**(`ai-chat-frontend-module.js` 実測)。追加 bind 不要。
- `ChatServiceImpl` が **自動保存**(model 変更を 500ms debounce, maxWait 5s)・タイトル変更時保存・**自動タイトル付け**(`ChatSessionNamingService`)・削除時のストア削除を全部やる。保存先は global スコープで `${configDir}/chatSessions/<sessionId>.json` + `index.json`。→ ArsChat 側は「保存」を一切書いていない。§4「タイトル自動設定」も標準命名サービスで満たされる(最初のユーザーメッセージ由来)。

### 画像添付の実現方式(§5 が「断念可」とした項目 → **実装完了・断念せず**)

Theia AI 1.71.2 の `ChatRequest` には画像フィールドが無い(`text`/`variables`/`displayText`/... のみ)。**画像は variable/context 経由**で渡す:

- `@theia/ai-chat` の `ImageContextVariable.createRequest({ data(base64), mimeType, name })` で `AIVariableResolutionRequest` を作り、`ChatRequest.variables` に載せて `sendRequest`。
- `ChatService.sendRequest` が `resolveChatContext` で variable を解決 → `request.context.variables` に入る。
- `AbstractChatAgent`(`chat-agents.js` L240-264 実測)が resolved image context variable を **`ImageMessage`(`type:'image'`, base64)** に変換して LLM に渡す。inline image(パース済みパート)も別途拾う。
- ArsChat 側 UI: クリップボード貼り付け(`ClipboardEvent.items` の `image/*`)+ドラッグ&ドロップ(`DataTransfer.files`)→ `FileReader.readAsDataURL` で base64 化 → 送信欄下にサムネイル+削除ボタン、送信後はユーザーバブルにサムネイル表示。
- 結論: **マルチモーダル対応プロバイダ(Anthropic/OpenAI)ではそのまま画像がモデルに届く経路が Theia 標準にあり、自前は「添付UI + 送信時 variable 変換」だけで足りる。M3 スコープから外さずに実装。**

### 判断: markdown ライブラリ(@theia/core の MarkdownRenderer は不採用)

`@theia/core` に `MarkdownRenderer`(markdown-it ベース)は在る。しかし `render()` は HTMLElement を返し、コードブロックのハイライトは非同期 `codeBlockRenderer`(Monaco トークナイザ)前提で、**チャンク毎に再描画する React の render() に載せると毎回 Monaco colorizer を引く**ことになり噛み合わない。旧 ArsChat が既に `marked` で描画しているため UX 一致も兼ねて **marked + highlight.js(同期)+ DOMPurify** を採用。依存は arschat-chat に明示追加(marked は workspace 既存、highlight.js/dompurify を追加)。

### 検証結果

- **jest(arschat-chat)**: **10/10 PASS**。内訳: Widget 描画/プロバイダ選択肢(2、既存)、`parseThinkBlocks`(4)、`renderMarkdown`(4: 基本Markdown、**実 highlight.js のコードブロック色付け=`hljs-*` span 生成を確認**、DOMPurify で `<script>` 除去、空入力)。
- **ビルド**: `npm run prepare`(全5パッケージ tsc エラー0)、`npm run build:electron`(webpack `compiled successfully`)。生成 frontend に arschat-chat モジュール(M3コード含む)を確認。
- **電メイン回帰 PoC-1**: **全PASS**(tray created / 両 globalShortcut === true / widget window alive → PASS / 全ウィンドウclose後も process alive → PASS)。M3 変更が electron-main 層を壊していないことを確認。
- **PoC-2**: メニューフィルタ(Editor/Monaco/Terminal filtered out)が毎 run 発火。スクショ capture は下記の環境制約で SKIP。
- **ライブ Electron 検証(ARSCHAT_M3_AUTOTEST=1)**: **この検証サンドボックスで SKIP**。frontend page start はするが **ワークベンチシェルが描画完了せず**(capturePage が ~6KB のローディングオーバーレイのまま、frontend の `onStart` フェーズが `SkillPromptCoordinator` 以降進まない)、frontend autotest(streaming/永続化/復元)も走らなかった。**M3 固有ではないことを ARSCHAT_M2_AUTOTEST=1 の再runで確認**(M2 も同一症状=6KB のまま、frontend autotest 未到達)。M1/M2 実装時は描画に成功していた(94KB PNG)ので、環境側の描画可用性が現時点で不安定。ILogger 経由で frontend ログを stdout に流す仕込みも入れたが、frontend onStart 未到達のため出力なし。
- **スクリーンショット**: シェルが描画されないため、**実レンダリングパイプラインから生成**した。jest(jsdom)で実 `renderMarkdown(parseThinkBlocks(モック応答).response)` の HTML を出力 → 実 `index.css` と Widget マークアップに流し込んだ HTML を puppeteer(同梱 Chrome)で撮影。`poc-artifacts/m3-chat-ui.png`(履歴パネル・思考プロセス折り畳み・Markdown 見出し・**実 highlight.js の TS コードハイライト**・箇条書き・入力バー)/ `m3-history-panel.png`(セッション一覧: タイトル+日時、アクティブ強調、新規/削除)。**実 CSS + 実 Markdown 出力**であり、モックではない描画結果。

### ハマった点

1. **`<think>` は Theia の stream パーサでは分離されない**: `AbstractStreamParsingChatAgent` は native `ThinkingResponsePart`(reasoning API)だけを `thinking` パートにする。テキスト内の `<think>` タグはただの markdown。→ 旧 MessageBubble 同様、Widget 側で自前パース(`arschat-think.ts`)。
2. **highlight.js / dompurify の import(esModuleInterop 無し)**: workspace tsconfig に esModuleInterop が無く(`tsconfig*.json` は無確認変更禁止)、`import x from` が TS1259。CommonJS `require` + `.default ?? mod` で正規化。さらに **module-eval 時に require が例外を投げると frontend DI モジュールごと落ちる**ため、両者を **初回描画時に遅延解決**(`ensureDeps()`)。DOMPurify の CJS は `window` があれば `.sanitize` を持つインスタンス、無ければファクトリなので `typeof sanitize !== 'function'` で `DOMPurify(window)` を明示バインド。
3. **`ChatRequest` に画像フィールドが無い**: 上の「画像添付」節のとおり variable 経由。最初 `ChatRequest` に画像を直接載せようとして詰まり、`image-context-variable.d.ts` と `chat-agents.js` を読んで variable→ImageMessage 経路を特定した。
4. **frontend console.log は stdout に出ない**: Electron の renderer console は devtools 行きで、この検証の stdout ログには乗らない(PoC-3 ハマった点4の派生)。M3 autotest は `ILogger.info`(backend へ RPC)併用にしたが、そもそも frontend onStart 未到達で無効化。将来シェル描画が安定したら ILogger 経路で結果が stdout に出る想定。
5. **履歴パネルの初回 refresh をレイアウト初期化パスから外す**: `getPersistedSessions()` はストレージ初期化(disk I/O)を誘発しうる。View 生成/`initializeLayout` の同期パスで走らせるとシェル復元をブロックしかねないため、`setTimeout(0)` で後追い実行にした(防御的措置)。
