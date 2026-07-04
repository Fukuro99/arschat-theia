# ArsChat Theia移行 PoC計画

作成: 2026-07-04 / 対象リポジトリ: `arschat-theia`(本リポジトリ)

## 目的

ArsChat を「任意のVS Code拡張が動く独立デスクトップアプリ」として Eclipse Theia ベースで再構築できるか、**着手前に致命的リスクだけを検証**する。PoC-1 と PoC-2 が Go/No-Go ゲート。失敗した場合は要件(独立アプリ性)側を再交渉する。

## 大原則

- **Theia 本体のソースコードは一切改変しない**(EPL-2.0 の開示義務を発生させない)。カスタマイズはすべて自前 Theia extension の DI `rebind` / contribution で行う
- バージョンは Community Release **2026-05 相当(Theia 1.71.x)** にピン留め
- 検証コードは雑でよいが、「rebind だけで実現できたか / Theia のどの層に手を入れたか」を必ず記録する

## PoC項目

### PoC-1: Electron main プロセスのカスタマイズ自由度 【Go/No-Goゲート】

ArsChat 要件との最大の摩擦点。公式ドキュメントに記載がなく、実機検証でしか判定できない。

| # | 検証内容 | 合格基準 | 判定 |
|---|---|---|---|
| 1-1 | システムトレイ常駐 | トレイアイコン+メニュー(表示/非表示/終了)が動作。メインウィンドウを閉じてもアプリが常駐できる | **合格** |
| 1-2 | グローバルホットキー | OS グローバルなショートカット(例: Ctrl+Shift+Space)でウィンドウのトグルが動作 | **合格**(要手動GUI確認、下記参照) |
| 1-3 | ウィジェットウィンドウ | フレームレス・always-on-top の小型 BrowserWindow を第2ウィンドウとして表示。中身は仮HTMLでよい。Theia のウィンドウ管理(ワークスペース=ウィンドウ前提)と衝突しないこと | **合格** |

**合格条件**: 3つすべてが Theia extension(electron-main 層のモジュール追加/rebind)だけで実現できること。

**結論: 3項目すべて合格。Theia本体(node_modules配下)は一切改変せず、`arschat-core/src/electron-main/` の追加モジュールと `ElectronMainApplication` の DI rebind + `ElectronMainApplicationContribution` の追加のみで実現できた。PoC-1はGo判定。**

#### 検証結果の詳細

実装は `arschat-core/src/electron-main/` 配下、`arschat-core/package.json` の `theiaExtensions` に `"electronMain": "lib/electron-main/arschat-electron-main-module"` を追加。

- **1-1 トレイ常駐**: Theiaの `ElectronMainApplication#onWindowAllClosed` は無条件で `requestStop()`(`app.quit()`)を呼ぶ実装になっており、これを止める設定/フックはコントリビューション側に存在しない。唯一の手段は `ElectronMainApplication` をサブクラス化し、DIモジュールで `rebind(ElectronMainApplication).toService(ArschatElectronMainApplication)` すること(この rebind パターン自体、Theia公式の `.d.ts` コメントに明記されている)。`ArschatElectronMainApplication#onWindowAllClosed` をオーバーライドし、トレイ生成成功時のみ `event.preventDefault()` で quit を抑止する形にした(トレイ生成に失敗した場合はフォールバックでデフォルト挙動=quitを維持し、ゾンビプロセス化を防止)。
  - 実機ログ確認: `[PoC-1] tray created successfully` → 全ウィンドウ(メイン+ウィジェット)をクローズ → `[PoC-1] onWindowAllClosed suppressed (tray-resident mode) - app stays alive` → 3秒後も `electron.exe` プロセス生存を確認(自動検証コード `ArschatPoc1AutotestContribution`、`ARSCHAT_POC1_AUTOTEST=1` 時のみ動作)。
