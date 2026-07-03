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
