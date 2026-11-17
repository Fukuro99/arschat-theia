# MS12 実装ブリーフ: Extensions ビューをアクティビティバーに復活 (Open VSX 統合)

> 指揮担当 (Fable) 作成。node_modules 実測済みの事実に基づく。実装は Codex CLI に委任。
> 参照 SPEC: `docs/specs/ms-12-spec-vs-code-拡張を検索してワンクリックで入れられる-open-vsx-マーケットプレイス統合.md`
> 確定済み設計判断 (変更不可): 純正 vsx-registry Extensions ビューをアクティビティバーに復活させる方式。独自 UI・ヘッダーボタン方式は却下済み。node_modules 無改変。

## 0. 既に完了している変更 (再実装しないこと。ただし整合性は確認してよい)

指揮側で以下 2 ファイルは編集済み (git diff で確認できる):

1. `arschat-branding/src/browser/arschat-ide-dilution.ts` — `VSXExtensionsContribution` を `MENU_FILTERED` / `ACTIVITY_BAR_FILTERED` の両方から除外し、import も削除。コメント更新済み。
2. `arschat-branding/src/browser/arschat-stale-ide-view-cleanup.ts` — `STALE_IDE_VIEW_ID_PATTERNS` から `'vsx'`, `'extension'` を除去。コメント更新済み。

## 1. 裏取り済みの事実 (node_modules 実測)

1. **Extensions ビューコンテナの id**: `VSXExtensionsViewContainer.ID = 'vsx-extensions-view-container'` (`node_modules/@theia/vsx-registry/lib/browser/vsx-extensions-view-container.js:38`)。
2. **開閉コマンド id**: `vsxExtensions.toggle` (`VSXExtensionsContribution` が登録。既存の `arschat-branding/src/browser/arschat-poc3-autotest-contribution.ts:48` が同 id を使用中で動作実績あり)。
3. **検索モデル**: `VSXExtensionsSearchModel` (`@theia/vsx-registry/lib/browser/vsx-extensions-search-model`) に `set query(string)` があり、query 変更で `VSXExtensionsModel` (`.../vsx-extensions-model`) が Open VSX へ検索を投げ、`model.searchResult` (`IterableIterator<string>`, 拡張 id 群) が更新される。
4. **永続レイアウトの罠 (e-21 と同根、今回は逆向き)**: `AbstractViewContribution.initializeLayout()` は**フレッシュなレイアウトの初回起動でしか走らない**。永続レイアウトが既にあるプロファイル (開発機含む既存ユーザー全員) では、フィルタを外しただけでは Extensions アイコンは左のアクティビティバーに**現れない** (これまでのビルドの永続レイアウトに vsx ウィジェットは含まれず、むしろ stale 掃除が消し続けてきた)。→ §2-1 の「復元 contribution」が必須。
5. **M6 autotest との衝突**: `arschat-chat/src/browser/arschat-m6-autotest-contribution.ts:189-192` の `idePatterns` に `'vsx'`, `'extension'` が残っている。Extensions ビューが正規化されると M6 autotest のシナリオ (2) が FAIL するようになる。→ §2-2 で除去必須。

## 2. 残実装 (Codex の作業)

### 2-1. Extensions ビューの永続レイアウト補完 contribution (新規ファイル)

`arschat-branding/src/browser/arschat-extensions-view-restorer.ts` (命名は任せる):

- `FrontendApplicationContribution` を実装し、`onDidInitializeLayout` で `shell.getWidgets('left')` に id `vsx-extensions-view-container` のウィジェットが**無ければ** `widgetManager.getOrCreateWidget(VSXExtensionsViewContainer.ID)` → `shell.addWidget(widget, { area: 'left' })` で追加する。
- **activate / reveal はしないこと** (チャットが主役。アイコンが並ぶだけでよい。`arschat-stale-ide-view-cleanup.ts:112-120` の `seedStaleViewForVerification()` が同型の実装例)。
- 実行順序: stale 掃除の `onDidInitializeLayout` との順序は不問 (掃除は vsx を対象にしなくなったため)。
- ファイル冒頭コメントに「なぜ必要か」(§1-4 の罠) を既存ファイルの流儀で書くこと。
- `arschat-branding/src/browser/arschat-branding-frontend-module.ts` に bind 追加 (`toSelf().inSingletonScope()` + `FrontendApplicationContribution.toService`、既存パターン踏襲)。