- **1-2 グローバルショートカット**: `ElectronMainApplicationContribution#onStart` 内(=`app.whenReady()` 後に呼ばれるタイミング)で `globalShortcut.register('CommandOrControl+Shift+Space', ...)` を呼び出し、戻り値を検証。ログで `[PoC-1] globalShortcut.register('CommandOrControl+Shift+Space') === true` を確認(Ctrl+Shift+W のウィジェット用ショートカットも同様に `true`)。GUIが見えない検証環境のため、実際にOSからキー入力を送ってトグルが起動する様子は目視確認できていない。**register の戻り値が true であることのみ確認済み。実際のキー入力での動作は手動GUI確認が必要**。
- **1-3 ウィジェットウィンドウ**: `new BrowserWindow({ width: 360, height: 480, frame: false, alwaysOnTop: true, ... })` を第2ウィンドウとして生成し、`data:text/html` URLで仮HTML(「ArsChat Widget PoC」)をロード。GUIレスの検証環境のため、自動検証コード内でホットキー入力をシミュレートする形で `toggleWidgetWindow()` を直接呼び出し、生成成功と、その後の全ウィンドウクローズでウィジェットのみが閉じてTheia本体(メインウィンドウ)に影響しないことをログで確認(`[PoC-1] widget window created successfully` → `[PoC-1] widget window closed (main Theia windows unaffected)` → メインウィンドウのクローズは別途進行、トレイ常駐に成功)。見た目(枠なし・最前面・360x480サイズ)は手動GUI確認が必要。

#### 残る手動GUI確認項目

- Ctrl+Shift+Space / Ctrl+Shift+W を実際に押下してメインウィンドウ/ウィジェットウィンドウがトグルすること
- トレイアイコンのクリック・右クリックメニュー(表示/非表示・終了)がマウス操作で正しく動作すること
- ウィジェットウィンドウが実際に「フレームレス・always-on-top・360x480」の見た目で表示されること

### PoC-2: チャット主役のワークベンチレイアウト 【Go/No-Goゲート】

| # | 検証内容 | 合格基準 | 判定 |
|---|---|---|---|
| 2-1 | 起動時レイアウト | 起動直後にカスタム ReactWidget(仮チャットUI)がメインエリアを占有する | **合格** |
| 2-2 | IDE色の希釈 | 不要な ActivityBar 項目・メニュー・ステータスバー項目を非表示化できる | **合格**(該当項目のみ。詳細は下記) |
| 2-3 | ブランディング | アプリ名・ウィンドウタイトル・アイコンを ArsChat に変更できる | **合格**(アイコンはPoC-1流用の仮アイコン) |

**合格条件**: 「IDEにチャットを足した」ではなく「チャットアプリ」に見える状態まで削れること(Samsung Sokatoa が先例)。

**結論: 3項目すべて合格。Theia本体(node_modules配下)は一切改変せず、`arschat-core` の frontend 拡張(既存 `ArschatCoreWidget` の改装 + `FrontendApplicationContribution`/`FilterContribution` の追加)と `electron-app/package.json` の `theia.frontend.config` 設定のみで実現した。PoC-2はGo判定。**

#### 検証結果の詳細

スクリーンショット: `poc-artifacts/poc2-main-window.png`(`ARSCHAT_POC2_AUTOTEST=1` 起動後15秒時点、`webContents.capturePage()` による自動取得。`.gitignore` 対象でリポジトリには含めない)。

- **2-1 起動時レイアウト**: 既存の生成テンプレートウィジェット `ArschatCoreWidget`(左パネルの「ボタン付きサンプル」だった)を、ヘッダー+ダミーメッセージ吹き出し+入力欄風の静的チャットUIに改装(`arschat-core/src/browser/arschat-core-widget.tsx`)。`ArschatCoreContribution`(`arschat-core/src/browser/arschat-core-contribution.ts`)の `defaultWidgetOptions.area` を `'left'` から `'main'` に変更した上で、`FrontendApplicationContribution` を追加実装:
  - `initializeLayout(app)`: 永続化されたシェルレイアウトが存在しない(初回起動/プロファイルクリア後)場合にのみ発火し、チャットウィジェットをメインエリアに開く。Theiaの標準的な「初回レイアウトを作り込む」フック。
  - `onStart(app)`: 上記に加えて**毎回の起動時**にも強制的にウィジェットを open+activate する。理由: `initializeLayout` は初回のみで、過去のセッションでユーザーがウィジェットを閉じているとメインエリアが空になり得るため(PoCの繰り返し起動検証でも実際にこの挙動を確認 — 後述のハマった点参照)。ウィジェット自身も `title.closable = false` にして、そもそもユーザー操作で閉じられないようにした。
  - 実機ログ確認: `[PoC-2] initializeLayout: chat widget opened in main area (fresh layout)` → `[PoC-2] onStart: chat widget activated (id=arschat-core:widget)` → スクリーンショットでメインエリアがチャットUIで占有され、エディタ/Getting Startedが一切表示されていないことを確認(そもそも `@theia/getting-started` は依存に含まれていないため、素の状態でも競合するコンテンツは存在しない)。
