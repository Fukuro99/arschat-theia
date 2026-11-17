# MS14 実装ブリーフ: ArsChat 独自拡張システム (サンドボックス iframe + 権限ゲート API)

> 指揮担当 (Fable) 作成。移植元 (C:\Users\takep\source\ArsChat) と本リポジトリの両方を実測調査済み。実装は Codex CLI に委任。
> 参照 SPEC: `docs/specs/ms-14-spec-arschat-独自拡張を-github-から権限確認付きで設置できる.md`
> タスク ID (旧 Beacon): e-93〜e-100

## 0. 確定済み設計判断 (変更不可)

1. **拡張 UI はサンドボックス iframe で実行し、権限を構造的に強制する**。旧 ArsChat の「直接ロード + 自己申告権限」は却下済み。Node/backend 側で動く拡張 (旧 main.js 相当) は本 MS では非対応。
2. **API は新設計** (旧 ArsChat API との互換は取らない)。権限は read/write 分離、OR 判定によるグループ一括解放は禁止。
3. **設置は「ビルド済みファイル取得」+「ローカルパス開発モード」の両対応**。設置時に拡張側のコード・ビルドスクリプトを一切実行しない (git clone / npm install / npm build は禁止)。
4. **権限確認ダイアログは設置フローの必須ステップ**。承認は永続化し、更新で権限が増えたら増分を再確認。

## 1. 拡張の形式 (manifest + 自己完結 HTML)

拡張 = 2 ファイルで完結:

- `arschat-extension.json` (manifest):
  ```json
  {
    "name": "arschat-ext-hello",
    "displayName": "Hello Sample",
    "version": "0.1.0",
    "description": "サンプル拡張",
    "permissions": ["chat:send", "storage:read", "storage:write"],
    "entry": "main.html"
  }
  ```
- `entry` が指す **自己完結 HTML 1 ファイル** (JS/CSS はインライン必須。CSP が `default-src 'none'` + inline のみ許可のため、外部リソースは構造的に読めない)。

manifest 検証ルール (単体テスト必須):
- `name`: `^[a-z0-9][a-z0-9-]*$`、必須
- `displayName` / `version` / `entry`: 必須、`entry` は `.html` で終わる相対パス (`..` を含むパスは拒否)
- `permissions`: 既知の権限 ID の配列 (未知 ID はエラーで拒否、黙殺しない)
- 不正 manifest は理由付きエラーで設置拒否

## 2. 権限と API (最小セット)

| 権限 ID | 日本語説明 (ダイアログ表示用) | 解放されるブリッジ method |
|---|---|---|
| `chat:read` | 現在のチャットの会話内容を読み取る | `chat.read` |
| `chat:send` | あなたの代わりに AI へメッセージを送る | `chat.send` |
| `storage:read` | この拡張専用の保存領域を読む | `storage.get` |
| `storage:write` | この拡張専用の保存領域に書き込む | `storage.set` |
| `notification` | 画面右下に通知を表示する | `notification.show` |

- method → 権限は **1:1 対応の明示 map** で実装 (旧実装の OR 判定グループ解放の再現禁止)。
- `storage` は `${configDir}/arschat/extensions/<name>/storage.json` に永続化する拡張専用 KV (= キーと値の対応表)。他拡張の領域には構造的に到達不能 (name でパスが決まる。name は manifest 検証済み)。
- `chat.send` / `chat.read` は Theia `ChatService` (@theia/ai-chat) 経由。m13 autotest (`arschat-chat/src/browser/arschat-m13-autotest-contribution.ts:56-83` が `ChatService.sendRequest()` を外部から駆動する実例) を参照して実装。`arschat-chat` パッケージへの依存は追加しない (@theia/ai-chat 直依存でよい)。
- `notification.show` は `MessageService.info()`。

## 3. postMessage ブリッジプロトコル

- 拡張→ホスト: `{ type: 'arschat-ext-request', extId, requestId, method, params }`
- ホスト→拡張: `{ type: 'arschat-ext-response', extId, requestId, ok, result?, error? }`
- `error` は `{ code: 'PERMISSION_DENIED' | 'UNKNOWN_METHOD' | 'INTERNAL', message }`
- ホスト側検証 (ms-13 の `SandboxRenderer.tsx:39-54` と同じ 3 段): (1) `e.source === iframe.contentWindow` の window 参照比較 (blob: URL は origin が null のため文字列比較不可)、(2) `type` 判定、(3) `extId` 一致。target origin は両方向 `'*'`。
- **権限ゲートはホスト側で強制**: method に対応する権限が `grantedPermissions` (registry に永続化された承認済み権限) に無ければ `PERMISSION_DENIED` を返す。宣言 (manifest) ではなく **承認済み** の集合で判定すること。
- 暴走防止: 1 拡張あたり同時 pending リクエスト上限 (例 20) と 1 呼び出しタイムアウトを設ける (`ArschatUiInteractionService` の `MAX_UI_INTERACTIONS` の発想を踏襲)。

