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

## Phase 1 M4 実装メモ (ペルソナ + スキル)

作成: 2026-07-04 / 対象: PHASE1_DESIGN.md §6・§9 M4。M2 の暫定 ArsChat agent(固定システムプロンプト)を、**アクティブペルソナの合成プロンプトを反映する本実装**に発展させ、スキル(Markdown+frontmatter)のロード・スラッシュ補完・展開、ペルソナ管理 View を追加した。**Theia本体(node_modules配下)は一切改変していない。全パッケージ 1.71.2 ピン留め維持。旧 ArsChat は参照のみ**(`src/shared/types.ts` の `Persona` 型と `getEffectiveSystemPrompt`、`src/main/skill-manager.ts`、`src/renderer/components/ChatWindow.tsx` のスラッシュ補完UX)。

### agent 登録方式の選択と根拠(§6 が委ねた点)

§6 は「ペルソナ=動的ChatAgent」に2案を提示: **(a)** 単一の ArsChat agent がアクティブペルソナのプロンプトを差し替える / **(b)** ペルソナ毎に個別 agent を `registerChatAgent`/`unregisterChatAgent`。**(a) を選択。** 根拠:

1. **M2 の配線を無改変で維持できる**: ProviderSwitchService は「この1つの agent」の `languageModelRequirements` を駆動し、チャット Widget はこの agent id(`'ArsChat'`)を pinnedAgent としてセッションに渡す。agent id を1つに固定すればセッションルーティング・provider 切替・pinnedAgent の全配線がそのまま生きる。
2. **ペルソナは頻繁に編集される(CRUD)**: 作成/編集/削除の度に agent を register/unregister するのは可動部と失敗面(dangling registration、stale pinned agent)が増えるだけで、§6 自身が「UX上の差異なし」と述べるとおりユーザー可視の利得がゼロ。
3. **システムプロンプトは送信時に動的供給**: `AbstractChatAgent.getSystemMessageDescription()` はリクエスト毎に呼ばれるので、そこで PersonaService から**アクティブペルソナの合成プロンプトを送信時に読む**。ペルソナ切替/編集が次の送信のシステムプロンプトに再起動なし・再登録なしで反映される。

§11 が確認した動的登録 API(`registerChatAgent`)は起動時の1回登録で引き続き使用(`arschat-agents-frontend-module.ts`)。

### 実装構成(arschat-agents)

- `common/persona.ts`: **Theia 非依存**の `Persona` 型 + `composeSystemPrompt()`(旧 `getEffectiveSystemPrompt` のペルソナ分岐を移植: 名前プレフィックス「あなたの名前は「<name>」です。」+ ペルソナ system prompt + スキルカタログ節 + `現在日時:` タグ)+ `DEFAULT_PERSONA`。旧関数の file-browser/open-files/code-editor/memory 節は後続 Phase(tools=M5, memory=Phase 2)のため意図的に持ち込まない。
- `common/skill.ts` + `common/skill-parser.ts`: `Skill` 型 + **gray-matter** による frontmatter パーサ(旧 skill-manager の自前 YAML パーサは移植しない、§6 指示どおり)。`gray-matter` を依存追加(workspace root に `yarn add`)。CJS のため `import matter = require('gray-matter')`(esModuleInterop 無し環境、M3 と同じ正規化)。
- `browser/persona-service.ts`: ペルソナ CRUD + 永続化 + アクティブ管理 + 合成プロンプト供給。永続先は `${configDir}/arschat/personas.json`(`{ personas, activePersonaId }`)。**frontend の `FileService`(RPC で backend fs)+ `EnvVariablesServer.getConfigDirUri()`** で読み書き — これにより arschat-agents は frontend のみで完結し、独自 backend サービス不要(configDir は SessionStore と同じ global スコープ=ワークスペース非依存)。初回起動で DEFAULT_PERSONA をシード。
- `browser/skill-service.ts`: `${configDir}/arschat/skills/*.md` を `FileService` でロード、初回に `/summarize`・`/translate` をシード。スラッシュ展開 `expandInput()`(`/trigger 追加文` → skill 本文 + `\n\n---\n\n追加文`、旧 ChatWindow の展開ロジック移植)。手動 `reload()` を公開しコマンド `arschat-agents:skills:reload` にバインド(ファイル監視ではなくコマンド方式を実装コストで選択。監視は `FileService.watch` で将来追加可能)。
- `browser/arschat-chat-agent.ts`: `getSystemMessageDescription()` を `personaService.getActiveEffectiveSystemPrompt()` にした(M2 の固定プロンプトから発展)。モデル解決の M2 配線(ProviderSwitchService)は不変。
- `browser/persona-management-widget.tsx` + `persona-management-contribution.ts` + `style/index.css`: 左サイドバーのペルソナ管理 View(一覧・「使用中」バッジ・クリックで切替・インライン作成/編集フォーム・削除、最後の1つは削除不可)。§6 が警告する「旧 Settings.tsx(2503行)の巨大単一画面」を踏まないよう **ペルソナだけを扱う小さな専用 View** にした。

### 実装構成(arschat-chat)

- `arschat-chat-widget.tsx`: ヘッダーに**ペルソナドロップダウン**を追加(PersonaService と双方向、`onDidChange` で管理パネルと同期)。入力欄に**スラッシュ補完ポップアップ**(`/` で SkillService の候補、↑↓ で選択・Tab/Enter で確定・Esc で閉じる、旧 ChatWindow の UX 踏襲)。送信時に `SkillService.expandInput()` で `/trigger` を本文展開し、`ChatRequest.text`=展開後本文・`ChatRequest.displayText`=元の `/trigger` 行(Theia の displayText がちょうど旧 app の displayContent に対応)。
- arschat-chat が arschat-agents を workspace 依存(agents は chat に依存しないので循環なし。lerna トポロジ順: providers→agents→chat)。

### 検証結果(ARSCHAT_M4_AUTOTEST=1、実機ログ)

M3 のモック LanguageModel 方式を流用し、**モックが受け取った `system` メッセージ(`actor:'system'` の TextMessage)をログ出力**して合成プロンプトを検査可能にした(`arschat-m4-autotest-contribution.ts`)。実機 Electron で全項目 PASS:

