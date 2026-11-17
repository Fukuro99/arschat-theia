# 実装ブリーフ: VS Code 拡張のビューを希釈から漏らさない

> 指揮 (Opus) 作成、調査は Sonnet (node_modules 実測)。実装・レビューは Codex CLI。ブランチ `fix/plugin-view-dilution`。

## 0. 問題

`electron-app/plugins/` の VS Code 拡張 (GitLens など) が出すビュー (`plugin-view-container:*`) と、GitLens が呼び込む `scm-view-container` が左パネルに出る。
既存の希釈 (`arschat-branding/src/browser/arschat-ide-dilution.ts` の FilterContribution、`arschat-stale-ide-view-cleanup.ts` の起動時掃除) は、プラグイン経由の経路に効かない。
その影響で M6 autotest シナリオ 2 (activity bar) が FAIL している (BUILD_NOTES の ms-11 実装メモ)。

## 1. 原因 (node_modules/@theia/plugin-ext/lib/main/browser 配下、実測)

- `plugin-contribution-handler.js:190-208`: `contributes.viewsContainers` / `views` は `PluginViewRegistry.registerViewContainer` / `registerView` を直接呼ぶ (ContributionProvider を通らないので FilterContribution の対象外)。
- `view/plugin-view-registry.js:548-580` `openViewContainer(containerId)` が、ウィジェットを作って左パネルに載せる唯一の口。
  - `'scm'` の場合は `this.scm.openView()` を呼ぶ。ScmContribution を FrontendApplicationContribution から外す希釈は `initializeLayout` を止めるだけで、このメソッド呼び出しは止められない。これが scm-view-container 復活の正体。
  - それ以外は `shell.addWidget(containerWidget, { area: isSideArea(location) ? location : 'left' })` (:574)。
- 呼び出し元は `doOpenView`(:505) / `updateViewVisibility`(:200、`when` が true になると自動で開く) / `initViewContainer`(:660、起動時) / `toggleViewContainer`(:261) / QuickView open(:295) / `tree-views-main.js:105`。いずれも戻り値 `undefined` を許容している。
- bind: `plugin-ext-frontend-module.js:222-223` で `bind(PluginViewRegistry).toSelf().inSingletonScope()`、FrontendApplicationContribution は `.toService(PluginViewRegistry)`。rebind すれば toService は新しい実体に追従する。
- 復元経路: 永続レイアウトの `plugin-view-container:<id>` と `scm-view-container` は ShellLayoutRestorer が再生成する。`removeStaleWidgets`(:723) は未登録コンテナしか消さない。

## 2. 実装 (変更不可の方針)

1. **`ArschatPluginViewRegistry extends PluginViewRegistry`** を `arschat-branding/src/browser/arschat-plugin-view-registry.ts` に新設。
   - `openViewContainer(containerId)` を override。許可リストに無い id なら `undefined` を返して何もしない。許可リストにあれば `super.openViewContainer`。
   - 許可リストは `explorer` と `search` の 2 つ (プラグインが Explorer / Search に足すビューの受け皿)。定数として export する。
   - 拒否ログは container id ごとに 1 回だけ (`[arschat-dilution] plugin view container suppressed: <id>`)。`updateViewVisibility` が何度も呼ぶので連打しない。
   - `registerView` / `registerViewContainer` は override しない (コマンド・TreeView データプロバイダ・webview resolver の前提を壊すため)。登録は許して、開かせないだけ。
2. **rebind**: arschat-branding の frontend module で `rebind(PluginViewRegistry).to(ArschatPluginViewRegistry).inSingletonScope()`。
   - モジュールのロード順で plugin-ext の bind より後になることを確認する (arschat-branding は既に `@theia/plugin-ext` に依存)。念のため `isBound(PluginViewRegistry)` を確認し、未 bind なら bind、bind 済みなら rebind。
   - `PluginViewRegistry` のコンストラクタ/プロパティ注入の形を node_modules で確認し、サブクラスで壊さないこと。
3. **既存プロファイルに復元済みのコンテナの掃除**: `arschat-stale-ide-view-cleanup.ts` を拡張し、`plugin-view-container:` で始まる widget のうち許可リスト外のものを dispose する (既存パターンの `scm` は現行ロジックで消えるはず。実際に消えるか確認)。
4. **ポリシー**: 既定は全拒否。ユーザーが明示的に開きたいケースへの個別許可は今回は作らない (BUILD_NOTES に「将来 Git UI を出すなら許可リストに追加」と書く)。
5. GitLens の blame・コマンド・ステータスバー・エディタ領域の webview (Commit Graph をエディタで開く等) はこの経路を通らないので影響しない。壊さないこと。

## 3. テスト

- arschat-branding には jest 設定が無い。**ロジックを純関数 (例 `isPluginViewContainerAllowed(id)` と「ログ済み集合」管理) に切り出し、jest のある `arschat-chat` 側ではなく、arschat-branding に最小の jest 設定を追加してテストする** (configs/jest.config.ts は arschat-agents/configs/jest.config.ts を手本に。ts-jest の設定と `setupFiles` を流用)。`package.json` に `"test": "jest --config configs/jest.config.ts"` と devDependencies を追加 (既にルート node_modules にある jest / ts-jest のバージョンに合わせ、新規 npm install は不要な形にする)。
  - 許可: `explorer` / `search` → true。拒否: `scm` / `debug` / `test` / `gitlens` / `workbench.view.extension.gitlens` → false。
  - ログは同じ id で 2 回呼んでも 1 回だけ。
- M6 autotest (`arschat-chat/src/browser/arschat-m6-autotest-contribution.ts`) の期待値は変更しない。修正後にそのまま PASS する想定。

## 4. 完了条件 (実装者が確認)

1. `npm --prefix arschat-branding run build` が tsc エラー 0。
2. `npm --prefix arschat-branding test` が green、`npm --prefix arschat-chat test` も green (回帰確認)。
3. `npm run build:electron` / `build:browser` は**実行しない** (この worktree の node_modules はメイン checkout を指しており、アプリのバンドルはメイン側のパッケージを拾うため意味がない。指揮側がマージ後に実行する)。
4. コミットしない。node_modules と lib は編集禁止。この worktree の `node_modules` はメイン checkout へのジャンクションなので、絶対に中身を変更しない (npm install も禁止)。