- **2-2 IDE色の希釈**:
  - **ActivityBar**: 現在の `electron-app` 依存関係(`@theia/core`, `editor`, `electron`, `filesystem`, `markers`, `messages`, `monaco`, `navigator`, `preferences`, `process`, `terminal`, `workspace`)には **`@theia/scm` / `@theia/debug` / `@theia/search-in-workspace` / `@theia/getting-started` がそもそも含まれていない**。これらのパッケージがActivityBarアイコンやメニューを登録する唯一の主体であるため、「SCM・デバッグ・検索の非表示化」は依存関係を絞った時点で構造的に達成済みで、追加の `FilterContribution` は不要だった(何もしないことが正しい判断)。スクリーンショット上のActivityBarには Explorer(ファイルアイコン)と Settings(歯車)の2項目のみが残る。
  - **メニューバー**: 上記と同じ理由で「Run」「Debug」メニュー自体が最初から存在しない。ただし依存関係が持ち込む IDE 色の強いメニュー — Monaco の「Selection」、Editor の「Go」、Terminal の「Terminal」 — は実際に表示されるため、これらを `FilterContribution`(`ContributionFilterRegistry`)で除去した(`arschat-core/src/browser/arschat-ide-dilution.ts` の `ArschatMenuFilterContribution`)。`MenuContribution` 型に限定してフィルタしたため、対象クラス(`MonacoEditorMenuContribution` / `EditorMenuContribution` / `TerminalFrontendContribution`)のコマンド・キーバインディング・パネル機能自体は無傷(ターミナル機能は引き続き裏で使える、メニューのエントリだけが消える)。実機ログ: `[PoC-2] MenuContribution filtered out: EditorMenuContribution` / `MonacoEditorMenuContribution` / `TerminalFrontendContribution`。スクリーンショットでメニューバーが File/Edit/View/Help の4つのみになったことを確認。
  - **ステータスバー**: コードを書かず、`electron-app/package.json` の `theia.frontend.config.preferences` に `"workbench.statusBar.visible": false` を追加するだけで実現(下記参照)。スクリーンショットで画面下部にステータスバーが一切描画されていないことを確認。
