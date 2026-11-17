# MS15 実装ブリーフ: Explorer / Search / Outline の IDE 希釈解除

> 調査担当 (Sonnet) 作成、指揮 (Fable) 編集。node_modules 実測済み。実装は Codex CLI に委任予定。
> 参照 SPEC: `docs/specs/ms-15-spec-ファイルブラウザ-全文検索-アウトラインが使える-explorer-search-outline-の-ide-希釈解除.md`
> 確定済み設計判断 (変更不可): 3 ビュー一括復活 / フォルダ動線は Theia 標準 (手動 + 前回復元) / 空 Explorer の独自案内 UI は作らない / チャット主役レイアウト不変更。

## 1. 「フォルダーを開く」動線の生存確認

**結論**: `WorkspaceFrontendContribution` は希釈フィルタの対象外で無傷。electron かつ非OSX (Windows) では File メニューに「Open Folder...」が現に出ている。ワークスペース未オープン時、Explorer 自体には「Open Folder」ボタンは出ない (ArsChat が viewsWelcome を提供する plugin を同梱していないため)。

- `arschat-branding/src/browser/arschat-ide-dilution.ts` の import 一覧および `MENU_FILTERED`/`ACTIVITY_BAR_FILTERED` に `WorkspaceFrontendContribution` は存在しない。
- `node_modules/@theia/workspace/src/browser/workspace-frontend-contribution.ts:187-197` — `if (!isOSX && this.isElectron())` で `CommonMenus.FILE_OPEN` に `WorkspaceCommands.OPEN_FOLDER` を登録 (label: `"Open Folder..."`)。
- `node_modules/@theia/navigator/src/browser/navigator-widget.tsx:114-116` — `shouldShowWelcomeView() { return this.model.root === undefined; }`。welcome view は `viewsWelcome` contribution (plugin-ext 経由) が登録されている場合のみ描画。ArsChat 同梱 plugin (eslint / gitlens / dracula / javascript) に explorer 用は無い → 未オープン時は空の Explorer。
- `navigator-widget.tsx:189-200` の `renderEmptyMultiRootWorkspace()` は「multi-root workspace で root 0 個」の別ケースのみ。

## 2. Explorer の実 id

**結論**: widget id は `files`、view container id は `explorer-view-container`。stale パターン `'files'`/`'explorer'` に一致。**`'navigator'` はどの実 id にも一致しない死んだパターン**。

- `node_modules/@theia/navigator/src/browser/navigator-widget.tsx:32` — `FILE_NAVIGATOR_ID = 'files'`
- `node_modules/@theia/navigator/src/browser/navigator-widget-factory.ts:29` — `EXPLORER_VIEW_CONTAINER_ID = 'explorer-view-container'`
- `node_modules/@theia/navigator/src/browser/navigator-contribution.ts:167-169` — `super({ viewContainerId: EXPLORER_VIEW_CONTAINER_ID, widgetId: FILE_NAVIGATOR_ID, ... })`
- Open Editors ウィジェットは `theia-open-editors-widget` (navigator-open-editors-widget.tsx:59)。

## 3. エディタとチャット主役レイアウトの衝突

**結論**: 実行時の衝突なし。`ArschatChatContribution.onStart()` (arschat-chat-contribution.ts:70-73) は毎起動時に 1 回チャットを強制アクティブ化するのみで、実行中にフォーカスを奪い返すリスナーは存在しない (grep 裏取り済み)。影響は「再起動直後はエディタでなくチャットが前面」のみ — SPEC 方針 5 で仕様と割り切り済み。

## 4. 前回ワークスペースの自動復元

**結論**: Theia 標準で復元される。ArsChat 側に無効化設定・上書きコード無し。