## 4. 新パッケージ `arschat-extensions`

`arschat-tools` を雛形にする (`theiaExtensions` に frontend + backend、`scripts.build="tsc"`、`configs/jest.config.ts`)。**登録漏れ注意**: ルート `package.json:21-29` の workspaces、`browser-app`/`electron-app` の dependencies に追加。`configs/jest-setup.js` を作ったら必ず git add (arschat-agents で漏れた前例あり)。

### src/common (Theia runtime 非依存)
- `extension-manifest.ts` — manifest 型 + `PERMISSION_DEFINITIONS` (ID・日本語説明) + `validateManifest()` (純関数、jest 対象)
- `extension-bridge-protocol.ts` — ブリッジのメッセージ型 + `METHOD_PERMISSION_MAP` + ゲート判定純関数 (jest 対象)
- `extension-fetch-protocol.ts` — `arschatExtensionFetchServicePath = '/services/arschat-extension-fetch'` + `ExtensionFetchService` symbol + interface。型は `arschat-tools/src/common/web-fetch-protocol.ts:20-69` 踏襲

### src/node
- `extension-fetch-service-impl.ts` — GitHub からの取得のみ担当。`https://github.com/owner/repo` 形式を受け、(1) `api.github.com/repos/{owner}/{repo}` で default branch 取得 → (2) `raw.githubusercontent.com/{owner}/{repo}/{branch}/arschat-extension.json` 取得 → (3) manifest の `entry` ファイル取得。戻り値 `{ manifest 生 JSON 文字列, html }`。実装は `arschat-tools/src/node/web-fetch-service-impl.ts:69-104` の `fetch` + `AbortSignal.timeout` + サイズ上限 (HTML 1MB) パターン踏襲。**コード実行は一切しない** (取得と検証のみ)
- `arschat-extensions-backend-module.ts` — `RpcConnectionHandler` bind (`arschat-tools/src/node/arschat-tools-backend-module.ts:33-51` 踏襲)

### src/browser
- `extension-registry-service.ts` — 設置済み拡張の中枢サービス。永続化は `PersonaService` 型 (`arschat-agents/src/browser/persona-service.ts:85-128`: `EnvVariablesServer.getConfigDirUri()` + `FileService`) で `${configDir}/arschat/extensions/registry.json`。
  - registry entry: `{ name, displayName, version, description, source: {kind:'github', url} | {kind:'local', path}, grantedPermissions, enabled, installedAt }`
  - API: `installFromData(manifestText, html, source, grantedPermissions)` (github/local/autotest 共通の最終設置口。manifest 検証 → HTML を `${configDir}/arschat/extensions/<name>/main.html` に保存 → registry 追記)、`uninstall(name)` (拡張ディレクトリ + registry entry + 承認記録を削除)、`setEnabled(name, boolean)`、`update(name)` (source から再取得 → 権限差分計算 → 増分あれば呼び出し元へ差分を返して確認を促す 2 段階)、`onDidChange` Emitter
  - local (開発モード) は `FileService` で指定パスから manifest + entry を読む (Theia backend FS 経由なので絶対パス可)。設置後もコピーせず毎回実パスから読み直す (修正 → 再読み込みの開発サイクル優先)。開いた時に宣言権限が承認済み集合を超えていたら権限ダイアログを再提示
- `extension-permission-dialog.ts` — `@theia/core/lib/browser/dialogs` の `AbstractDialog` 継承 (リポジトリ内に使用前例なし、node_modules の `ConfirmDialog` 実装を参照して倣う)。表示内容: 拡張名 + 要求権限の日本語説明一覧 + 承認/キャンセル。更新時は「増えた権限」だけを差分表示するモードを持つ
- `extension-host-widget.tsx` — 拡張 1 個の UI を表示する ReactWidget (main area)。`SandboxRenderer.tsx` (arschat-chat) の Blob URL + `sandbox="allow-scripts"` + CSP meta 注入 + `e.source` 検証を踏襲した自前実装 (SandboxRenderer は interactive-ui ブロックに結合しているため import 流用はしない。CSP 文字列は同値をコピーし出典コメントを書く)。ブリッジ (§3) をここに実装
- `extension-manager-widget.tsx` + `extension-manager-contribution.ts` — 左パネル「ArsChat 拡張」ビュー。`persona-management-widget.tsx:30-68` + `persona-management-contribution.ts:17-27` の型を踏襲 (`bindViewContribution` + `WidgetFactory`)。内容: GitHub URL 入力 + ローカルパス入力の設置フォーム、設置済み一覧 (有効/無効トグル・開く・更新・削除)。設置フォーム送信 → fetch/読み込み → **権限ダイアログ → 承認時のみ** `installFromData()`。削除は `ConfirmDialog` で 1 回確認
- `arschat-m14-autotest-contribution.ts` — §7 参照
- `arschat-extensions-frontend-module.ts` — 全 bind + `RemoteConnectionProvider.createProxy` (`arschat-tools/src/browser/arschat-tools-frontend-module.ts:113-123` 踏襲)