### 2-2. M6 autotest の期待値更新

`arschat-chat/src/browser/arschat-m6-autotest-contribution.ts`:

- `idePatterns` (L189-192) から `'vsx'`, `'extension'` を除去。
- 周辺コメント (L16 付近の「extensions/outline ... are docked」の記述) を実態に合わせて更新 (Extensions は ms-12 で正規のビューになった旨)。

### 2-3. ARSCHAT_M12_AUTOTEST contribution (新規ファイル)

`arschat-branding/src/browser/arschat-m12-autotest-contribution.ts`:

- 型は `arschat-chat/src/browser/arschat-m11-autotest-contribution.ts` の完全踏襲: `ARSCHAT_M12_AUTOTEST !== '1'` なら即 return、`onStart` で `setTimeout(16000)`、`scenarioXxx` 群 → `[M12][autotest] SUMMARY: N PASS / M FAIL` を `console.log` + `ILogger` 両方へ。
- シナリオ:
  1. **icon-docked**: `shell.getWidgets('left')` に `vsx-extensions-view-container` が存在する (§2-1 の復元 or フレッシュ initializeLayout どちらの経路でも成立するはず)。
  2. **open-view**: `commandService.executeCommand('vsxExtensions.toggle')` → `waitFor` でコンテナウィジェットの `isVisible === true` (タイムアウト 10s)。
  3. **live-search**: `VSXExtensionsSearchModel` を注入して `searchModel.query = 'theme'` → `waitFor` で `Array.from(model.searchResult)` が 1 件以上 (タイムアウト 20s、open-vsx.org への実ネットワーク)。ヒット件数と先頭数件の id をログに出す。オフライン時は FAIL になるが許容 (このテストは手動起動)。
  4. **dilution-regression**: メニューバーに Run/Selection/Go/Terminal が無く、left/right に scm/debug/navigator 等の stray が無いこと (`arschat-m6-autotest-contribution.ts` の (1)(2) と同じ手法。ただし vsx は「あるのが正」)。
- `arschat-branding-frontend-module.ts` に bind 追加。

### 2-4. ビルド + 既存テスト

- ルートで TypeScript ビルドが通ること (ビルドコマンドは各 package.json の scripts を確認して選ぶこと。node-pty 等のネイティブ再ビルドは不要な変更範囲)。
- 既存 Jest スイート (arschat-chat 等) が green のまま (今回の変更にテスト依存が無いことは grep 確認済みだが、回帰確認として実行)。
- 新規 Jest テストは必須ではない (新規ロジックは DI 済みサービス呼び出しの薄い層のみ。書くなら復元 contribution の「left に無ければ足す / あれば何もしない」の 2 ケース程度で十分)。

## 3. 罠・注意

1. **`'extension'` を含む id の別ウィジェットは無いか**: stale 掃除から `'extension'` を外したことで復元を許すようになる id は vsx 系のみのはず (plugin-ext のビューは editor-hosted)。実装中に別の `*extension*` id のサイドビューを見つけたら報告すること。
2. **復元 contribution は毎起動走る**: 冪等 (あれば no-op) を保つこと。ユーザーが将来ビューを閉じる操作をした場合も次回起動で戻る挙動になるが、これは「アイコンが常にある」という受入条件側に倒す (SPEC 準拠)。
3. **`vsxExtensions.toggle` は toggle**: シナリオ 2 で既に開いていた場合は閉じてしまう。実行前に `isVisible` を確認し、閉じていた場合のみ toggle → 開いたことを確認、のガードを入れること。
4. コミットはまだ作らないこと (レビュー収束後に指揮側でまとめる)。