- `node_modules/@theia/workspace/src/browser/workspace-service.ts:227-231` — URL hash 無しなら `getMostRecentlyUsedWorkspace()`。
- `node_modules/@theia/workspace/src/node/default-workspace-server.ts:126-135, 220-223` — `<configDir>/recentworkspace.json` に保存・読出し。
- `electron-app/package.json` の preferences に workspace 復元を止める設定は無い。

## 5. FileNavigatorContribution の bind 型全量

Command / Keybinding / Menu (bindViewContribution 経由) + FrontendApplicationContribution + TabBarToolbarContribution の計 5 型 (navigator-frontend-module.ts:53-55)。フィルタ除外で全部復活する。

## 6. SearchInWorkspaceFrontendContribution

- widget id: `'search-in-workspace'` (search-in-workspace-widget.tsx:44) — stale パターンと完全一致。
- bind 型: 上記 5 型 + StylingParticipant の計 6 型 (search-in-workspace-frontend-module.ts:52-55)。
- `initializeLayout()` は無条件で `openView({ activate: false })` (contribution.ts:160-162)。ワークスペース未オープン時は検索コマンド無効 (`isEnabled: tryGetRoots().length > 0`、contribution.ts:166-172) + ウィジェットは「開いているファイルのみ検索」の注記表示 (widget.tsx:418-423)。

## 7. OutlineViewContribution

- widget id: `'outline-view'` (outline-view-contribution.ts:29) — stale パターン `'outline'` に部分一致。
- bind 型: 5 型 (outline-view-frontend-module.ts:52-54)。
- `initializeLayout` で **右エリア** (`area: 'right'`, rank 500) に無条件 dock (outline-view-contribution.ts:56-71)。

## 8. 期待値配列の重複 3 箇所 (同期修正必須)

`'navigator'`, `'explorer'`, `'files'`, `'search-in-workspace'`, `'outline'` の 5 パターンを以下すべてから外す。残すのは `'scm'`, `'debug'`, `'test'`, `'chat-view-widget'`:

1. `arschat-branding/src/browser/arschat-stale-ide-view-cleanup.ts:42-45` — `STALE_IDE_VIEW_ID_PATTERNS`
2. `arschat-chat/src/browser/arschat-m6-autotest-contribution.ts:190-193` — ローカル再定義 `idePatterns`
3. `arschat-branding/src/browser/arschat-m12-autotest-contribution.ts:149-152` — 同上 (155 行目の VSX allowlist と同型の扱い)

## 9. 実装方針メモ (指揮側の追記)

- フィルタ側の対応本体: `arschat-ide-dilution.ts` の 2 配列から `FileNavigatorContribution` / `SearchInWorkspaceFrontendContribution` / `OutlineViewContribution` を除外 (ms-12 の VSXExtensionsContribution と同じ要領)。コメントも実態に合わせて更新。
- 永続レイアウト補完: ms-12 の `arschat-extensions-view-restorer.ts` を「(widget/factory id, area) の一覧を持つ汎用復元 contribution」に一般化するのが自然。対象: `explorer-view-container` (左) / `search-in-workspace` (左) / `outline-view` (右) / `vsx-extensions-view-container` (左、既存)。冪等 (あれば no-op)・activate しない、は既存と同じ。
  - 注意: Search は view container ではなく単体 widget (id `search-in-workspace`) を `WidgetManager.getOrCreateWidget` する形になるはず — factory id が widget id と一致するかは実装時に node_modules で最終確認すること。
- ARSCHAT_M15_AUTOTEST: M12 型踏襲。シナリオ案: (1) 左に explorer-view-container と search-in-workspace、右に outline-view が dock (2) 希釈回帰 (メニュー + サイドパネル、5 パターン除去後の期待値で) (3) 可能ならワークスペース未オープンでも Explorer が開ける (toggle コマンド)。フォルダを開く・編集・検索ヒットは実フォルダ依存のため実機手動確認に回す。
- Jest: 既存テストへの影響は無い見込み (ms-12 時に grep 確認した通り stale パターンを参照するテストは無い) — 実装時に再確認。