- **(a) ペルソナ切替**: 2ペルソナ作成(アリス=`ALICE_MARKER`/ボブ=`BOB_MARKER`)→切替→送信で、モックが受け取る system プロンプトが「あなたの名前は「アリス」です。…ALICE_MARKER…」↔「…「ボブ」です。…BOB_MARKER…」に切り替わる(`aliceSystemHasMarker=true bobSystemHasMarker=true promptsDiffer=true`)→ **PASS**。
- **(b) スキル一覧ロード**: `count=2 triggers=[/summarize, /translate]` → **PASS**。
- **(c) /スキル展開送信**: `expandInput('/summarize これを要約して')` が本文(要約スキル)を展開、実送信でモックが受け取る user text に本文+追加文が含まれる(`sentBodyToModel=true sentTrailingText=true`)→ **PASS**。
- **(d) 永続化+リロード**: `personas.json` に作成ペルソナが残り、`reload()` で skills/*.md を再読込できる → **PASS**。ディスク上の `~/.theia/arschat/personas.json`(JSON)と `~/.theia/arschat/skills/{summarize,translate}.md`(frontmatter 付き)を直接確認。
- **スラッシュ補完ポップアップ**: autotest が実 textarea に `/` を native value setter + input イベントで打ち込み、`#arschat-slash-popup` に2項目レンダリング(`rendered=true itemCount=2`)→ **PASS**。
- **スクリーンショット**: 実 Electron シェルが**この run では描画された**(M3 の描画不安定が解消)ため実機キャプチャ: `poc-artifacts/m4-persona-switch.png`(101KB、ペルソナ管理パネルにArsChat/アリス/ボブ・ヘッダーにペルソナ「ボブ」ドロップダウン)/ `m4-skill-complete.png`(110KB、入力欄`/`+ `/summarize`・`/translate` の補完ポップアップ表示)。
- **jest**: arschat-agents **11/11**(persona 合成6、skill パーサ5)、arschat-chat **11/11**(既存9 + ペルソナ options 表示1、+ 既存)。
- **M3 回帰(ARSCHAT_M3_AUTOTEST=1)**: streaming round-trip / persistence / restore すべて **PASS 維持**。M4 が M3 を壊していない。
- **ビルド**: 全5パッケージ `npm run prepare` tsc エラー0、`npm run build:electron` webpack `compiled successfully`。gray-matter は frontend バンドル(`vendors-node_modules_gray-matter_index_js.js`)に問題なく取り込まれた(node builtin 未解決の警告なし)。

### ハマった点

1. **`activate(id)` が `Widget.activate()` と衝突**: ペルソナ管理 Widget に `activate(id: string)` メソッドを置いたら基底 `ReactWidget`(→`Widget`)の `activate(): void` とシグネチャ非互換で TS2416/TS2344/TS2345。`activatePersona(id)` に改名して解消。
2. **`FileStat` に `.type` は無い**: skills ディレクトリの子を判定するのに `child.type === FileType.File` と書いたら TS2339。`FileStat` は `isFile`/`isDirectory` の boolean を持つので `child.isFile` に変更(`FileType` import も削除)。
3. **ペルソナ/スキルの永続化に独自 backend を作らない**: 最初 backend サービス経由の fs アクセスを検討したが、frontend の `FileService`(RPC)+ `EnvVariablesServer.getConfigDirUri()` で configDir 配下を直接読み書きでき、arschat-agents を frontend のみに保てた(M3 の SessionStore と同じ global スコープに揃う)。
4. **スラッシュ補完ポップアップのスクショが撮れない(transient UI)**: ポップアップは入力中だけ表示されるため、電メインの単純キャプチャでは persona パネルしか写らなかった。frontend autotest から実 textarea に native value setter + `input` イベントで `/` を注入して React に state 更新させ、ポップアップを描画させた状態で撮る方式にした(t+35s、persona-switch 撮影 t+30s の後・skill-complete 撮影 t+42s の前に発火)。
5. **検証 run でペルソナが累積する**: personas.json は永続化されるので autotest を複数回走らせるとアリス/ボブが `アリス-1`/`ボブ-1` と重複 ID 回避されつつ溜まる(=永続化が効いている証拠でもある)。検証後 `~/.theia/arschat/personas.json` を削除して次回起動で DEFAULT_PERSONA を再シードするクリーン状態に戻した(skills/*.md はシード済みサンプルなので残置)。

## Phase 1 M5 実装メモ (e-2: read/write/edit_file ツール3種を ToolProvider として配線)

作成: 2026-07-05 / 対象: PHASE1_DESIGN.md §7・§9 M5(e-2)。空スケルトンだった arschat-tools を実体化し、`read_file` / `write_file` / `edit_file` の3ツールを **Theia AI の `ToolProvider`(`@theia/ai-core`)として登録**、アクティブな ArsChat ChatAgent(arschat-agents)のリクエストで**ツールとして解決される最小経路**を通した。**承認フロー(UI・write系のconfirm化)は次タスク e-3 の範囲**で、e-2 では Theia 既定の無確認実行に乗る暫定。**Theia本体(node_modules配下)は一切改変していない。全パッケージ 1.71.2 ピン留め維持。**

### ToolProvider 配線(どの層に何を bind したか)

3層構成。node_modules 実測に基づく配線:

1. **`ArschatFileToolsService`(arschat-tools/browser、singleton)**: 実際に fs を触る唯一の場所。Theia の frontend `FileService`(RPC→backend fs)+ `WorkspaceService` + `EnvVariablesServer` を使い、Node `fs` 直叩きを避けた(URI/権限解決が Theia のルールに乗る。M3 SessionStore・M4 PersonaService と同じ FileService パターン)。`path` 引数は絶対パス/URI ならそのまま、相対なら**最初のワークスペースルート**(無ければ configDir)基準で解決。
2. **3つの ToolProvider(`ReadFileToolProvider`/`WriteFileToolProvider`/`EditFileToolProvider`)**: 各々 `@theia/ai-core/lib/common/tool-invocation-registry` の `ToolProvider` インターフェース(`getTool(): ToolRequest`)を実装する薄い `@injectable` ラッパー。`getTool()` は pure なファクトリ(`common/file-tool-requests.ts` の `createReadFileTool()` 等)に `ArschatFileToolsService` を渡すだけ。**`bindToolProvider(Provider, bind)`**(`@theia/ai-core`)で登録。`ToolInvocationRegistryImpl.init()`(`@postConstruct`)が **bind 済み全 ToolProvider を集めて `registerTool(provider.getTool())`** するので、`bindToolProvider` だけで `ToolInvocationRegistry` にツールが載る(追加の手続き不要。node_modules 実測)。
3. **`ArschatToolsRegistrationContribution`(`FrontendApplicationContribution`)**: 起動時(`onStart`)に `ToolInvocationRegistry.getFunctions(read_file, write_file, edit_file)` で**自分の3ツールだけ**を id で解決し、`ArschatChatAgent.setToolRequests(tools)` でエージェントに渡す。base `AbstractChatAgent.invoke()` が `additionalToolRequests` をリクエストのツールへ spread する(`chat-agents.js` L141 実測)ため、**@mention なしで毎 ArsChat 送信にツールが載る**。

エージェント側の受け口は arschat-agents の `ArschatChatAgent` に **`setToolRequests(tools)` 公開メソッド**を追加(base の `additionalToolRequests` は `protected` なので外部から書けない)。M2/M4 のモデル解決・ペルソナ配線は無改変。

**依存/循環**: arschat-tools → arschat-agents(`ArschatChatAgent` を import)を package.json に宣言。agents は tools に依存しないので循環なし。lerna トポロジ順は providers→agents→tools。electron-app / browser-app には既に arschat-tools が依存登録済み(M1 スケルトン時点)なので、frontend モジュールは自動でビルドグラフ・生成 frontend に載る(`electron-app/src-gen/frontend/index.js` に `import('arschat-tools/lib/browser/arschat-tools-frontend-module')` を確認)。

### 承認まわりの暫定措置(e-3 への引き継ぎ、実測込み)

**結論: e-2 では preference 変更も `confirmAlwaysAllow` 付与もせず、Theia 既定の無確認実行に乗せた。** 根拠(node_modules 実測):

- 確認モードの実体は `@theia/ai-chat` の **`FrontendChatToolRequestService.toChatToolRequest()`**(`lib/browser/chat-tool-request-service.js`)がツール handler をラップして `ToolConfirmationMode`(`ALWAYS_ALLOW`/`CONFIRM`/`DISABLED`)で分岐する。
- 既定モードは `chat-tool-preference-bindings.js` の `getConfirmationMode()`: **通常ツール(`confirmAlwaysAllow` 無し)は既定 `ALWAYS_ALLOW`**、`confirmAlwaysAllow` フラグ付きツールのみ既定 `CONFIRM`。つまり**preference を触らなくても、フラグを付けなければ無確認で走る**。
- したがって read/write/edit の3ツールは意図的に `confirmAlwaysAllow` を**付けていない**。read_file は read-only なので恒久的にそれで良い。**write_file / edit_file が無確認で disk を書き換えるのは e-2 までの暫定**(各 provider と `file-tool-requests.ts` に `TODO(e-3)` コメントを明記)。
- 依頼文が案として挙げた「preference `ai-features.chat.toolConfirmation` を ALWAYS_ALLOW にする暫定措置」は**不要だった**(既定が既に ALWAYS_ALLOW のため)。electron-app には PoC-3 由来の `security.workspace.trust.enabled: false` があり、確認モードを読む `trustAwareReader` もブロックしない。
- **e-3 でやること**: write_file / edit_file に `confirmAlwaysAllow: true`(または ArsChat 独自の承認フロー)を与えて既定 ALWAYS_ALLOW から外し、`FrontendChatToolRequestService` が `request.response.fireInteractionNeeded()` で発火する確認 UI(`@theia/ai-chat-ui` の `tool-confirmation` / `toolcall-part-renderer`)を自前 Widget 側で受けて承認ダイアログを出す。`ToolRequest.checkAutoAction`(allow/deny の自動判定フック)や `confirmationTimeout` preference も e-3 の材料。

### edit_file の設計(pure ロジック分離)

文字列置換の中核は Theia 非依存の pure 関数 `common/edit-file.ts` の `applyEdit(content, {oldString, newString, replaceAll})` に切り出した(M4 の skill-parser と同じ「ロジックは common/・DI は browser/」分割)。契約: `oldString` は存在必須、`replaceAll=false`(既定)なら**一意でなければ曖昧として拒否**(先頭マッチを黙って書き換えない)、`newString` は `oldString` と異なること。これで edit の挙動を DI/fs 抜きに unit テストできる。

### 検証結果

- **jest**: **arschat-tools 12/12 PASS**(`edit-file.test.ts` 8: applyEdit の一意/replaceAll/不在/no-op/空/複数行保持/countOccurrences、`file-tool-requests.test.ts` 4: 各ツールの ToolRequest shape=id/providerName/required、handler がフェイク backend 経由で内容返却・作成/上書き・in-place 置換・各種エラー整形、read_file が `confirmAlwaysAllow` 無し=既定 ALWAYS_ALLOW を確認)。**回帰なし: arschat-agents 11/11・arschat-chat 11/11**。
- **ビルド**: 全5パッケージ `yarn prepare`(lerna `tsc`)エラー0。**`yarn build:electron`(canonical 目標)webpack `compiled successfully`**。生成 frontend に arschat-tools モジュール登録を確認。
- **`yarn build:browser` は既知の browser-app 制約で FAIL**: `@vscode/windows-ca-certs` の webpack 解決エラー(PoC-3 ハマった点1と同一)。この ignore 修正は `electron-app/webpack.config.js` にのみ入っており(`nodeConfig.ignoredResources.add('@vscode/windows-ca-certs')`)、`browser-app/webpack.config.js` には無い。**browser-app は BUILD_NOTES 足場節どおり「生成物の残置・このワークフローではビルド/起動しない」対象で、全マイルストーンの canonical ビルドは build:electron。M5 の変更に起因する失敗ではない(既存の browser-app 側の未対応)。** e-2 のスコープ外だが、将来 browser を建てる必要が出たら同じ1行を browser-app 側に足せば解消する見込み。
- **ライブ検証(実際に AI に read_file を頼んでファイル内容が回答に反映される / write・edit が実ファイルを変更する)**: **API キー不在の検証サンドボックス制約で未実施**(M2〜M4 と同じ。ArsChat agent はツール対応の実プロバイダ〔Anthropic/OpenAI〕が ready でないとツールコールを発火できない)。配線は「ToolProvider 登録 → registry 解決 → agent の additionalToolRequests に載る」まで静的に確立済みで、ビルド生成物にも反映されている。実キーでの往復は e-3 の承認 UI 実装とあわせて実機確認する想定。

### ハマった点

1. **provider の jest テストが jsdom を要求してしまう**: 最初 browser の ToolProvider クラスを直接テストしたが、`ArschatFileToolsService` の import が `@theia/filesystem/lib/browser/file-service` → `@lumino/widgets` を引き、node 環境で `document is not defined` になった(arschat-chat が jsdom+setup で回避しているのと同じ壁)。jsdom スタックを tools に持ち込む代わりに、**ToolRequest 生成を pure ファクトリ(`common/file-tool-requests.ts`)に切り出し**、browser provider は薄いラッパーにして、テストは common 側(node 環境)でファクトリ+フェイク backend を叩く形にした。agents の common/ 分割と揃い、tools を素の node jest で回せる。
2. **`ToolRequest` 型の import 元**: `common/file-tool-requests.ts` で `@theia/ai-core` バレルから値 import すると browser 実体を引きかねないため、**`import type { ToolRequest } from '@theia/ai-core/lib/common/language-model'`**(type-only + common サブパス)にして実行時 require を消した(M2/M4 で繰り返した「型は絞った経路から」パターン)。
3. **`additionalToolRequests` が protected**: base `AbstractChatAgent` の `additionalToolRequests` は `protected` で arschat-tools から代入できない。`ArschatChatAgent` に公開メソッド `setToolRequests()` を足して橋渡しした(agent 側の最小変更)。
4. **fresh worktree の依存導入**: worktree は依存未導入だったので `yarn install`(BUILD_NOTES 冒頭の corepack EPERM 回避=yarn classic、terser の件は既に electron/browser-app の devDeps に反映済み)。arschat-tools の package.json に `@theia/ai-chat`/`@theia/ai-core`/`@theia/filesystem`/`@theia/workspace`/`arschat-agents` を追加後、再 `yarn install`(= lerna prepare まで走る)で全パッケージ再ビルドが通った。

## Phase 1 M5 実装メモ (e-3: 承認ダイアログ + ツール実行カード、write系を無確認から卒業)

作成: 2026-07-05 / 対象: PHASE1_DESIGN.md §5(ツールコールカード)・§9 M5(e-3)。e-2 の暫定(write/edit が無確認で disk を書き換える)を解消し、**write_file / edit_file をツール要求時に承認必須**にした。承認 UI と実行状態カードを **自前 ArschatChatWidget** に実装。**Theia本体は一切改変せず、Theia 1.71.2 の確認機構(`FrontendChatToolRequestService` + `ToolConfirmationManager`)にそのまま乗せた。**

### どの Theia 機構に乗ったか(実測で裏取り)

確認の実体は `@theia/ai-chat` の `FrontendChatToolRequestService.toChatToolRequest()`(browser)。これが各ツールの handler をラップし、`ToolConfirmationManager.getConfirmationMode(toolId, sessionId, toolRequest)` の戻り(`ALWAYS_ALLOW` / `CONFIRM` / `DISABLED`)で分岐する(`node_modules/@theia/ai-chat/lib/browser/chat-tool-request-service.js` 実読)。

- **CONFIRM 分岐の挙動**: 対応する `ToolCallChatResponseContent` を response 内から見つけ、`content.requestUserConfirmation()`(= `needsUserConfirmation` promise を解決)+ `request.response.fireInteractionNeeded(content)` を発火し、`content.confirmed`(`raceConfirmationWithTimeout` 経由)を **await して実行を止める**。UI が `content.confirm()` を呼べば `confirmed=true` で resolve → handler 本体(= 我々の write/edit)が走る。`content.deny(reason)` を呼べば `confirmed=false` で `{ denied:true, reason }` を tool result として返し、**handler 本体は実行されない**(受入②を Theia 側が構造的に保証)。
- **confirm-required の立て方**: `getConfirmationMode()` の既定は「`confirmAlwaysAllow` 無し=ALWAYS_ALLOW / 有り=CONFIRM」。かつ `confirmAlwaysAllow` 付きツールはグローバル `'*': ALWAYS_ALLOW` からも CONFIRM に落とす(`chat-tool-preference-bindings.js` 実読)。→ **`createWriteFileTool` / `createEditFileTool` の ToolRequest に `confirmAlwaysAllow`(文字列=always-allow 時の警告文)を付与するだけ**で毎回確認に落ちる(受入③)。`ToolRequest.confirmAlwaysAllow?: boolean | string`(ai-core language-model.d.ts で確認)。read_file は付けず ALWAYS_ALLOW のまま(受入③後段)。
- **セッション/永続スコープ**: 「このセッション中」= `ToolConfirmationManager.setSessionConfirmationMode(toolId, ALWAYS_ALLOW, chatId)`(in-memory Map、非永続)、「常に許可」= `setConfirmationMode(toolId, ALWAYS_ALLOW)`(preference `ai-features.chat.toolConfirmation` に永続)。**状態管理は Theia の manager をそのまま呼び、自前で再発明していない**(引き継ぎ指示どおり)。ai-chat frontend module が両者を `inSingletonScope` で bind 済みなので、追加 bind 不要でそのまま inject できる。

### 自前部分(ArschatChatWidget)

- **カードの view-model `ToolCallView`**: `{ content: ToolCallChatResponseContent, state: 'confirm'|'running'|'done'|'denied', open?, wired? }`。`syncToolCalls()` が response content 中の `ToolCallChatResponseContent.is(c)` 部分を検出し、`content` を key に既存カードと突き合わせて生成/更新(M3 の rAF バッチ repaint にそのまま乗る)。
- **状態遷移の駆動**: `wireToolCall()` が各 content の promise を1度だけ購読 — `needsUserConfirmation`→`confirm`(承認待ち)、`confirmed`→`running`/`denied`、`whenFinished`→`done`/`denied`。ポーリングなし。
- **承認 UI**: `confirm` 状態のカードに **[許可][セッション中][常に許可] + [拒否]**。`onToolAllow(view, scope)` が scope に応じて manager を叩いてから `content.confirm()`、`onToolDeny(view)` が `content.deny()`。
- **カード表示**: 承認待ち(黄・ボタン)→ 実行中(スピナー)→ 結果(✓/✕、出力を `<pre>` で表示、2000字超は折り畳み+`すべて表示`)。拒否は赤・理由表示。復元セッションの過去ツールコールも `syncToolCalls` で done カードとして再表示(`appendRestoredRequest`)。
- **`responseToText` の調整**: tool call 部分は `asString()` が `''` なので元々テキストは汚さないが、明示的に `kind !== 'toolCall'` で除外(将来 kind 追加時の保険)。
- **ついでの小改善(レビュー指摘)**: read_file handler に上限 `READ_FILE_MAX_CHARS = 50,000` を追加、超過時は先頭 5万字 + `...(truncated: ...)` を返す(`file-tool-requests.ts`)。

### 検証結果

- **承認フローの経路検証(ユニット)**: `arschat-chat-widget.test.ts` に3本追加 — (1) `syncToolCalls` で write_file の承認待ちカードが描画され [許可/セッション中/常に許可/拒否] が出る、(2) `onToolAllow(view,'once')` が `content.confirmed` を `true` に resolve し state=running(= handler 本体が走る経路)、(3) `onToolDeny` が `content.finished=true` かつ `result.denied=true`(= tool 実行が止まり denial が LLM に返る経路)。**Theia の `ToolCallChatResponseContentImpl` 実クラスを直接使って**、confirm/deny が本物の状態機械を正しく駆動することを確認(モックではなく実体)。write/edit の `confirmAlwaysAllow` 付与は tools 側テストで検証。
- **jest**: **arschat-tools 14/14**(+2: read_file 5万字 truncation、write/edit が confirm-required)・**arschat-chat 14/14**(+3: 上記カード/承認)・**arschat-agents 11/11(回帰なし)**。
- **ビルド**: `yarn build:electron` webpack **`compiled successfully`**。全パッケージ `tsc` エラー0。
- **ライブ検証(実キーでの往復)**: e-2 同様 **API キー不在の検証サンドボックス制約で未実施**。承認機構は Theia 実ソースの `FrontendChatToolRequestService` 経路に静的に乗っており(await confirmed → handler)、`ToolCallChatResponseContentImpl` 実体を使ったユニットで confirm→実行 / deny→停止 の両分岐を検証済み。実プロバイダでの UI 往復は e-4 以降で実機確認する想定。

### ハマった点

1. **jest が browser confirmation-bindings で死ぬ**: widget が `ToolConfirmationManager`(`@theia/ai-chat/lib/browser/chat-tool-preference-bindings`)を inject するようになった途端、jest が同モジュール→`trust-aware-preference-reader`→`@theia/core/src/browser`(hover-service.tsx 等の DOM ツリー)を辿って `Unexpected token ':'` で落ちた(node_modules は transform-ignore)。widget は**このクラスを DI トークンとしてしか使わない**(メソッドはテストで定数 bind して差し替え)ので、jest の `moduleNameMapper` で当該 browser モジュールだけを軽量スタブ(`configs/stubs/chat-tool-preference-bindings.js`、空クラス)に差し替えて解決。common 側の `ToolConfirmationMode`(enum)や `ToolCallChatResponseContentImpl` は browser を引かないのでそのまま使える。
2. **`confirmAlwaysAllow` の意味論**: 「毎回確認」を出すのに preference を書き換えるのではなく、ツール側の `confirmAlwaysAllow` フラグを立てるのが正解(`getConfirmationMode` が既定 CONFIRM に落とし、かつグローバル `'*': ALWAYS_ALLOW` の上書きも無効化する)。文字列を渡すと always-allow 昇格時の警告文にもなる(`WRITE_TOOL_CONFIRM_WARNING`)。二重の役割を1フラグが担う。
3. **e-2 の handler 戻り型**: read_file の truncation テストで `handler(...)` の戻りが `string | object | ToolCallContent` なので `as string` キャストが要る(ToolRequest.handler の union 型)。

## Phase 1 M5 実装メモ (e-4: run_command を承認必須で実装、arschat-tools 初の backend + RPC)

作成: 2026-07-05 / 対象: PHASE1_DESIGN.md §7・§9 M5(e-4)。ArsChat の `code-editor-manager.ts`(`runCommand`/`detectWindowsShell`)を移植し、**シェルコマンド実行ツール `run_command` を承認必須**で追加。e-2/e-3 は frontend のみだったが、コマンド実行は Node が要るので **arschat-tools 初の backend モジュール + JSON-RPC** を導入した。**Theia 本体は一切改変せず**、Theia 1.71.2 の `RpcConnectionHandler`/`RemoteConnectionProvider` にそのまま乗せた。

### backend/frontend の配線(RPC をどう張ったか)

コマンド実行(spawn)は Node 依存なので frontend bundle には置けない。Theia 標準の JSON-RPC で frontend ToolProvider → backend service を繋いだ(先例=`@theia/file-search` の `FileSearchService`、実ソースで裏取り)。

- **共有プロトコル** `src/common/command-runner-protocol.ts`: service path 定数 `commandRunnerServicePath='/services/arschat-run-command'`、DI symbol `CommandRunnerService`、`RunCommandRequest`/`RunCommandResult` 型。**Theia ランタイム非依存**(plain symbol + interface のみ)なので node/browser 双方から import しても browser/DOM を node build に引き込まない(tool-ids.ts と同じ規律)。
- **backend impl** `src/node/command-runner-service-impl.ts`: `@injectable` な `CommandRunnerServiceImpl`。実際に `spawn` する唯一の場所。
- **backend module** `src/node/arschat-tools-backend-module.ts`: `bind(CommandRunnerService).to(Impl)` + `bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(commandRunnerServicePath, () => ctx.container.get(CommandRunnerService)))`。file-search の backend module と 1:1。
- **package.json** `theiaExtensions` に `"backend": "lib/node/arschat-tools-backend-module"` を frontend と同じエントリに追記(`arschat-branding` の `electronMain` 宣言が先例)。→ 生成 `electron-app/src-gen/backend/server.js` に `load(require('arschat-tools/lib/node/arschat-tools-backend-module'))` が入るのを確認。
- **frontend proxy** `src/browser/arschat-tools-frontend-module.ts`: `bind(CommandRunnerService).toDynamicValue(ctx => ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider).createProxy<CommandRunnerService>(commandRunnerServicePath))`。ai-mcp が使う `RemoteConnectionProvider`(1.71.2 推奨の RPC エントリ)を採用。
- **frontend provider** `src/browser/run-command-tool-provider.ts`: `ToolProvider` かつ `CommandToolBackend`。`getTool()` は pure factory `createRunCommandTool(this)` に委譲。**cwd 解決を frontend が担う**: `WorkspaceService.tryGetRoots()`(無ければ `EnvVariablesServer.getHomeDirUri()`)で絶対 FS パスにしてから RPC に渡す → backend はワークスペース知識ゼロの純粋コマンドランナーに保てる。`run()` は proxy の `runCommand()` を呼ぶだけ。
- **承認**: ToolRequest に `confirmAlwaysAllow`(文字列警告 `RUN_COMMAND_CONFIRM_WARNING`)を付与。e-3 の汎用フロー(`ToolConfirmationManager` が CONFIRM に落とす → ArschatChatWidget が承認カード描画 → confirm/deny)にそのまま乗る。受入①(承認→許可→実行→結果)②(拒否で未実行・denial が LLM に返る)③(「すべて許可」でも毎回確認)は e-3 側で構造的に達成、e-4 は「フラグを立てる」だけ。

### 移植元の2つの穴の修正

1. **出力上限なし** → `common/run-command.ts` の `truncateOutput(stdout, stderr, max=50_000)`。stdout 優先で combined 長を `RUN_COMMAND_MAX_OUTPUT_CHARS`(read_file の `READ_FILE_MAX_CHARS` と同値)に収め、切った側に `...(truncated)` を付す。stderr の予算がマーカー未満なら bare marker で上限超過しないよう stderr を落とす(テストで combined ≤ max を検証)。
2. **timeout 時 `proc.kill()` のみでプロセスツリー残留** → `killTree(proc)`:
   - **Windows**: `taskkill /pid <pid> /T /F`(/T=ツリー /F=強制)。**選定理由**: win32 には POSIX の process-group kill が無く(Node の `process.kill(-pid)` は Windows 非対応)、`taskkill /T` が子孫まで確実に終わらせる Windows 標準手段。ビルドがコンパイラを、`npm` が node を spawn した子孫まで届く。失敗時(既に終了済み等)は `proc.kill()` にフォールバック。
   - **POSIX**: shell を `spawn(cmd, { shell:true, detached:true })` で起動 → setsid 相当で**自分がプロセスグループのリーダー**になる。timeout 時 `process.kill(-pid, 'SIGKILL')` で**グループ全体**に SIGKILL。**選定理由**: 素の `proc.kill()` はシェルにしか届かず孫プロセスを取りこぼす。負 pid のグループ kill が最小コストで孫まで一掃できる。失敗時は `proc.kill('SIGKILL')` にフォールバック。

### pure ロジック分離(unit テスト可能に)

`common/run-command.ts` に Theia/child_process 非依存で切り出し: `buildShellInvocation(command, shell)`(pwsh=UTF-8 プリアンブル+`-NoProfile -Command`、cmd=`chcp 65001 >nul 2>&1 & …`、posix=`{shell:true}` の raw 実行)、`truncateOutput()`、各定数。backend impl は「pwsh 探査(`execSync` probe、3s)→ shell 決定 → `buildShellInvocation` で argv 組立 → spawn」だけを担い、分岐と truncation は node jest で spawn 抜きに検証。

### 検証結果(正直に)

- **jest: arschat-tools 33/33 PASS**(e-3 の 14 から +19)。内訳: `run-command.test.ts` 9(shell 引数組立 pwsh/cmd/posix・特殊文字保持・truncation の各ケース=小/巨大 stdout/combined 上限/custom max)、`command-tool-request.test.ts` 8(ToolRequest shape=confirm 必須・cwd 既定解決・cwd/timeout 透過・結果整形・空コマンド拒否・backend 失敗の ERROR 整形・formatRunResult の timeout/truncated 表示・空 stream プレースホルダ)、**`command-runner-service-impl.test.ts` 3(実 spawn smoke)**: `echo` 出力が返る/非0 exit code 伝播/**timeout で実際にツリー kill され exitCode -1・timedOut・`[timeout]`・全時間待たず終了を確認**(受入⑥=backend サービス単体の RPC ターゲット動作を実プロセスで裏取り)。
- **回帰なし**: arschat-chat 14/14・arschat-agents 11/11。
- **ビルド**: `yarn build:electron` webpack **`compiled successfully`**。全パッケージ `tsc` エラー0。生成 backend bundle に `../arschat-tools/lib/node/*.js` 2 module、`src-gen/backend/server.js` に backend module の `load(...)` を確認。
- **ライブ検証(実キーでの LLM 往復)**: 依頼どおり **e-4 では不要**(e-10 に集約)。ただし backend サービスは上記 smoke テストで実 `echo`/timeout kill まで実プロセスで動作確認済み。

### e-5(web_search/fetch_page — これも backend 処理)への引き継ぎ

**backend ツールを追加する手順は、e-4 で足場が済んだので次からは frontend 承認ツール(e-3)+ RPC 1 本 = 実質 6 ステップ**:
1. `common/<x>-protocol.ts` に service path 定数 + DI symbol + Request/Result 型を定義(**Theia 非依存**を厳守=node/browser 両 build を汚さない)。
2. `common/<x>.ts`(pure ロジック)+ `common/<x>-tool-request.ts`(`createXTool(backend)` factory、`confirmAlwaysAllow` 付与)。
3. `node/<x>-service-impl.ts` に `@injectable` 実装。
4. `node/arschat-tools-backend-module.ts` に `bind(Service).to(Impl)` + `ConnectionHandler`(RpcConnectionHandler)を**追記**(module は既に存在。複数サービスは ConnectionHandler を複数 bind するだけ)。
5. `browser/<x>-tool-provider.ts`(ToolProvider、getTool は factory 委譲、backend は RPC proxy 呼び出し)+ frontend module に proxy bind と `bindToolProvider` 追記。
6. `common/tool-ids.ts` の `ARSCHAT_ALL_TOOL_IDS` に新 id を追加(registration contribution が自動で拾って agent に載せる)。

**注意点**: (a) web_search/fetch_page は外部 HTTP を叩くので Node の `fetch`/`undici` は backend でのみ。CORS 回避のためにも backend 処理は正解。(b) 出力(検索結果本文・ページ HTML)は run_command と同じく**巨大化しがち → `truncateOutput` 相当の上限を必ず入れる**(50_000 char 慣習を踏襲)。(c) タイムアウト・エラーの result 型は run_command の `{ok/exitCode, truncated, timedOut}` を参考に。(d) `theiaExtensions.backend` は既に宣言済みなので**追加のパッケージ配線は不要**、新サービスの ConnectionHandler を足すだけ。

---

## Phase 1 M5 実装メモ (e-5: web_search / fetch_page を backend 移植、読み取り扱いで無確認)

作成: 2026-07-05 / 対象: PHASE1_DESIGN.md §7・§9 M5(e-5)。現行 ArsChat の `src/main/web-search.ts`(全98行)を移植し、**Web 検索 `web_search` / ページ取得 `fetch_page` の2ツール**を追加。e-4 で足場が済んだ backend + JSON-RPC の定型6ステップにそのまま乗せ、**新サービス `WebFetchService` を1本足すだけ**で実装。**Theia 本体は一切改変せず**、全パッケージ 1.71.2 ピン留め維持。追加依存は `turndown ^7.2.4` + `@types/turndown ^5.0.6`(arschat-tools/package.json)。`fetch` は Node 18+ ビルトインで追加依存なし。

### 実装ファイル(6ステップ対応)

1. **共有プロトコル** `src/common/web-fetch-protocol.ts`: service path `webFetchServicePath='/services/arschat-web-fetch'`、DI symbol `WebFetchService`、`WebSearchRequest/Result`・`FetchPageRequest/Result` 型。**Theia ランタイム非依存**(command-runner-protocol.ts と同じ規律)。web_search/fetch_page は 1 サービス 2 メソッドに束ねた(検索と本文取得は同じ「外部 HTTP」ドメインで、RPC path を増やす意味が薄いため)。
2. **pure ロジック** `src/common/web-fetch.ts`(`parseDdgResults`・`unwrapDdgUrl`・`truncateText`・`clampFetchLength` + 各定数)+ **ToolRequest factory** `src/common/web-fetch-tool-request.ts`(`createWebSearchTool`/`createFetchPageTool`、**`confirmAlwaysAllow` は付けない**=read-only)。
3. **backend impl** `src/node/web-fetch-service-impl.ts`: `@injectable` な `WebFetchServiceImpl`。実際に `fetch` + `TurndownService` する唯一の場所。
4. **backend module** `src/node/arschat-tools-backend-module.ts` に `bind(WebFetchService).to(Impl)` + `ConnectionHandler`(2本目の RpcConnectionHandler)を追記。
5. **frontend proxy + provider** `src/browser/arschat-tools-frontend-module.ts` に `WebFetchService` proxy bind を追記、`src/browser/web-search-tool-provider.ts` / `fetch-page-tool-provider.ts`(各 `ToolProvider` かつ `WebToolBackend`、getTool は factory 委譲、backend は共有 proxy 呼び出し)を `bindToolProvider`。
6. **id 登録** `src/common/tool-ids.ts` の `ARSCHAT_ALL_TOOL_IDS` に `web_search` / `fetch_page` を追加(registration contribution が自動で拾い agent の additionalToolRequests に載る)。

### 移植元(web-search.ts)から変えた点と理由

- **エラー形式**: 原典は HTTP 失敗/タイムアウトで **throw**。ここでは backend service は Error を JSON-RPC 越しに投げるが、**frontend の factory handler が `toolError(...)`(`ERROR: …` 文字列)に整形して LLM に返す**(SPEC 指定=throw ではなく tool result 文字列)。LLM がツール失敗を読んで対処できる。
- **承認**: **付けない**(read-only 扱い)。web_search/fetch_page はローカルに一切書き込まないので `confirmAlwaysAllow` 無し=既定 ALWAYS_ALLOW で無確認実行(read_file と同扱い)。write系/run_command との差はここだけ。
- **出力上限**: 原典は `fetchPage(maxLength=15000)` 既定・上限なし。**既定 15,000 は尊重**(`FETCH_PAGE_DEFAULT_MAX_LENGTH`)しつつ、**caller 指定 maxLength を 50,000 のハード上限にクランプ**(`clampFetchLength` → `FETCH_PAGE_MAX_LENGTH`、read_file/run_command の 50,000 char 慣習と整合)。**判断理由**: 取得ページは「複数ページを一度に読む」使われ方をするので per-page 15,000 の方が集約コンテキストを抑えつつ本文を拾える。一方 LLM に大きい maxLength を渡されても context を溢れさせないよう 50,000 で必ず頭打ち。web_search 結果は件数上限(既定10)で自然に短いため truncate 不要。
- **タイムアウト**: 原典どおり `AbortSignal.timeout` を **web_search 15s / fetch_page 20s** で維持(定数化 `WEB_SEARCH_TIMEOUT_MS`/`FETCH_PAGE_TIMEOUT_MS`)。
- **DDG パース / URL 復元 / Markdown 変換 / 打ち切り**: 挙動は原典を忠実に踏襲。`result__snippet`/`result__a` の正規表現、`uddg` パラメータからの実 URL 復元、`duckduckgo.com` 自己リンク除外、Turndown(`headingStyle:atx`/`bulletListMarker:'-'`/`codeBlockStyle:'fenced'`、`script/style/nav/footer/aside/noscript/iframe/svg` を remove)。パース・復元・打ち切りは pure 関数として `common/web-fetch.ts` に切り出し、**固定 HTML フィクスチャで jest 検証**(実ネットワーク非依存)。
- **turndown の import**: 当パッケージ tsconfig は `esModuleInterop` 無し。turndown は `export = TurndownService`(CommonJS)なので `import TurndownService = require('turndown')` の TS 形式で読む(default import だとフラグが要る)。`td.remove()` の型 `Filter`(=`(keyof HTMLElementTagNameMap)[]`)に合わせ、common 側の `string[]` 定数を impl 側で `as TurndownService.Filter` narrow(common を DOM 型非依存に保つため)。

### 検証結果(正直に)

- **jest: arschat-tools 55/55 PASS(オフライン既定)**(e-4 の 33 から +22)。内訳: `web-fetch.test.ts` 12(`unwrapDdgUrl` 3=uddg 復元/param 無し fallback/unparseable fallback・`parseDdgResults` 4=固定フィクスチャで title/url/snippet 抽出+タグ除去+redirect 復元/duckduckgo.com 除外/maxResults/結果ゼロ・`truncateText` 2・`clampFetchLength` 3=既定 15000/透過/50000 クランプ)、`web-fetch-tool-request.test.ts` 10(両ツールの shape=**read-only で confirmAlwaysAllow 無しを明示検証**・引数透過・空引数拒否・backend 失敗の ERROR 整形・結果整形〔検索リスト/no-results・ページ本文/truncated 注記/Markdown 注記の有無〕)。
- **実ネットワーク smoke**: `src/node/web-fetch-service-impl.test.ts` 2本。**既定は `describe.skip` でスキップ**(`ARSCHAT_WEB_SMOKE=1` の時だけ実行)なので、CI・オフラインサンドボックス・DDG 障害でも既定 `yarn test` は壊れない(受入条件3「失敗しても CI を壊さない形」)。**手動実行 `ARSCHAT_WEB_SMOKE=1 yarn --cwd arschat-tools test` で 57/57 PASS を確認**: 実 DuckDuckGo 検索が title + http(s) URL 付き結果を返す/`https://example.com` を実取得して isHtml=true の非空 Markdown になる、を実ネットワークで裏取り済み。
- **回帰なし**: arschat-chat 14/14・arschat-agents 11/11。
- **ビルド**: `yarn build:electron` webpack **`compiled successfully`**。`tsc` エラー0。生成 backend bundle に `../arschat-tools/lib/node/*.js` **3 module**(backend-module + command-runner + web-fetch)、`common/*.js` 4 module を確認。`src-gen/backend/server.js`・`src-gen/frontend/index.js` に arschat-tools module の `load(...)` を確認。
- **ライブ検証(実キーでの LLM 往復)**: e-2〜e-4 同様 **API キー不在の検証サンドボックス制約で未実施**(e-10 に集約)。配線は「ToolProvider 登録 → registry 解決 → agent の additionalToolRequests に載る」まで静的に確立済みで、backend サービスは上記 smoke で実 DDG 検索/実ページ取得まで実ネットワークで動作確認済み。受入①(検索結果が回答に反映される配線)②(URL→本文 Markdown が反映される配線)は「6ツールが agent に載る」構造で達成。

## Phase 1 M5 実装メモ (e-6: 旧 ArsChat mcp-config.json を Theia の MCP 設定にインポート)

作成: 2026-07-05 / 対象: PHASE1_DESIGN.md §7・§9 M5(e-6)。現行(Electron 版)ArsChat が `%APPDATA%\ArsChat\arschat-data\mcp-config.json` にランタイム生成する MCP 設定を、Theia 1.71.2 の `@theia/ai-mcp` が読む preference `ai-features.mcp.mcpServers` に**変換して取り込むコマンド**を追加。これで M5 までに作った自前 arschat-tools 群とは別に、MCP は Theia 純正の `@theia/ai-mcp` に乗る(PoC-4 で実動作確認済みの経路)。**Theia 本体は一切改変せず**、全パッケージ 1.71.2 ピン留め維持。追加依存は `@theia/ai-mcp 1.71.2`(arschat-tools/package.json、preference key と型を import するため。root node_modules に hoist 済みで解決可)。

### 変換先スキーマの裏取り(必須調査)

`node_modules/@theia/ai-mcp/src/common/mcp-preferences.ts`(preference schema)+ `src/browser/mcp-frontend-application-contribution.ts`(preference→`MCPServerDescription` に落とす実コード)+ `src/common/mcp-server-manager.ts`(型)+ `src/node/mcp-server.ts`(実トランスポート)を実ソースで確認した結果:

- **(a) http / streamable-http のサポート**: **両方サポートされる**。ただし Theia 側に `type` 判別子は無く、**構造で判定**(`command` があれば local=stdio、`serverUrl` があれば remote。`isLocalMCPServerDescription`/`isRemoteMCPServerDescription`)。remote の実トランスポート(`mcp-server.ts`)は **常に StreamableHTTP を先に試し、失敗したら SSE にフォールバック**するので、旧 `http` と `streamable-http` は**どちらも 1 個の `serverUrl` remote エントリに落として情報欠落なし**(型の統合で失うものは無い)。
- **(b) `enabled:false` 相当**: 直接の対応は無く、最も近いのは **`autostart`(既定 true、"only takes effect after a restart")**。よって **`enabled:false` → `autostart:false`**(=取り込むが自動起動しない。黙って落とさない)。`enabled:true`/省略 → `autostart` を書かない(Theia 既定 true)。
- **(c) env / headers**: local は `env`(string→string map)、remote は `headers`(string→string map)+ `serverAuthToken`/`serverAuthTokenHeader`。旧設定の `env`/`headers` はそのまま透過。**空マップ `{}` は preference に書かない**(ノイズ除去)。
- **`description`**: preference スキーマに**存在しない → 破棄**(黙って落とさず「注記」に載せる)。

### 変換マッピング表(旧 → 新)

| 旧 MCPServerConfig | 新 `ai-features.mcp.mcpServers[name]` | 備考 |
| --- | --- | --- |
| `name` | オブジェクトのキー | 空ならスキップ(Theia はキー必須)。同名重複は先勝ち+警告 |
| `type: 'stdio'` + `command`/`args`/`env` | `{ command, args?, env? }`(local) | 空 args/env は省略 |
| `type: 'http'`/`'streamable-http'` + `url`/`headers` | `{ serverUrl, headers? }`(remote) | http と streamable-http は同一表現。StreamableHTTP→SSE フォールバックは Theia 側が実施 |
| `enabled: false` | `autostart: false` | 取り込むが自動起動しない |
| `enabled: true`/省略 | (`autostart` 未設定=既定 true) | |
| `description` | **(破棄)** | スキーマに無い。注記に記録 |
| type 不明/欠落 | フィールドで判定(command→local / url→remote / 両方無し→スキップ警告) | Theia 自身も構造判定なのに合わせた |

**落ちる情報**: `description`(スキーマ非対応)、旧 `type` 文字列(構造で吸収されるため保持不要)。それ以外(command/args/env/url/headers)は全て保持。

### 実装(SPEC 方針5 + リーダー指示どおり)

1. **pure 変換** `src/common/mcp-config-import.ts`: `convertLegacyMCPConfig(unknown) → { servers, warnings[], notes[], importedCount }` と `mergeIntoExisting(existing, incoming) → { merged, skippedExisting[] }`。**Theia 非依存**(inversify/FileService 不使用)なので jest で固定フィクスチャ検証可能。変換不能サーバー(name 空 / command も url も無い / servers 配列でないルート)は throw せず **warnings に理由付きで積む**。同名重複は**先勝ち**で warning(Theia 設定は name キーで一意なので後勝ちだと最初が消える)。
2. **コマンド** `src/browser/mcp-import-contribution.ts`(`CommandContribution`): コマンド `arschat-tools:mcp:import-legacy`「ArsChat: 旧 ArsChat から MCP 設定をインポート」をコマンドパレット登録。既定パス(`EnvVariablesServer.getValue('APPDATA')` → `ArsChat/arschat-data/mcp-config.json`、POSIX は `XDG_CONFIG_HOME`/`HOME/.config` fallback)を試し、**無ければ `FileDialogService.showOpenDialog` でファイル選択**。読み込みは Theia の `FileService.read`(Electron の disk provider は任意ローカルパスを読める。ArschatFileToolsService と同じ規律で node fs 直叩き回避)。変換 → `mergeIntoExisting` で**既存 preference と非破壊マージ(既存が勝ち、衝突は報告)** → `PreferenceService.set(MCP_SERVERS_PREF, merged, PreferenceScope.User)` → 結果(取り込み数/スキップ理由/注記/再起動案内)を `MessageService` で通知(warning があれば `warn`、無ければ `info`)。
3. **承認フロー無し**: インポートは明示的ユーザー操作なので `ToolConfirmationManager`(e-3/e-4 の agent ツール承認)は無関係。旧ファイルは**読み取りのみ**。
4. **配線** `src/browser/arschat-tools-frontend-module.ts` に `bind(ArschatMCPImportContribution)` + `bind(CommandContribution).toService(...)` を追記。electron-app は既に `@theia/ai-mcp` 依存済み。

### 検証結果(正直に)

- **jest: arschat-tools 70/70 PASS(e-5 の 55 から +15)**。`mcp-config-import.test.ts` 15 本、受入条件3の必須フィクスチャ(stdio / http / streamable-http / enabled:false / フィールド欠落)を全網羅 + 追加(非空 env 透過・type 不明時のフィールド fallback・同名重複先勝ち・空 name スキップ・不正ルート 5 パターンで throw せず warning・**実データ相当の 4 サーバー一括**・description 破棄注記の有無・`mergeIntoExisting` の追加/非上書き/undefined base)。回帰なし(chat 14/14・agents 11/11)。
- **実 mcp-config.json での dry-run(受入条件5)**: 実在の `%APPDATA%\ArsChat\arschat-data\mcp-config.json`(4 サーバー)を**読み取りのみ**で変換関数に食わせた結果 → **`importedCount=4` / warnings=0**。`filesystem`・`Atlassian`・`discord` は `{ command:'npx', args:[...] }`(stdio→local)、`resonitelink` は `{ serverUrl:'http://127.0.0.1:7790/mcp' }`(streamable-http→remote)。注記は description 破棄 3 件(discord のみ description 空で注記なし)。**preference への書き込みはしていない**(dry-run は変換関数のみ)。
- **ビルド**: `yarn build:electron` webpack **`compiled successfully`**、`tsc` エラー0。生成 frontend bundle(`arschat-tools_lib_browser_arschat-tools-frontend-module_js.js`)に コマンド id `arschat-tools:mcp:import-legacy` とラベル「旧 ArsChat から MCP 設定をインポート」が含まれることを確認。
- **ライブ検証(実際に UI からインポート実行)**: e-2〜e-5 同様、検証サンドボックスの GUI 制約で未実施。ただし変換ロジックは実データで dry-run 済み、書き込みは Theia 標準 `PreferenceService.set` + `MCP_SERVERS_PREF`(PoC-4 で `@theia/ai-mcp` がこの preference を読んでサーバー起動することは確認済み)なので、**受入①(変換結果が preference に書かれ ai-mcp が起動できる状態になる)は「実データで正しい形に変換 + 純正 preference key へ set」で構造的に達成**。受入②(変換不能を理由付き通知)は warnings/notes を MessageService に出す実装で達成。

### ハマった点

- 変換先に `type` 判別子が無いのは最初直感に反したが、`isLocalMCPServerDescription`/`isRemoteMCPServerDescription` が `command`/`serverUrl` の有無だけで分岐しているのを実ソースで確認して確信。http と streamable-http を 1 表現に統合できるのはこのおかげ(SSE フォールバックまで Theia 側が持つ)。
- jest テストで local 値に対し `.serverUrl` の非存在を assert する際、`TheiaLocalMCPServerValue as TheiaRemoteMCPServerValue` の直キャストは TS2352(重なり不足)。`as unknown as Record<string, unknown>` 経由に。

## Phase 1 M5 実装メモ (e-7: ARSCHAT_M5_AUTOTEST の自動検証整備 + M3/M4 回帰)

作成: 2026-07-05 / 対象: PHASE1_DESIGN.md §9 M5(e-7)。M2〜M4 で確立した**ログベース autotest の作法**(環境変数フラグ + モック LanguageModel + `[Mx]` プレフィックスで PASS/FAIL を stdout 判定)を踏襲し、M5(ツール実行 + 承認フロー + MCP インポート)の自動検証を**完全オフライン**(実 API キー・実ネットワーク不使用)で整備した。**Theia 本体は無改変**、全パッケージ 1.71.2 ピン留め維持。実装追加は autotest 1 ファイル + frontend module への bind 2 行のみ(本番挙動には一切影響しない no-op ガード)。

### 置き場所の判断

autotest は **`arschat-tools/src/browser/arschat-m5-autotest-contribution.ts`** に置いた(M2〜M4 は arschat-branding / arschat-agents だった)。理由: M5 の検証対象(6ツール・承認フロー・`convertLegacyMCPConfig`・`ArschatFileToolsService`・`ToolInvocationRegistry`)はすべて arschat-tools に集中しており、`ArschatChatAgent`(arschat-agents)も arschat-tools が既に依存宣言済みなので**追加の package 依存なしで全部 inject できる**。他パッケージに置くと tools → その他への逆依存が必要になる。`FrontendApplicationContribution` として frontend module に bind(既存の M4 autotest が agents module に bind しているのと同じ形)。

### モックが「本物のプロバイダアダプタ」を演じる仕組み(node_modules 実測に基づく設計)

M5 のキモは**承認フローを含めた往復**なので、単に system プロンプトを覗く M4 方式では足りない。Theia 実ソースを裏取りして分かった実行経路:

- `AbstractStreamParsingChatAgent.addStreamResponse()`(`chat-agents.js`)は、モデルが stream で流す `tool_calls` パートを `ToolCallChatResponseContent` として response に**追加するだけ**で、**ツール handler は呼ばない**。handler を実際に叩くのは**モデルアダプタ側**(`anthropic-language-model.js` が `tool.handler(argsObject, ToolInvocationContext.create(tc.id))` を呼ぶのを確認)。
- agent が `request.tools` に載せて渡す ToolRequest は、`FrontendChatToolRequestService.toChatToolRequest()`(browser)で**確認ゲート付きにラップ済み**。CONFIRM モードのツールは handler 内で `content.requestUserConfirmation()`+`response.fireInteractionNeeded()` を発火し `content.confirmed` を **await して実行を止める**。

→ 従ってモックは「プロバイダアダプタ」を演じればよい: (1)`tool_calls` パートを yield して content を作らせ、(2)`request.tools` から該当ツールの**ラップ済み handler を自分で呼ぶ**、(3)戻りをテキストで yield。confirm 必須ツール(write/edit/run_command)では (2) がブロックするので、autotest 側が response の `onInteractionNeeded`(+ フォールバックの content ポーリング)で該当 `ToolCallChatResponseContent` を捕まえて `confirm()`/`deny()` をプログラム発火する(e-3 の widget test が `ToolCallChatResponseContentImpl` 実体を手で駆動するのと同じ方式を、実 agent 往復に載せた形)。

### 検証シナリオ(5本)と結果(実機ログ、ARSCHAT_M5_AUTOTEST=1)

**実 Electron シェルがこの run では描画され**(M4 と同様、M3 の描画不安定は解消)、frontend `onStart` が t+15s で発火して全シナリオ実行:

- **(1) ツール登録**: `ToolInvocationRegistry` に 6 ツール(read/write/edit_file・run_command・web_search・fetch_page)が登録され、`ArschatChatAgent.additionalToolRequests` にも 6 件全部載る(`registry=6/6 onAgent=6/6`)→ **PASS**。
- **(2) read_file 実行経路**: `${configDir}/arschat/m5-autotest/` に一時ファイルを直接シード(`ArschatFileToolsService.writeFile`、ツール経由ではなく)→ モックが read_file を tool call → ファイル内容(マーカー含む)が tool result で返る、かつ **read は ALWAYS_ALLOW なので承認不要で走る**(`resolved=true contentReturned=true ranWithoutConfirmation=true`)→ **PASS**。
- **(3a) write_file 承認(許可)**: ユニーク path(既存し得ない)に write_file → **承認待ち状態に入る**(`enteredConfirmState=true`)・**confirm 前に実行されていない**(`notExecutedBeforeConfirm=true`)・`confirm()` 後に**実ファイルが disk に書かれる**(`fileWrittenAfterConfirm=true`)→ **PASS**。
- **(3b) write_file 承認(拒否)**: 別のユニーク path に write_file → 承認待ち → `deny()` → **ファイルは書かれず**(`fileNotWritten=true`)・denial result(`{denied:true,reason}`)が返る(`denialResultReturned=true`)→ **PASS**。
- **(4) run_command 実行経路**: 無害な `echo <marker>` を run_command(confirm 必須)→ 承認待ち → confirm → **backend RPC 経由で実行**され exit code 0 + stdout(marker)が返る(`enteredConfirmState=true exitCode0=true stdoutReturned=true viaBackendRPC=true`)→ **PASS**。**完了条件「run_command が承認ダイアログ経由で実行される」をログで実証**(シナリオ3+4)。
- **(5) MCP 変換 dry-run**: フィクスチャ JSON(stdio + streamable-http + enabled:false の3サーバー)を `convertLegacyMCPConfig` に食わせ `importedCount=3 warnings=0`(**preference 書き込みなし**)→ **PASS**。

**SUMMARY: 5 PASS / 0 FAIL**。autotest は自分が作った一時ファイル(read/allow/deny 3種)を `FileService.delete` で後片付けするので disk に残さない。

**web_search / fetch_page** は実ネットワークが要るため autotest では**シナリオ1の登録検証のみ**でカバー。実行系は **e-5 の jest smoke(`ARSCHAT_WEB_SMOKE=1 yarn --cwd arschat-tools test`)** が担当(実 DDG 検索 + 実ページ取得を裏取り済み)。

### M3/M4 回帰(同じサンドボックスで実機再run)

- **M4 回帰(ARSCHAT_M4_AUTOTEST=1)**: (a)ペルソナ切替 / (b)スキル一覧 / (c)/スキル展開送信 / (d)永続化+リロード すべて **PASS 維持**、スラッシュ補完ポップアップ `rendered=true itemCount=2` も **PASS**。m4-persona-switch.png も再取得(50KB、描画確認)。
- **M3 回帰(ARSCHAT_M3_AUTOTEST=1)**: streaming round-trip(`complete=true hasCodeBlock=true hasThinkBlock=true`)/ persistence(session 復元可)/ restore(`requestCount=1 restoredResponseLen=260`)すべて **PASS**(この run ではシェルが描画され、M3 メモの SKIP から実機 PASS に到達)。`incrementalGrowthObserved=false` はモックの高速ストリームによる既知の非ブロッキング事象で判定条件外。
- いずれも M5 の変更(autotest 追加 + bind 2 行)が M3/M4 を壊していないことを確認。

### 検証結果(jest + ビルド)

- **jest**: **arschat-tools 70/70 PASS**(e-7 は autotest = 実機ログ検証なので jest 追加はなし。既存 70 が回帰なし。web smoke 2 は既定 skip)・**chat 14/14**・**agents 11/11**(いずれも回帰なし)。
- **ビルド**: `yarn build:electron` webpack **`compiled successfully`**、`tsc` エラー0。生成 frontend bundle(`arschat-tools_lib_browser_arschat-tools-frontend-module_js.js`)に M5 autotest モジュールが取り込まれることを確認。**通常起動(ARSCHAT_M5_AUTOTEST 未設定)では `[M5]` ログは一切出ず**(no-op ガード確認)。
- **ライブ API 往復(実キーでの実プロバイダ経由のツールコール)**: e-2〜e-6 と同様、実キー不在のため autotest には含めず **e-10(実 API ライブ検証)に集約**。ただし承認ゲートは Theia 実ソース経路(`FrontendChatToolRequestService` → await confirmed → handler)にオフラインで実際に乗せ、read/write(allow/deny)/run_command の**実行 or 停止の両分岐を実機ログで実証済み**なので、実プロバイダに差し替えても同一経路が動く。

### ハマった点

1. **モックが handler を呼ぶ必要がある**: 最初「モックが tool_calls を流せば agent がツールを実行してくれる」と考えたが、`chat-agents.js` 実測で agent は content を追加するだけと判明。プロバイダアダプタ(anthropic-language-model.js)が handler を呼ぶ実装なので、モックが `request.tools` の**ラップ済み** handler を明示的に呼ぶ設計にした。ラップ済みだからこそ承認ゲートが効く(生の ToolRequest を叩くと確認を素通りしてしまう)。
2. **承認 content の捕捉タイミング**: `onInteractionNeeded` は 1 回発火だが、購読がわずかに遅れた場合に取りこぼさないよう 100ms ポーリングのフォールバックを併設(response.content を走査し未 finished の該当 tool call を confirm/deny)。`executedBeforeConfirm` フラグで「confirm 前に handler が結果を出していないか(=承認バイパスのバグ)」も監視したが、CONFIRM ゲートが await するため正しく false のまま。
3. **一時ファイルの absence 保証**: write allow/deny は「書かれた/書かれていない」を判定するので、前 run の残骸で偽陽性が出ないよう **`Date.now()` 付きユニーク path**(既存し得ない)を使い、`FileService.exists` で事前非存在も確認。`ArschatFileToolsService` に delete が無いので後片付けは `FileService.delete` を直接 inject(arschat-tools は既に `@theia/filesystem` 依存)。

## Phase 1 M5 実装メモ (e-10: 実 LLM ライブ検証 — L1〜L5 + 「常に許可」の実測)

作成: 2026-07-05 / 対象: PHASE1_DESIGN.md §9 M5(e-10)。e-7 のオフライン autotest 基盤(モックモデル駆動)を**ライブ化**し、**LAN の LM Studio(OpenAI 互換)に対しモック無しの実チャット往復**で M5 のツール実行・承認フローを裏取りした。追加は autotest 1 ファイル(`arschat-tools/src/browser/arschat-m5-live-contribution.ts`)+ frontend module bind 2 行 + `arschat-tools/package.json` に `arschat-providers` 依存明示のみ。**本番挙動には一切影響しない no-op ガード**(`ARSCHAT_M5_LIVE=1` の時だけ動く)。Theia 本体無改変。

### 接続先と起動

- エンドポイント: `http://192.168.1.149:1234/v1`(既定、`ARSCHAT_M5_LIVE_URL` で上書き可)/ モデル: `qwen/qwen3.6-35b-a3b`(既定、`ARSCHAT_M5_LIVE_MODEL` で上書き可)。ハードコードは既定値のみ。
- 事前確認: `curl /v1/models` で到達確認、`curl /v1/chat/completions` に read_file ツール定義を渡して `finish_reason=tool_calls` + 正しい引数を実証(reasoning モデルなので応答に数十秒。タイムアウトは 1 シナリオ 5 分、シナリオごと最大 3 リトライ)。
- 起動: `THEIA_CONFIG_DIR=<一時dir> ARSCHAT_M5_LIVE=1 ARSCHAT_M5_LIVE_URL=… ARSCHAT_M5_LIVE_MODEL=… node @theia/cli start`。frontend `onStart` が t+15s で発火して L1〜L5 を実行、`[M5-LIVE]` プレフィックスで stdout に PASS/FAIL/実測値、最後に SUMMARY。

### プロバイダ切替(e-7 との違いと ハマり)

- e-7 はモック LanguageModel を登録して agent をそこに向けたが、e-10 は**実 `lmstudio` エンドポイントを LAN に向け替える**: `customOpenAiModels` の `lmstudio` エントリの url/model を書き換えると `@theia/ai-openai` の `onPreferenceChanged` が `lmstudio` LanguageModel を**再登録**する(`total models=13`, `registered=true` を確認)。
- **ハマり(初回 run で SETUP FAILED)**: 最初 `ProviderSwitchService.setActive('lmstudio')` で切替えようとしたら `Unable to write to Workspace Settings` で失敗。原因は `setActive`→`preferenceService.set(PREF_ACTIVE_PROVIDER, …, undefined)` の**スコープ `undefined` が Workspace 解決**になり、**フォルダ未オープンの headless 起動では Workspace 設定に書けない**ため。→ 回避: agent の model requirement を **`AISettingsService.updateAgentSettings`+agent instance field** で直接駆動(ProviderSwitchService 自身が §10 で belt-and-suspenders として документ化している経路、e-7 の `pointAgentAtMock` と同じ)。preference 書込は全部 **`PreferenceScope.User` 明示**にした(endpoint 書換・復元とも)。

### シナリオ結果(実機ログ、SUMMARY: 4 PASS / 0 FAIL + L4 計測)

- **L1 read**: 一時ファイルに合言葉 `PURPLE-OTTER-<ts>` を仕込み「このファイルを read_file で読んで合言葉を教えて」→ **応答に合言葉が含まれる** → **PASS**(1発)。実 LLM が実際に read_file を呼び、read は ALWAYS_ALLOW なので無確認で走ることを実証。
- **L2 write 承認→実行**: 「hello-live と書いて」→ **承認待ちに入る(この時点でファイル未作成を確認)**→ `confirm()` → **実ファイルが書かれ内容 `hello-live` を確認** → **PASS**。
- **L3 write 拒否**: 別パスに write を頼み `deny()` → **ファイル未作成 + 応答が拒否を言及** → **PASS(2発目)**。**1発目は LLM がツールを呼ばずに失敗**: 「指定パスはあなたのローカル Windows マシンのパスで、私のサーバー環境からは直接アクセスできない」と判断し write_file を呼ばず自前で断った(reasoning モデルらしい自己判断)。リトライで write_file を呼び、deny が効いて denial(`M5-LIVE programmatic denial`)が応答に反映された。
- **L5 run_command**: 「echo live-test を実行して」→ 承認待ち → `confirm()` → **exit0 + stdout(`live-test`)が応答に反映** → **PASS(2発目)**。1発目は非決定的タイミングで、モデルが実往復の承認登録より先に「実行しました」応答を確定してしまい `confirmationRequested=false` になった(stdout マーカーは出ていた)。リトライで承認ゲート込みでクリーンに通った。
- **L4「常に許可」の実測(最重要・レビュー未確証点)**: L2 の後、widget の `onToolAllow('forever')` と**同一経路**で `ToolConfirmationManager.setConfirmationMode('write_file', ALWAYS_ALLOW)` を実行 → もう一度 write を依頼 → **`confirmationRequestedAgain=true`(= RE-CONFIRMED)**。**「常に許可/forever」ボタンは write 系では効かず、毎回再確認される**。

### L4 の意味(仕様バグの実証 — node_modules 実測と一致)

`@theia/ai-chat` の `ToolConfirmationManager` を読むと理由が確定する:

1. widget の `onToolAllow('forever')`(`arschat-chat-widget.tsx:594`)は `setConfirmationMode(toolId, ALWAYS_ALLOW)` を **ToolRequest 引数なし**で呼ぶ。
2. `setConfirmationMode`(引数なし)は `effectiveDefault = defaultPref[toolId] ?? starMode`(starMode の既定は ALWAYS_ALLOW)を計算 → `mode(ALWAYS_ALLOW) === effectiveDefault(ALWAYS_ALLOW)` が **true** → 「既定に戻す」とみなして `toolConfirmation['write_file']` **キーを削除**(=保存しない)。実機ログでも `stored toolConfirmation['write_file']=<absent — key was deleted>` を確認。
3. 一方、実行経路の `FrontendChatToolRequestService.toChatToolRequest` は `getConfirmationMode(id, sessionId, **toolRequest**)` を **ToolRequest 付き**で呼ぶ。キーは削除済みなので既定にフォールバックし、`toolRequest.confirmAlwaysAllow ? CONFIRM : ALWAYS_ALLOW` → **CONFIRM** を返す → 再確認。

**結論**: `confirmAlwaysAllow` を付けた write_file/edit_file に対し、現状の widget 経由「常に許可」は**構造的に無効**(セキュリティ的には安全側=常に確認だが、UX としては「常に許可」が効かない仕様バグ)。**修正案**(M6 以降): widget が (a) `setConfirmationMode(id, mode, toolRequest)` に ToolRequest を渡して `effectiveDefault` を CONFIRM 側に寄せる、または (b) `confirmAlwaysAllow` 系専用の格納経路を用意する。**この判断のために e-10 は L4 を PASS/FAIL 対象外の「実測」として記録**(RE-CONFIRMED / RAN-WITHOUT-CONFIRMATION のどちらでも FAIL にしない)。なお `setSessionConfirmationMode`(「このセッション中」)は別 Map に直接格納するので此の削除ロジックの影響を受けず効くと推定(e-10 では未計測)。

### 分離(普段の設定を汚さない)

- **`THEIA_CONFIG_DIR` を一時ディレクトリに向けて起動**(実ログ `Configuration directory URI: '…/scratchpad/theia-config-m5live2'`)。preference 書込・scratch ファイル(read/write の 3 種)はすべてそこに閉じる。scratch は `FileService.delete` で後片付け。
- 追加の belt-and-suspenders として、変更した 2 preference(`customOpenAiModels` / `toolConfirmation`)を run 前に snapshot し**実行後に復元**(実ログ `restored preferences … to pre-run values`)。
- **旧アプリ DATA(`%APPDATA%\ArsChat\arschat-data`: mcp-config.json / sessions / settings.json 等)は無改変を確認**(全 mtime が run 前)。※`%APPDATA%\ArsChat` 直下の `GPUCache`/`Session Storage`/`Preferences` 等は Electron/Chromium が **アプリ名 "ArsChat" の userData** として起動ごとに書く**ランタイムキャッシュ**で、旧アプリのデータ本体とは別物(e-7 等の過去 run でも生成される)。

### 検証(jest + ビルド)

- **jest**: arschat-tools **70/70 PASS**(2 web smoke は既定 skip、e-10 は実機ログ検証なので jest 追加なし・回帰なし)。
- **ビルド**: `../node_modules/.bin/tsc -p arschat-tools` エラー0、`yarn build:electron` webpack `compiled successfully`。**通常起動(`ARSCHAT_M5_LIVE` 未設定)では `[M5-LIVE]` ログは一切出ず**(no-op ガード確認)。

### ハマった点(e-10 固有)

1. **headless の Workspace スコープ書込不可**(上記): `ProviderSwitchService.setActive` を使わず AISettingsService 直接駆動 + `PreferenceScope.User` 明示で回避。
2. **reasoning モデルの非決定性**: L3(モデルが自己判断でツールを呼ばない)/L5(承認登録前に応答確定)が 1 発目で外れることがあり、**3 リトライ**で吸収。**ツール呼び出し自体は安定**(合言葉読取・書込・拒否・コマンド実行はすべて実 LLM 経由で機能)。プロンプトはツール名を明示(「read_file ツールで」「write_file ツールで」)して呼び出しを誘導した。
3. **`content.id` の型**: `ToolCallChatResponseContent.id` が `string | undefined` 型だったので、重複発火防止の dedup キーは `content.id ?? content.name ?? '<unknown>'` にフォールバック。

## Phase 1 M5 実装メモ (e-18: 承認カードのボタン出し分け — 「常に許可」を confirmAlwaysAllow ツールで非表示)

作成: 2026-07-05 / 対象: PHASE1_DESIGN.md §9 M5(e-18)。e-10 で実測した「`confirmAlwaysAllow` 付きツールの『常に許可』が効かない仕様バグ」を UX 面で解消する。**承認フロー自体は再設計せず**、`arschat-chat-widget.tsx` の承認カードのボタン出し分けのみを直した。Theia 本体無改変。

### 変更したファイル

- `arschat-chat/src/browser/arschat-chat-widget.tsx`:
  - `ToolInvocationRegistry`(`@theia/ai-core/lib/common/tool-invocation-registry`)を DI 注入。承認カードの `content.name`(= ツール id)から `getFunction(name)` で**生の `ToolRequest`** を引き、`confirmAlwaysAllow` フラグを確実な経路で判定する `toolRequestFor()` / `isConfirmAlwaysAllowTool()` を追加。
  - `renderToolCard()`: `isConfirmAlwaysAllowTool(view)` が true のとき「常に許可」ボタンを**非表示**(無効化ではなく描画しない — 出せない選択肢を見せない)。「許可」「セッション中」「拒否」は従来どおり表示。
  - `onToolAllow()` の forever 分岐: `setConfirmationMode(id, ALWAYS_ALLOW, this.toolRequestFor(view))` と**第3引数に ToolRequest を渡す**よう修正(渡さないと `effectiveDefault` が誤り、e-10 のバグ経路になる)。ボタンが出るのは非 confirmAlwaysAllow ツールのみなので、この経路は「ALWAYS_ALLOW が実際に永続化されるツール」に対してのみ走る。
- `arschat-chat/src/browser/arschat-chat-widget.test.ts`: `ToolInvocationRegistry` スタブ + `setConfirmationMode`/`setSessionConfirmationMode` の呼び出し記録を追加。ボタン出し分けテスト 4 本(下記)。

### id === name の裏取り(確実な経路)

`ToolInvocationRegistry.getFunction(toolId)`(`tool-invocation-registry.d.ts`)が生の `ToolRequest` を返す。承認カードの `ToolCallChatResponseContent.name` は**ツール id そのもの**で、これは実行経路 `FrontendChatToolRequestService.findToolCallContent` が `content.name === toolRequest.id` でマッチングしていること、および arschat-tools が全ツールを `id === name` で登録している(`file-tool-requests.ts` 等)ことの二重で確認済み。したがって `getFunction(content.name)` は同一 ToolRequest を返す。

### 「このセッション中」(setSessionConfirmationMode)の実測結果 — **有効。残す。**

**結論: 「このセッション中」は confirmAlwaysAllow ツールでも効く**(「常に許可」とは別扱い)。根拠は `ToolConfirmationManager`(`node_modules/@theia/ai-chat/lib/browser/chat-tool-preference-bindings.js`)のソース経路:

- `getConfirmationMode(toolId, chatId, toolRequest)` は**最初に** `sessionOverrides`(chatId→toolId→mode の in-memory Map)を見て、エントリがあれば**即 return する**(l.44-47)。`confirmAlwaysAllow` のフォールバック(l.54 の `'*'` 抑制、l.60 の既定 CONFIRM)は**その後**にしかないので、セッション override が入っていれば到達しない。
- `setSessionConfirmationMode(toolId, mode, chatId)`(l.96-103)は `sessionOverrides` に**そのまま格納**する。「常に許可」(`setConfirmationMode`)にあった「ALWAYS_ALLOW=既定とみなしてキー削除」ロジック(l.82-87)は**通らない**。
- 上流の `chat-tool-preference-bindings.spec.js` l.81-84「should return session override when set」が、まさにセッション override が格納値をそのまま返すことをテストしており、この順序を裏付ける。

実体での empirical 確認も試みたが、`ToolConfirmationManager` は browser 層で `@theia/core` の DOM ツリーを推移 import するため、jest 単体(moduleNameMapper でスタブ済み)/素の node のどちらでも実 manager をロードできなかった(jsdom で document/Element/localStorage 等を差しても `@lumino/domutils` の初期化で落ちる)。**そのため e-18 では実 manager のライブ実行ではなく、上記のソース経路 + 上流 spec による確定的判定を採用した**(「常に許可」が壊れる理由も同じ削除ロジックのソース読解で e-10 が特定済み、実測 L4 と一致)。以上より「常に許可」= 非表示、「このセッション中」= 残す、で確定。

### confirmAlwaysAllow の有無(対象ツール)

- **confirmAlwaysAllow 有り(「常に許可」非表示)**: `write_file` / `edit_file`(`file-tool-requests.ts`)、`run_command`(`command-tool-request.ts`)。
- **無し(3 ボタン維持)**: `read_file` / `web_search` / `fetch_page`。現状これらは確認自体が出ないが、ユーザーが preference で `*`=CONFIRM 等にした場合に承認カードが出る。その場合「常に許可」は実際に永続化されるので**残す**のが正しい。

### 検証結果(正直に)

- **jest**: arschat-chat **17/17 PASS**(e-3 の承認カードテスト 1 本を read-only/confirmAlwaysAllow の 2 ケース + セッション/forever の呼び出し検証に拡張して +3 本。既存 14 本は回帰なし)。arschat-tools **70/70 PASS**(2 web smoke は既定 skip)、arschat-agents **11/11 PASS**。回帰なし。
- **追加テスト 4 本の要点**: (1) read-only ツールは 許可/セッション中/常に許可/拒否 の 4 択、(2) confirmAlwaysAllow ツールは「常に許可」のみ消え 3 択、(3)「セッション中」押下で `setSessionConfirmationMode(id, always_allow)` が呼ばれる、(4)「常に許可」押下で `setConfirmationMode` に**生の ToolRequest が第3引数で渡る**。
- **ビルド**: `tsc --noEmit`(arschat-chat)エラー0、`yarn build:electron` webpack `compiled successfully`。
- **ライブ検証**: e-18 は UI ロジックの出し分けのみで、実 LLM 往復は e-10 で実施済み(新規のライブ検証なし)。

## Phase 1 M6 実装メモ (e-21: IDE 再希釈 — plugin-ext 導入で復活した debug/scm 等の Filter 拡大)

作成: 2026-07-08 / 対象: PHASE1_DESIGN.md §9 M6・BUILD_NOTES「PoC-3 追加した依存関係」節。M5 で `@theia/plugin-ext` / `plugin-ext-vscode` / `vsx-registry` を導入した際、推移的に約20パッケージ(scm/debug/task/test/notebook/search-in-workspace 等)が入り、PoC-2 で作った IDE 希釈(メニューフィルタ)をすり抜けて IDE 由来のメニュー(Run)・ActivityBar アイコン(SCM/デバッグ/テスト/検索/エクスプローラ/拡張)が UI に復活していた。これを再希釈して「チャットアプリの顔」(PoC-2 水準)に戻す。**Theia 本体(node_modules 配下)は一切改変していない。全パッケージ 1.71.2 ピン留め維持。**

### 変更したファイル

- `arschat-branding/src/browser/arschat-ide-dilution.ts`: PoC-2 の `ArschatMenuFilterContribution`(Selection/Go/Terminal を `MenuContribution` フィルタで除去)を**2 系統のフィルタに拡張**。既存の 1 クラス・1 `addFilters` 構造を維持したまま、対象クラス配列を増やし、`FrontendApplicationContribution` 用の 2 本目の `addFilters` を追加した。
- `arschat-branding/package.json`: フィルタ対象クラスの型・実体を import するため `dependencies` に `@theia/debug` / `@theia/scm` / `@theia/test` / `@theia/search-in-workspace` / `@theia/navigator` / `@theia/vsx-registry` / `@theia/outline-view`(すべて 1.71.2)を追加。いずれも M5 で既にワークスペースに推移解決済みのため `yarn install --frozen-lockfile` が成功(= `yarn.lock` 差分ゼロ。PoC-2 の editor/monaco/terminal 追加と同じ挙動)。

### 2 系統のフィルタと、それぞれ「確実に効く方」を選んだ根拠(node_modules 実測)

**(1) メニューバー = `MenuContribution` フィルタ**(PoC-2 と同じ手法の拡張)
- 現行依存で登録される**トップレベルメニュー**を `grep 'MAIN_MENU_BAR'` で全数確認: File/Edit/View/Help(`@theia/core` `CommonMenus` = `CommonFrontendContribution`、**残す**)/ Selection(`monaco` `MonacoEditorMenuContribution`)/ Go(`editor` `EditorMenuContribution`)/ **Run**(`debug` `DebugMenus.DEBUG = [...MAIN_MENU_BAR,'6_debug']` = `DebugFrontendApplicationContribution.registerMenus`)/ Terminal(`terminal` `TerminalFrontendContribution`)。
- **plugin-ext 拡張で復活した新規トップレベルメニューは "Run"(debug)ただ 1 つ**。よって Selection/Go/Terminal に `DebugFrontendApplicationContribution` を加えるだけでメニューバーは File/Edit/View/Help の 4 つに戻る。
- `MenuModelRegistry` にサブメニュー一括削除 API は無い(PoC-2 で確認済み)ため、`registerMenus()` が走る前に**クラスを `MenuContribution` 多重バインドから外す**のが唯一の全除去手段。ここは preference では消せない(トップレベルメニュー個別の非表示 preference は 1.71.2 に無い)ので **FilterContribution 一択**。
- 併せて、下記(2)で ActivityBar から消す IDE ビュー系クラス(scm/test/search/navigator/vsx/outline)も `MenuContribution` フィルタに含めた。これらの `registerMenus()` は View メニュー配下に "Toggle Explorer/Source Control/Search…" のリーフ項目を足すだけなので、**ビューを隠すなら対応する Toggle 項目も消す**方が一貫する(隠したビューを指す dangling な Toggle を残さない)。

**(2) 左 ActivityBar アイコン = `FrontendApplicationContribution` フィルタ**(M6 の新規手法)
- ActivityBar アイコンの正体を特定: 各 IDE サイドビューは `AbstractViewContribution` 派生クラスで、`bindViewContribution(bind, X)` + `bind(FrontendApplicationContribution).toService(X)` の二段バインド(例: `scm-frontend-module.js:122-123`)。その `initializeLayout()` が `openView()` → `shell.addWidget(widget, { area:'left' })` を呼ぶ(`@theia/core/.../view-contribution.js:64-76`)ことで**左パネルのタブ(= ActivityBar アイコン)が生える**。
- したがって**当該クラスを `FrontendApplicationContribution` 型からフィルタで外す**と `initializeLayout()`(と `onStart()`)が走らず、ビューが自分を ActivityBar に足さない。`grep 'initializeLayout'` で該当パッケージを全数確認し、`openView` を呼ぶ 6 クラス + outline を対象にした:
  - `ScmContribution`(`@theia/scm/lib/browser/scm-contribution`) — Source Control
  - `DebugFrontendApplicationContribution`(`@theia/debug/lib/browser/debug-frontend-application-contribution`) — Run and Debug(メニュー "Run" と同一クラス。両フィルタに登場)
  - `TestViewContribution`(`@theia/test/lib/browser/view/test-view-contribution`) — Test
  - `SearchInWorkspaceFrontendContribution`(`@theia/search-in-workspace/lib/browser/search-in-workspace-frontend-contribution`) — Search
  - `FileNavigatorContribution`(`@theia/navigator/lib/browser/navigator-contribution`) — Explorer
  - `VSXExtensionsContribution`(`@theia/vsx-registry/lib/browser/vsx-extensions-contribution`) — Extensions
  - `OutlineViewContribution`(`@theia/outline-view/lib/browser/outline-view-contribution`) — Outline
- **preference との併用について**: ActivityBar は preference では**個別ビュー単位で消せない**。`workbench.activityBar.visible:false` は ActivityBar 全体(= ArsChat 自前の履歴パネル/ペルソナ管理ビューも)を消してしまうので不採用。よってこの系統は FilterContribution が「確実に効く方」。ステータスバー(既存の `workbench.statusBar.visible:false`)のように preference が個別に効く要素は従来どおり preference のまま(electron-app/package.json)、というのが本タスクの「要素ごとに確実な方を選ぶ」判断の内訳。

### notebook / ai-chat-ui / task の扱い(意図的に触っていない)

- **notebook**: 依頼で「非表示」に挙がっていたが、`@theia/notebook` は**エディタ内でノートブックを描画する**contribution で、`initializeLayout`→`openView` を持たない(= 左 ActivityBar アイコンを生やさない)。`grep 'initializeLayout'` の対象外。したがって**消すべき ActivityBar 要素が存在せず、フィルタ不要**。
- **task**: トップレベルメニューも ActivityBar ビューも登録しない(コマンド/実行基盤のみ)。UI 上の希釈対象なし。
- **`@theia/ai-chat-ui`(標準 AI Chat ビュー)**: `AIChatContribution` も `initializeLayout`→`openView` を持つが、これは ArsChat が土台にする AI スタック側の純正ビューであり、依頼の「IDE 要素」列挙にも無い。ArsChat の主 UI は自前 `ArschatChatWidget` なので二重チャット回避の観点では隠す余地もあるが、**AI スタックの一部**であり実起動確認(e-26)前に消すのはリスクと判断し、M6 スコープ外とした(残課題として記録)。

### コマンドパレットについて

依頼どおり「見た目が主眼」。コマンド/キーバインディングは `CommandContribution`/`KeybindingContribution` フィルタを掛けていないので、IDE コマンド自体はコマンドパレットに残る(容易に消せるが、キーバインディング等への副作用を避け、視覚的希釈=メニューバー+ActivityBar に限定した)。必要なら同じ配列を `CommandContribution` にも `addFilters` すれば消せる。

### 検証結果

- **ビルド**: `npm run prepare`(lerna、全5パッケージ tsc)エラー 0(arschat-branding の新規 import 7 本含む)。`theia build --mode development` **errorsCount:0**、`theia build --mode production` **errorsCount:0**(webpack `stats.json` で確認)。※ この検証環境は worktree に node_modules が無いため `yarn install --frozen-lockfile --ignore-scripts` 後、ネイティブアドオン(ffmpeg/keytar/native-keymap/node-pty/drivelist)と electron dist をメインリポの node_modules から複製してビルドを通した(ソースは無改変、`theia rebuild:electron` の代替)。
- **jest 回帰なし**: arschat-chat **17/17**、arschat-agents **11/11**、arschat-tools **70 passed + 2 skipped**(web smoke は既定 skip)。M5 までの数値と一致、回帰ゼロ。
- **実起動でのメニューバー/ActivityBar 目視確認は本タスク範囲外**(別タスク e-26)。本タスクの検証範囲はビルド通過 + jest 回帰なしまで。フィルタ発火時の `[arschat-dilution] ... filtered out: <class>` ログで実機確認できるよう console.log を残した(PoC-2 の `[PoC-2] ... filtered out` 相当)。

### フィルタした要素の一覧(まとめ)

| 要素 | 種別 | 除去したクラス | 手法 |
|---|---|---|---|
| Run メニュー | メニューバー | `DebugFrontendApplicationContribution` | `MenuContribution` filter |
| Selection / Go / Terminal | メニューバー | `MonacoEditorMenuContribution` / `EditorMenuContribution` / `TerminalFrontendContribution` | `MenuContribution` filter(PoC-2 から継続) |
| View メニューの Toggle 項目 | メニュー | 下記 ActivityBar 7 クラス | `MenuContribution` filter |
| Source Control | ActivityBar | `ScmContribution` | `FrontendApplicationContribution` filter |
| Run and Debug | ActivityBar | `DebugFrontendApplicationContribution` | `FrontendApplicationContribution` filter |
| Test | ActivityBar | `TestViewContribution` | `FrontendApplicationContribution` filter |
| Search | ActivityBar | `SearchInWorkspaceFrontendContribution` | `FrontendApplicationContribution` filter |
| Explorer | ActivityBar | `FileNavigatorContribution` | `FrontendApplicationContribution` filter |
| Extensions | ActivityBar | `VSXExtensionsContribution` | `FrontendApplicationContribution` filter |
| Outline | ActivityBar | `OutlineViewContribution` | `FrontendApplicationContribution` filter |
| ステータスバー | ステータスバー | (クラス除去せず) | preference `workbench.statusBar.visible:false`(既存) |

## Phase 1 M6 計測メモ (e-22: highlight.js バンドルサイズ計測)

作成: 2026-07-08 / 対象: BUILD_NOTES.md「判断: markdown ライブラリ」節(M3 で `marked` + `highlight.js` + DOMPurify を採用)。プロダクションバンドル内で highlight.js(192 言語フルバンドル)が占めるサイズを計測して数値で記録する。**削減・サブセット化はしない**(ユーザー判断で 192 言語維持を確定済み)。手段は webpack stats + 実 terser 最小化。

### 計測対象と方法

- **import 実態**: `arschat-chat/src/browser/arschat-markdown.ts` が `require('highlight.js')` = `highlight.js/lib/index.js`(**フルビルド、192 言語を全登録**)を遅延解決。サブセット(`highlight.js/lib/core` + 個別言語)ではない。**version 11.11.1**。
- **計測手段**: `theia build --mode production --json stats-prod.json` を生成し、モジュール名に `highlight.js` を含む webpack モジュールを全抽出。加えて、バンドルされる各モジュールの実ファイルを **terser(compress + mangle、webpack production と同じ最小化)** で個別最小化して合算し、gzip 圧縮後サイズも算出。

### 計測結果(数値)

| 指標 | 値 |
|---|---|
| highlight.js version | 11.11.1(`require('highlight.js')` = フルビルド) |
| バンドルされる hljs モジュール数 | **195**(index + core + **193 言語モジュール**) |
| 生ソース(webpack `module.size` 合算、= 非最小化) | **1,572,519 B ≈ 1.50 MiB** |
| terser 最小化後(compress+mangle、モジュール個別最小化の合算) | **970,249 B ≈ 948 KiB ≈ 0.93 MiB** |
| 最小化 + gzip 後(転送/ディスク実効) | **約 300 KiB** |

- webpack の `--mode development` / `--mode production` いずれの stats でも hljs の `module.size` 合算は同一(1.50 MiB。`module.size` は最小化前のソースバイト数のため)。**最小化後の実バンドル寄与が 0.93 MiB、gzip 後 約 300 KiB** というのが「プロダクションバンドル内で hljs が占めるサイズ」の実値。
- 参考: `highlight.js/lib` 配下の言語ファイル総数は 384(全言語 + 別名/派生)だが、`lib/index.js` が実際に登録・バンドルするのは 193 言語モジュール。フルビルドでもツリーシェイクで多少絞られている(それでも全 192 言語相当が入る)。
- **削減はしない**。本計測は「192 言語維持のコスト = プロダクションで約 0.93 MiB(minified)/ 約 300 KiB(gzip)」を可視化する目的のみ。将来サブセット化を検討する場合は `highlight.js/lib/core` + `registerLanguage()` で必要言語だけ登録する構成に切り替えれば、この 0.93 MiB の大半を削減できる(が、現状はユーザー判断で据え置き)。

## Phase 1 M6 実装メモ (e-23/e-24/e-25: 旧 ArsChat「見た目要素」3点の移植)

作成: 2026-07-08 / 対象: 旧 ArsChat (`C:\Users\takep\source\ArsChat` の `MessageBubble.tsx`) にあって未移植だった見た目要素 3 点 — KaTeX 数式・ホバー時アクション・統計バー — を arschat-chat に移植した。

### e-23: KaTeX 数式レンダリング

- **変更**: `arschat-chat/package.json` に `katex@^0.16.38` / `marked-katex-extension@^5.1.7`(旧アプリと同 major)を追加。`arschat-markdown.ts` の遅延 require 経路(esModuleInterop 無し対策)に `marked-katex-extension` を追加し、旧実装と同じ `{ throwOnError: false, output: 'html' }` で `marked.use()`。
- **DOMPurify の通し方**: `output: 'html'` の KaTeX 出力は `<span>` + `class`/`style`/`aria-hidden` のみで構成され、DOMPurify の既定 allow-list をそのまま通る(MathML を含む `output: 'mathml'`/`htmlAndMathml` にしなかったのはこのため)。将来の既定変更に耐えるよう `ADD_ATTR: ['style', 'aria-hidden']` を明示追加(ADD_ATTR は additive なので挙動は不変)。**ADD_TAGS は不要だった**。
- **CSS/フォント**: `katex/dist/katex.min.css` を `arschat-chat-frontend-module.ts` で import(markdown モジュールでなくここなのは、jsdom の jest が `arschat-markdown.ts` を直接 import するため)。webpack 側は gen-webpack.config.js 既存の css ルール + `asset/resource`(woff2/woff/ttf)ルールで KaTeX フォント 60 ファイルが `lib/frontend/` にハッシュ名で出力されることを確認。
- **円記号正規化**: 旧実装の `normalizeYenToBackslash`(JIS キーボード由来で LLM が `\` の代わりに ¥ U+00A5 / ￥ U+FFE5 を出す問題)も `$...$`/`$$...$$` 内限定で移植。
- **表示**: `.katex-display` に `overflow-x: auto` を付け、横長数式はバブル内スクロール。

### e-24: メッセージホバー時アクション (コピー/再生成/削除)

- **スコープ**: 旧 6 ボタン中、現アーキで確実に意味がある **コピー・再生成・削除** のみ移植(編集/続き/分岐はセッションモデル対応が必要なため見送り)。
- **ターン概念**: Theia ai-chat では 1 `ChatRequestModel` = user+assistant の 1 ターン。UiMessage に `requestId` を持たせ、user/assistant 両方が同一ターン id を共有する形にした(削除はターン単位)。
- **モデルからの削除**: `MutableChatModel` は append-only で removeRequest が無い。公開 API の `getBranch(requestId)` が返す branch linked-list(`items`/`previous`/`item.next`/`hierarchy.branch`)を再リンクする `removeRequestFromModel()` を `arschat-request-tree.ts` に新設。root/中間/末尾/複数バージョン branch の全ケースを処理し、単体テストで検証。serialization (`toSerializable`) は同じリンクを辿るので、再リンク後に保存すれば削除済みターン抜きで round-trip する。
- **永続化**: request-tree の手動編集はモデルの `onDidChange` を発火しない(= auto-save が走らない)ため、削除後に `ChatSessionStore.storeSessions(model)` を明示呼び出し。
- **再生成**: 最新 assistant のみ。対象ターンをモデル+UI から破棄 → 直前 user テキストを `send()` に再投入(スキル展開も再適用)。後続 send の auto-save が破棄を永続化するので明示保存は不要。
- **スタイル**: `.arschat-chat-message-assistant:hover` で opacity 0→1 のフェードイン。SVG アイコンは旧実装から流用し、色は Theia テーマ変数(`--theia-descriptionForeground` 等)に置換。

### e-25: トークン数/速度/所要時間の統計バー

- **usage の取得可否(調査結果)**: Theia 1.71.2 の `ChatResponseModel.tokenUsage`(`ResponseTokenUsage { inputTokens, outputTokens }`)に、`@theia/ai-anthropic`・`@theia/ai-openai` 両言語モデルが yield する usage part を `AbstractChatAgent` が `setTokenUsage()` で格納する。**`toSerializable()` にも含まれておりセッション永続化で round-trip する**(スキーマ変更不要 = 後方互換問題なし)。LM Studio / Unsloth 等 OpenAI 互換もサーバが usage を返せば同経路で取れる。
- **フォールバック**: usage が無い(または 0/0)場合は文字数 ÷ 4 のトークン概算(`arschat-message-stats.ts`、UI 上は区別表示しない — 出典は内部フィールド `tokenSource` のみ)。
- **所要時間**: Theia は生成時間を持たない・永続化もしないため、widget が `send()` 前後で実測し、`ArschatStatsStore`(`StorageService` = localStorage 系、key `arschat.messageStats.v1`、requestId→ms、上限 1000 件)に保存。履歴から開いたとき `getDurationMs(req.id)` で復元。**旧セッション(エントリ無し)は時間なしでトークン数のみ表示され、壊れない**(全フィールド optional 設計)。
- **速度**: トークン/秒 = **output トークン ÷ 実測秒**(input を混ぜない。旧実装と同じ意味論)。削除したターンの duration は `forget()` で掃除。

### 検証

- jest: chat 44/44(markdown 9・think 4・request-tree 6・message-stats 6・widget 19)、agents 11/11、tools 70 + 2 skip — 全 green。
- `npm run prepare`(lerna tsc)成功、`theia build --mode development` webpack 5 パス全て compiled successfully(errors 0)。
- 注意: worktree の node_modules には electron `dist/` と keytar/native-keymap/drivelist/@theia-ffmpeg の `build/Release/*.node` が入っていなかったため、メインリポジトリの node_modules から複製して theia build を通した(yarn install ではスクリプト未実行のため生成されない。新 worktree では同じ複製が必要)。

## Phase 1 M6 実装メモ (e-26: 再生成バグ修正 + M6 AUTOTEST + 実機確認)

作成: 2026-07-08 / 対象: M6 最終タスク。(1) レビュー指摘の軽微バグ修正、(2) `ARSCHAT_M6_AUTOTEST` 自動検証の整備、(3) 実 Electron シェルでの実機確認、(4) M3〜M5 回帰。

### (1) バグ修正: 再生成による入力ドラフト消失

- **症状**: `arschat-chat-widget.tsx` の `regenerate()` が `this.inputValue = userText; await this.send()` としており、`send()` が読み取り後に `inputValue` を空にするため、ユーザーが入力欄に書きかけていたドラフトが再生成クリックで失われていた。
- **修正**: 再生成前に `const draft = this.inputValue` で退避 → 再生成対象テキストで `send()` → `finally { this.inputValue = draft; this.update(); }` で復元。send 失敗時も finally で確実に戻す。
- **テスト**: `arschat-chat-widget.test.ts` に 1 件追加。`send()` を「inputValue を読んでクリアする」挙動でスタブし、再生成後に元ドラフトが復元されることを検証(chat 44→45)。

### (2) ARSCHAT_M6_AUTOTEST(`arschat-chat/src/browser/arschat-m6-autotest-contribution.ts`)

M5 AUTOTEST の構造(EnvVariablesServer 経由の backend env ゲート・`[M6]` プレフィックス・t+16s 発火・PASS/FAIL SUMMARY)を踏襲。`ARSCHAT_M6_AUTOTEST=1` 時のみ動作、未設定では完全 no-op。frontend module に bind 2 行追加。検証 6 チェック(実機ログ、実 Electron シェル):

- **(1) 再希釈/メニューバー**: `MenuModelRegistry.getMenu(MAIN_MENU_BAR)` の子ラベルを取得 → `File/Edit/View/Help` のみ・`Run/Selection/Go/Terminal` 無し(`labels=[File, Edit, View, Help] strays=[]`)→ **PASS**。
- **(2) 再希釈/ActivityBar**: `ApplicationShell.getWidgets('left'|'right')` の widget id を走査 → IDE ビュー(scm/debug/test/search/explorer/extensions/outline)・純正 chat ビュー(chat-view-widget)が無く、自前ビュー 2 つ(`arschat-agents:personas`, `arschat-chat:history`)のみ(`strayIdeViews=[]`)→ **PASS**。stale レイアウト復元の検知も兼ねる。
- **(3) ハイライト**: `renderMarkdown` を ts/python/rust のコードブロックに適用 → `class="hljs"` + `<span class="hljs-…">` トークン span を全言語で確認 → **PASS**。
- **(4) KaTeX**: `renderMarkdown('$E=mc^2$')` / `'$$…$$'` → `class="katex"` を inline/block とも確認 → **PASS**。
- **(5) アクションボタン**: ライブ `ArschatChatWidget`(WidgetManager 取得)にモックモデル + ArsChat agent で**実際の送信往復**を流し、完了後の実 DOM に `.arschat-message-actions` が描画され、コピーボタンクリックで `navigator.clipboard.writeText`(spy)が発火(`actionBarRendered=true copyButtonPresent=true clipboardWriteTextFired=true`)→ **PASS**。
- **(6) 統計バー**: 同往復でモックが usage part(input 42 / output 128)を emit → `.arschat-message-stats` が実データで描画(`text='711.11 トークン/秒170 トークン0.2s'`、170=42+128)→ **PASS**。

**SUMMARY: 6 PASS / 0 FAIL**(実機、3 回の起動で再現)。通常起動(`ARSCHAT_M6_AUTOTEST` 未設定)では `[M6]` ログ一切なし(no-op ガード確認)。

### (3) 実機確認と入れた対処

- **実機起動の下準備**: worktree の `node_modules/electron/path.txt` が**空**(メインは `electron.exe`)で `getElectronPath` が「Electron failed to install correctly」で失敗した。`dist/electron.exe` 自体は複製済みだったので path.txt をメインからコピーして解決。**新 worktree では electron dist 複製時に path.txt も要複製**。
- **メニューバー/ActivityBar の希釈**: 起動ログの `[arschat-dilution]` フィルタ発火(`MenuContribution filtered out: DebugFrontendApplicationContribution/…/AIChatContribution` 等)+ 上記 autotest (1)(2) で、メニュー 4 項目のみ・IDE アイコン無しを実機で確認。
- **純正 @theia/ai-chat-ui チャットビューの扱い**: オーケストレーター判断で**非表示**に決定。二重チャット回避のため `AIChatContribution` を `arschat-ide-dilution.ts` の MenuContribution + FrontendApplicationContribution 両フィルタに追加。実機で右サイドパネルに `chat-view-widget` が出ないこと(autotest (2) の `strayIdeViews=[]`)を確認。
- **永続レイアウトの罠(e-21 申し送り)への対処**: 実機の既定 userData でも今回は stale IDE ビューは復活しなかった(ActivityBar クリーン)。ただし「新規レイアウトで自己ドックさせない」FilterContribution は**復元経路(ShellLayoutRestorer が WidgetFactory 経由で id 復元)には効かない**ため、グレースフル終了で IDE ビューが永続化された端末では蘇り得る。安全網として `arschat-stale-ide-view-cleanup.ts`(`ArschatStaleIdeViewCleanup`)を新設: `onDidInitializeLayout`(レイアウト復元後)で左右サイドパネルを走査し、IDE/純正 chat ビュー id を close+dispose(`arschat-` 接頭辞は対象外、クリーン時は no-op ログ)。**実機検証**: `ARSCHAT_M6_SEED_STALE=1` で実 `scm-view-container` をレイアウトに seed → 起動時クリーンアップが実際に除去(`removed stale IDE view … scm-view-container` / `removed 1 stray view(s)`)を実機ログで実証。seed 無しでは `no stray IDE views to remove` の no-op を確認。**注記**: 罠自体は force-kill 主体の検証環境では自然再現しない(レイアウト永続化はグレースフル終了時のみ)ため、除去経路は「実 IDE ビューをシェルに seed して除去」の形で実証した。

### (4) M3〜M5 回帰

- **jest**: chat **45/45**(既存 44 + 再生成ドラフト 1)、agents **11/11**、tools **70 pass + 2 skip** — 全 green、退行なし。
- **ARSCHAT_M5_AUTOTEST(実機)**: (1)ツール登録〜(5)MCP dry-run まで **5 PASS / 0 FAIL** 維持。M6 変更(autotest 追加・希釈フィルタ拡大・stale クリーンアップ)が M5 のツール実行・承認フローを壊していないことを確認。
- **ビルド**: `npm run prepare`(lerna tsc)成功(errorsCount 0)、`theia build --mode development` webpack 全て `compiled successfully`。

### 実機確認できなかった項目

- **GUI の目視スクリーンショット**: ヘッドあり Electron は起動・描画されログ検証は全て通ったが、本タスクでは electron-main 側のスクリーンショット autotest(PoC/M2〜M4 の `capturePage()` 方式)は M6 用に用意していないため、UI の画像取得は行っていない。希釈・見た目要素の合否は上記 autotest のプログラム的検証(MenuModelRegistry/ApplicationShell/実 DOM query)+ `[arschat-dilution]` ログで代替・実証した。