- **2-3 ブランディング**: `electron-app/package.json` の `theia.frontend.config.applicationName` を `"ArsChat"` に設定。ウィンドウタイトルとタブラベルの両方に反映されることをスクリーンショットで確認(タイトルバー表示は `"ArsChat - ArsChat"` — Theiaのデフォルトのタイトルテンプレートがアプリ名を2回組み込む仕様のため。ウィンドウアイコンはPoC-1で作成した仮トレイアイコン(単色PNG)を流用し、`ArschatElectronMainApplication#getDefaultOptions()` のオーバーライドで `BrowserWindowConstructorOptions.icon` として設定(電子ウィンドウのタスクバーアイコンとして反映される想定。パッケージング後の実行ファイルアイコン自体は electron-builder 側の設定でありPoCスコープ外)。

#### 使った拡張ポイントまとめ

| 手段 | 用途 | 本体無改変か |
|---|---|---|
| `AbstractViewContribution` + `defaultWidgetOptions.area: 'main'` | チャットウィジェットをメインエリアに配置 | Yes(標準API) |
| `FrontendApplicationContribution#initializeLayout` | 初回起動時のデフォルトレイアウト | Yes(標準API) |
| `FrontendApplicationContribution#onStart` | 毎起動時の強制アクティベート | Yes(標準API) |
| `FilterContribution` / `ContributionFilterRegistry` | Selection/Go/Terminal メニューの除去 | Yes(標準API、`contribution-filter.d.ts` のdocに明記) |
| `theia.frontend.config.preferences`(package.json) | ステータスバー非表示のデフォルト値上書き | Yes(`FrontendConfigPreferenceContribution` という**Theia組み込み**のコントリビューションが自動的に読む。追加コードなし) |
| `theia.frontend.config.applicationName`(package.json) | アプリ名/ウィンドウタイトル | Yes(標準設定) |
| `ElectronMainApplication#getDefaultOptions()` のrebind + override | ウィンドウアイコン | Yes(PoC-1と同じrebindパターンの応用) |

#### 撤退条件との照合(本体無改変で消せなかったもの)

該当なし。SCM/Debug/Search-in-workspace のActivityBar項目・メニューは依存関係に含まれておらず「消す」以前に存在しないため、CSSハック等の代替手段が必要な場面自体が発生しなかった。唯一 `MenuModelRegistry` に「サブメニューを丸ごと削除する」直接API(`unregisterSubmenu`)が存在しないことが分かったが、`FilterContribution` で契約側のクラスをコントリビューションプロバイダから除外する方法で本体無改変のまま等価な結果を得られたため、実質的な障壁にはならなかった。

### PoC-3: VS Code拡張の実動作

| # | 検証内容 | 合格基準 | 判定 |
|---|---|---|---|
| 3-1 | Open VSX からのインストール | アプリ内から拡張の検索・インストールができる | **部分合格**(拡張ビュー組み込み+Open VSX API+CLI配置は確認済み。アプリ内UIからのワンクリックインストール操作のみ手動GUI確認が残項目) |
| 3-2 | 実拡張の動作 | GitLens / ESLint(または Python) / カラーテーマの3種が activate し基本機能が動く | **合格**(3種すべて activate + 基本機能の実動作をログ・スクリーンショットで確認) |

**結論: Theia本体(node_modules配下)は一切改変せず、`electron-app` への `@theia/plugin-ext` / `@theia/plugin-ext-vscode` / `@theia/vsx-registry`(全て1.71.2)の依存追加と、Open VSX からCLIダウンロードしたVSIXの `plugins/` ディレクトリ配置(展開)だけで、実VS Code拡張3種+言語ビルトイン1種が動作した。**

#### 検証結果の詳細(3-1)

- `@theia/vsx-registry` を依存に追加しただけで、ActivityBarに拡張ビュー(Extensions)が組み込まれ、検索ボックスは「Search Extensions in Open VSX」表示(接続先がOpen VSXであることのUI上の証跡)。ビューのプログラム的オープン(`vsxExtensions.toggle` コマンド実行)が成功し、スクリーンショット(`poc-artifacts/poc3-extensions-view.png`)でRECOMMENDED/INSTALLED/BUILT-INの3セクション描画を確認。
- Open VSX REST API(`https://open-vsx.org/api/{namespace}/{name}/latest`)からのメタデータ取得・VSIXダウンロードは全拡張で成功(ネットワーク経路・レジストリ接続に問題なし)。
- **アプリ内UIからの検索→ワンクリックインストール操作そのもの**はGUIレス検証環境では実施できず、CLIダウンロード+`plugins/`配置で代替した(この代替はPoC着手時に許容済み)。インストールUI操作は手動GUI確認の残項目。
- ローカル配置の重要な仕様: `THEIA_DEFAULT_PLUGINS=local-dir:<絶対パス>` 環境変数または `theia start --plugins=local-dir:plugins` CLI引数で読み込まれるのは**展開済みディレクトリのみ**。`.vsix` ファイルをそのまま置いても `Only user plugins will be handled by file handlers, please unpack the plugin 'xxx.vsix' manually.` と警告されてスキップされる(システム/デフォルトプラグインは展開必須。`.vsix` のままのインストールはユーザープラグイン経路=アプリ内インストールのみ)。`unzip` で `plugins/<publisher>.<name>/` に展開して解決。なお package.json の `theiaPluginsDir` は `theia download:plugins`(ビルド時ヘルパー)専用で、**実行時のプラグイン探索には一切効かない**。

#### 検証結果の詳細(3-2)

検証環境: `poc-artifacts/poc3-workspace/`(git初期化済み、コミット1つ+未コミット変更、意図的にセミコロンを欠落させた `sample.js`、`.eslintrc.json`、ワークスペースローカルの `eslint@8.57.1`)をワークスペースとして起動。`ARSCHAT_POC3_AUTOTEST=1` 時のみ動作する検証コードで自動確認(スクリーンショット2枚: `poc-artifacts/poc3-main-window.png` / `poc3-extensions-view.png`、gitignore対象)。

- **デプロイ**: `HostedPluginSupport.plugins` の実測ログで4拡張全てのデプロイを確認:
  ```
  [PoC-3][autotest] t+10s: deployed plugins (4): eamodio.gitlens@2026.7.30603, dbaeumer.vscode-eslint@3.0.24, dracula-theme.theme-dracula@2.25.1, vscode.javascript@1.95.3
  ```
- **GitLens (eamodio.gitlens@2026.7.30603)**: activate 成功(`~/.theia/globalStorage/eamodio.gitlens` が生成され、plugin host内でGitLensのfeature-flagクライアント(ConfigCat)が実行されるログあり = activate() 実行の直接証拠)。基本機能の実動作: (1) エディタ行内blame注釈「You, 10 hours ago | 1 author (You)」表示、(2) Commit Graph(webviewベース)がパネルに描画され、masterブランチ・コミット履歴・未コミット変更(変更ファイルバッジ)を正しく表示、(3) GitLens系ビューコンテナ(gitlens.views.home/timeline/scm.grouped等)がシェルに登録。**engines.vscode ^1.101.0 を要求する最新版が、より古いAPI水準のTheia 1.71.2でも動いた**(Theiaはenginesのsemverでインストール/ロードを拒否せず、実行時に呼ばれたAPIが存在すれば動く)。
- **ESLint (dbaeumer.vscode-eslint@3.0.24)**: activate 成功+LSP往復の実動作を確認。`sample.js` をエディタで開くと、ESLint言語サーバーが lint を実行し、Theia の Problems マーカーとして診断が届いた:
  ```
  [PoC-3][autotest] t+26s: 2 problem marker(s) total
  [PoC-3][autotest]   marker owner='eslint' uri='file:///c%3A/.../sample.js' message='Missing semicolon.'
  [PoC-3][autotest] ESLint produced 2 marker(s) -> PASS (LSP round-trip works)
  ```
  スクリーンショットでもエディタ内の警告波線+エディタタブの「2」バッジ+Problemsパネルの「2」バッジを確認。
- **カラーテーマ (dracula-theme.theme-dracula@2.25.1)**: `electron-app/package.json` の `theia.frontend.config.preferences` に `"workbench.colorTheme": "Dracula Theme"` を書くだけ(PoC-2のステータスバー非表示と同一のゼロコード機構)で、起動時からDraculaテーマが全面適用された。スクリーンショットでUI全体のDraculaパレット+JSシンタックスハイライト(テーマ+TextMateグラマー)を確認。テーマIDは拡張の `contributes.themes[].label`(`id`フィールドが無い場合)。
- **重要な発見: 素のTheiaには言語定義が無い** — `@theia/monaco` は monaco-editor-core のみで、`.js`→`javascript` の言語ID関連付けやTextMateグラマーは**VS Codeビルトイン拡張**(`vscode.javascript` 等)が供給する。ビルトイン無しでは `sample.js` が `plaintext` で開かれ、ESLintのlanguage probe(`javascript` 言語IDにマッチ)が一切発火しない(エラーも出ず沈黙するため原因特定に時間を要した)。Open VSX の `vscode/javascript`(1.95.3)を plugins/ に追加して解決。**本移行では eclipse-theia.builtin-extension-pack 等のビルトイン一式の同梱が必須になる**。
- **ワークスペーストラスト**: 初回起動時「Do you trust the authors of the files in this folder?」ダイアログが表示され、承認するまでプラグインの activate が(テーマ適用含めて)ブロックされる。GUIレス検証では `"security.workspace.trust.enabled": false` を preference デフォルトに設定して回避した。製品では信頼ダイアログの扱い(無効化 or カスタムUI)の設計判断が必要。

#### 確認された非致命的な問題(記録)

| 事象 | 影響 | 対処 |
|---|---|---|
| `plugin-host ERROR ... Unknown Webview: <uuid>` が起動時に数回 | GitLensのwebview復元レースと推定。Commit Graph webview自体は正常動作 | 放置可(要経過観察) |
| `plugin-host ERROR Failed to parse command arguments: SyntaxError: Bad escaped character in JSON`(GitLensのStatusBarItemツールチップ処理) | ステータスバーツールチップの一部が描画されない可能性(ステータスバー自体を非表示にしているため実害なし) | 放置可 |
| `plugin-manager WARN Unsupported activation events: onTerminal:*` | GitLensのターミナル連携がactivationイベントとしては発火しない(Theia 1.71.2未実装) | 記録のみ |
| `@theia/plugin-ext` が `@theia/debug`/`scm`/`search-in-workspace`/`test`/`notebook` 等を推移的に持ち込み、PoC-2で構造的に排除していた「Run」メニュー・ActivityBar項目(検索/SCM/デバッグ/テスト等)が復活 | IDE色の再流入。PoC-2の「依存に入れなければ出ない」戦略はplugin-ext導入後は成立しない | Phase 1で `FilterContribution` の対象を拡大して再希釈(PoC-2で確立済みの手法で対応可能な見込み)。PoC-3の判定には影響させない |
| `@vscode/windows-ca-certs`(optionalなネイティブ依存)のビルド失敗でwebpackがエラー停止 | ビルド不能(PoC-3最大のハマり) | `electron-app/webpack.config.js`(自前ファイル)でIgnorePlugin登録。詳細はBUILD_NOTES.md |

#### 残る手動GUI確認項目

- 拡張ビューでのOpen VSX検索→ワンクリックインストール→アンインストールの操作系(3-1の完全合格条件)
- ESLint quick fix(電球アイコン)等のエディタ内インタラクション

### PoC-4: Theia AI + Anthropic + MCP

| # | 検証内容 | 合格基準 |
|---|---|---|
| 4-1 | Anthropic 接続 | Theia AI 経由で Claude とのストリーミングチャットが動く |
| 4-2 | MCP | MCPサーバーを1つ登録しツールが呼ばれる |
| 4-3 | カスタム描画 | チャット応答のカスタムレスポンスレンダラー(独自Reactコンポーネント)を1つ差し込める |

### PoC-5: 組み込みGraphRAG スパイク(ゲート外・後回し可)

Neo4j 廃止の技術検証。**追加ダウンロード無し**が要件。

| # | 検証内容 | 合格基準 | 判定 |
|---|---|---|---|
| 5-1 | sqlite-vec | Theia backend(Node)で better-sqlite3 + sqlite-vec(npm同梱、外部インストール不要)をロードし、ベクター類似検索が動く | **合格** |
| 5-2 | グラフ層 | nodes/edges テーブル+再帰CTEで k-hop 近傍探索が動く(GraphRAG の最小形: ベクター検索でエントリノード→グラフ展開で文脈収集) | **合格** |

**結論: 5-1/5-2/統合デモすべて合格。ただしスタンドアロンNodeスクリプトでの検証(`poc-graphrag/`配下、Theiaアプリへの組み込み自体はスコープ外)。「追加ダウンロード無し」要件は `better-sqlite3` をv12系以降に固定する前提で満たせる(v11系はNode v24向けプリビルド未提供でnode-gypローカルビルドにフォールバックする既知の問題があり、C++ビルドツール未導入環境では`npm install`が失敗しうる)。sqlite-vec本体はWindows含む主要プラットフォーム向けにnpm経由でプリビルド済みネイティブDLLが入り追加ダウンロード不要(ただしwin32-arm64は非対応)。詳細は `poc-graphrag/README.md` 参照。**

#### 検証結果の詳細(PoC-5)

実装は `poc-graphrag/`(独立npmパッケージ、`arschat-core`/`electron-app`とは無関係のスタンドアロンNodeスクリプト)。

- **5-1 sqlite-vec**: `scripts/5-1-vector-search.js`。384次元・50件のダミー埋め込み(決定的擬似乱数)を`vec0`仮想テーブルに投入し、KNN検索(`MATCH`句、k=5)を実行。クエリ(item-1+微小ノイズ)に対し最近傍がitem-1自身であることを確認、JS側ブルートフォースのコサイン距離1位とも一致。5000件挿入40ms・KNN検索1.9msと性能上も問題なし。
- **5-2 グラフ層**: `scripts/5-2-graph-khop.js`。`nodes(id,label,content)`/`edges(src,dst,relation)`で30ノード37エッジの知識グラフを構築し、`WITH RECURSIVE`による無向k-hop近傍探索(k=2)を実施。起点ノードから期待される1-hop/2-hopノード群が正しく取得できることを確認。
- **統合デモ**: `scripts/5-3-integrated-graphrag.js`。1つのSQLiteファイルに`vec0`とnodes/edgesを同居させ、「クエリベクター→vec0でエントリノード特定→再帰CTEで2-hop展開→文脈テキスト収集」のGraphRAG最小パイプラインが1スクリプトで動作することを確認。
- **Electron組み込みの既知リスク(情報収集のみ、実機未検証)**: ASARパッケージング下でのネイティブ拡張(`.dll`)ロード問題(asarUnpack設定が必須、electron-builderでsqlite-vecの実例報告あり)、Node/Electron間のABI不一致(`@electron/rebuild`相当が必須)。いずれも既知の回避策があり致命的ブロッカーではないと判断。
- **Neo4j比で失われる機能**: Cypherの高度なグラフアルゴリズム(GDS: PageRank/コミュニティ検出等)、ベクターのANN(近似最近傍、sqlite-vecはブルートフォース)、マルチクライアント同時書き込み。ユーザーメモリのk-hop文脈収集用途では現状規模感で実用上問題ないと判断。

## 判定

- **PoC-1, 2 合格** → Theia 移行を正式決定し、Phase 1(チャットコア移植)の設計へ
- **PoC-1 が rebind で不可能 / Theia 本体改変が必要** → No-Go。要件再交渉(ウィジェット/トレイを別プロセス化する案、等)
- 3, 4 は不合格項目があっても回避策の検討材料として記録

## 進行メモ

- [x] 足場: generator-theia-extension で Electron アプリ生成、ビルド・起動確認(詳細は `BUILD_NOTES.md` 参照。Theia 1.71.2 / yarn 1.22.22。起動ログ上エラーなし、`ready` 状態到達、electron.exeプロセス生存確認済み)
- [x] PoC-1: 1-1/1-2/1-3 すべて合格。Theia本体無改変、`arschat-core` の electron-main 拡張(DI rebind + contribution)のみで実現。詳細は上表および `BUILD_NOTES.md` 参照。globalShortcutの実キー入力とウィジェット/トレイの見た目は手動GUI確認が残項目。
- [x] PoC-2: 2-1/2-2/2-3 すべて合格。Theia本体無改変、`arschat-core` の frontend 拡張(既存 `ArschatCoreWidget` の main エリア化 + `FrontendApplicationContribution` + `FilterContribution`)と `electron-app/package.json` の `theia.frontend.config` 設定のみで実現。SCM/Debug/Search-in-workspaceのActivityBar項目・メニューは依存関係に含まれておらず構造的に非表示(追加対応不要)。詳細は上表および `BUILD_NOTES.md` 参照。スクリーンショットは `poc-artifacts/poc2-main-window.png`(gitignore対象、リポジトリ非同梱)。
- [x] PoC-3: 3-1 部分合格(拡張ビュー組み込み・Open VSX接続・CLI配置での拡張導入は確認済み、アプリ内インストールUI操作のみ手動GUI確認が残項目)/ 3-2 合格(GitLens・ESLint・Draculaテーマの3種+vscode.javascriptビルトインがactivateし基本機能が実動作: GitLens行内blame+Commit Graph webview、ESLintのLSP診断がProblemsマーカーに到達、テーマ全面適用)。Theia本体無改変。`electron-app` に `@theia/plugin-ext`/`plugin-ext-vscode`/`vsx-registry`(1.71.2)を追加、VSIXはOpen VSXからCLIダウンロードして `electron-app/plugins/` に**展開して**配置(`theia start --plugins=local-dir:plugins`)。最大のハマりは (1) `@vscode/windows-ca-certs` optionalネイティブ依存のビルド失敗でwebpack停止(webpack.config.jsのIgnorePluginで解決)、(2) 素のTheiaに言語定義が無く `.js` が plaintext になりESLintが沈黙(vscode.javascriptビルトイン追加で解決)、(3) ワークスペーストラストダイアログがactivateをブロック(preferenceで無効化)。詳細は上表および `BUILD_NOTES.md` 参照。スクリーンショットは `poc-artifacts/poc3-main-window.png` / `poc3-extensions-view.png`(gitignore対象)。
- [ ] PoC-4
- [x] PoC-5: 5-1/5-2/統合デモすべて合格。`poc-graphrag/`(独立npmパッケージ、Theia組み込みはスコープ外)でbetter-sqlite3+sqlite-vecによるベクター検索と再帰CTEによるグラフk-hop探索、両者を組み合わせたGraphRAG最小パイプラインが動作することを確認。「追加ダウンロード無し」要件はbetter-sqlite3をv12系以降に固定する前提で満たせる(v11系はNode v24向けプリビルド未提供の既知問題あり)。詳細は上表および `poc-graphrag/README.md` 参照。Electron実機組み込み検証(ASARアンパック設定・electron-rebuild)は未実施(情報収集のみ、スコープ外)。