### 永続レイアウト
`arschat-branding/src/browser/arschat-extensions-view-restorer.ts:37-45` の `RESTORED_SIDE_VIEWS` に管理ビューの `{id, area:'left'}` を追記 (文字列 ID なので import 不要)。

## 5. サンプル拡張

`sample-extensions/arschat-ext-hello/` (リポジトリ直下、新ディレクトリ):
- `arschat-extension.json` — permissions: `["chat:send", "storage:read", "storage:write"]`
- `main.html` — 自己完結。メモを storage に保存/復元する小さな UI + 「AI に送る」ボタン (chat.send)。ブリッジ呼び出しのリファレンス実装を兼ねるため、request/response の Promise ラッパーをインライン script で書き、コメントで protocol を説明

## 6. テスト

- jest (arschat-extensions/configs/jest.config.ts、`arschat-tools` の config 踏襲):
  - `validateManifest()`: 正常系 / 必須欠落 / name 不正 / 未知権限 / entry の `..` 拒否
  - ゲート判定純関数: 承認済み → ok、未承認 → PERMISSION_DENIED、未知 method → UNKNOWN_METHOD、**宣言のみで未承認は拒否** (これが旧実装との差の核心)
  - 権限差分計算 (update 時の増分検出)
- 既存スイート green 維持: `npm --prefix arschat-chat test` ほか各パッケージ

## 7. ARSCHAT_M14_AUTOTEST (Phase 3)

`arschat-m11-autotest-contribution.ts:16-65` の型 (env var ゲート → `setTimeout(16000)` → シナリオ群 → `[M14][autotest] SUMMARY: N PASS / M FAIL` を console + ILogger)。

シナリオ:
1. **install-and-gate**: インライン manifest + HTML (storage:read のみ承認) を `installFromData()` で設置 → host widget を開き、iframe 内 script から `storage.get` (ok になるはず) と `storage.set` / `chat.send` (PERMISSION_DENIED になるはず) を呼び、応答を postMessage で検証
2. **spoof-rejected**: iframe 外 (window 直接) からの偽 `arschat-ext-request` が無視されること (m13 autotest のなりすまし注入 `arschat-m13-autotest-contribution.ts:416-417` と同型)
3. **manager-docked**: 左パネルに管理ビューが存在
4. **uninstall-cleans**: シナリオ 1 の拡張を `uninstall()` → registry から消え、storage.json/main.html のディレクトリが消えている
- 後始末: テスト拡張は必ず uninstall してから SUMMARY

## 8. 実装フェーズ (コミット単位)

- **Phase 1 (e-93〜e-96)**: パッケージ scaffold + manifest/ゲートの common 層 + jest + host widget (iframe + ブリッジ) + ローカル開発モード設置 + サンプル拡張 + 管理ビュー最小 (一覧 + ローカル設置のみ)。権限ダイアログは Phase 1 では未着手でよい (設置 API に grantedPermissions を明示で渡す)
- **Phase 2 (e-97〜e-99)**: 権限確認ダイアログ + 承認永続化 + 更新の増分再確認 + GitHub 取得設置 + 管理ビュー完成 (有効/無効・削除・更新・GitHub URL フォーム)
- **Phase 3 (e-100)**: ARSCHAT_M14_AUTOTEST + BUILD_NOTES 追記 (`BUILD_NOTES.md` 末尾、MS13 エントリの 8 項目構成踏襲)

## 9. 罠・注意

1. **blob: iframe の origin は null** — postMessage の origin 文字列検証は不可。必ず `e.source` の window 参照比較 (§3)。
2. **CSP はコピーで同値維持**: `SandboxRenderer.tsx:12` の `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;`。緩めない (特に `connect-src` を足さない — 拡張の外部通信は本 MS では全面禁止)。
3. **jest に Theia browser バレルを読ませない**: `arschat-chat/configs/jest.config.ts:1-27` の moduleNameMapper スタブパターン参照。common 層を純関数にしておけばスタブ最小で済む。
4. **`initializeLayout()` はフレッシュレイアウト初回のみ** (ms-12 の罠): 既存プロファイルで管理ビューを出すには restorer への追記 (§4 末尾) が必須。
5. **ダイアログの完了待ち**: `AbstractDialog.open()` は Promise を返す。承認結果が undefined (キャンセル/ESC) の場合は設置しない。
6. dispose 漏れ: host widget の `message` listener と Blob URL は widget dispose で必ず解放 (`SandboxRenderer.tsx:32` の revokeObjectURL 相当)。
