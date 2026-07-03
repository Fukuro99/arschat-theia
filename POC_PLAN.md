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

| # | 検証内容 | 合格基準 |
|---|---|---|
| 3-1 | Open VSX からのインストール | アプリ内から拡張の検索・インストールができる |
| 3-2 | 実拡張の動作 | GitLens / ESLint(または Python) / カラーテーマの3種が activate し基本機能が動く |

### PoC-4: Theia AI + Anthropic + MCP

| # | 検証内容 | 合格基準 |
|---|---|---|
| 4-1 | Anthropic 接続 | Theia AI 経由で Claude とのストリーミングチャットが動く |
| 4-2 | MCP | MCPサーバーを1つ登録しツールが呼ばれる |
| 4-3 | カスタム描画 | チャット応答のカスタムレスポンスレンダラー(独自Reactコンポーネント)を1つ差し込める |

### PoC-5: 組み込みGraphRAG スパイク(ゲート外・後回し可)

Neo4j 廃止の技術検証。**追加ダウンロード無し**が要件。

| # | 検証内容 | 合格基準 |
|---|---|---|
| 5-1 | sqlite-vec | Theia backend(Node)で better-sqlite3 + sqlite-vec(npm同梱、外部インストール不要)をロードし、ベクター類似検索が動く |
| 5-2 | グラフ層 | nodes/edges テーブル+再帰CTEで k-hop 近傍探索が動く(GraphRAG の最小形: ベクター検索でエントリノード→グラフ展開で文脈収集) |

## 判定

- **PoC-1, 2 合格** → Theia 移行を正式決定し、Phase 1(チャットコア移植)の設計へ
- **PoC-1 が rebind で不可能 / Theia 本体改変が必要** → No-Go。要件再交渉(ウィジェット/トレイを別プロセス化する案、等)
- 3, 4 は不合格項目があっても回避策の検討材料として記録

## 進行メモ

- [x] 足場: generator-theia-extension で Electron アプリ生成、ビルド・起動確認(詳細は `BUILD_NOTES.md` 参照。Theia 1.71.2 / yarn 1.22.22。起動ログ上エラーなし、`ready` 状態到達、electron.exeプロセス生存確認済み)
- [x] PoC-1: 1-1/1-2/1-3 すべて合格。Theia本体無改変、`arschat-core` の electron-main 拡張(DI rebind + contribution)のみで実現。詳細は上表および `BUILD_NOTES.md` 参照。globalShortcutの実キー入力とウィジェット/トレイの見た目は手動GUI確認が残項目。
- [x] PoC-2: 2-1/2-2/2-3 すべて合格。Theia本体無改変、`arschat-core` の frontend 拡張(既存 `ArschatCoreWidget` の main エリア化 + `FrontendApplicationContribution` + `FilterContribution`)と `electron-app/package.json` の `theia.frontend.config` 設定のみで実現。SCM/Debug/Search-in-workspaceのActivityBar項目・メニューは依存関係に含まれておらず構造的に非表示(追加対応不要)。詳細は上表および `BUILD_NOTES.md` 参照。スクリーンショットは `poc-artifacts/poc2-main-window.png`(gitignore対象、リポジトリ非同梱)。
- [ ] PoC-3
- [ ] PoC-4
- [ ] PoC-5
