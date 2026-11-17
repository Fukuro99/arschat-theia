# MS9 実装ブリーフ: API キーを OS の金庫にしまう

> 指揮 (Opus) 作成、調査は Sonnet (node_modules 実測)。実装・レビューは Codex CLI。
> 前提ブランチ: `integration/2026-11-17` (ローカル LLM・拡張ビュー修正・ms-16 を統合済み) から切った `feat/ms9-keychain`。PROVIDERS にはローカル系 6 種がある。worktree の node_modules はメイン checkout へのジャンクションなので npm install・アプリのバンドル (`build:electron`) は実行しないこと (完了条件 3 は指揮側がマージ後に実施)。

## 0. ゴールと完了条件

- Anthropic / OpenAI のグローバル API キーと、カスタムエンドポイント (customOpenAiModels / customAnthropicModels) の文字列 `apiKey` を、Theia の `KeyStoreService` (Windows は keytar → 資格情報マネージャー) に保存する。
- 平文 preference に残っている既存キーは起動時に金庫へ移し、読み戻しで一致を確認できた時だけ preference から消す。
- チャットヘッダーに「API キー」ボタンを置き、プロバイダごとに保存・削除できる。キー本体は画面に再表示しない。
- 完了条件: Windows 実機で保存 → 再起動 → そのキーで応答が返る。settings.json にキーが残らない。他 OS は未検証で可 (BUILD_NOTES に明記)。

## 1. 調査で分かっていること (file:line は node_modules/@theia 配下の src)

- `core/src/common/key-store.ts:16-28` — `KeyStoreService` (setPassword / getPassword / deletePassword / keys …)。パス `/services/keyStore`。frontend では `@inject(KeyStoreService)` で RPC proxy が使える (`core/src/browser/frontend-application-module.ts:421-423`)。
- `core/src/node/key-store-server.ts` — keytar を動的 import。失敗すると **InMemoryCredentialsProvider に黙ってフォールバック** (console.warn のみ)。この場合は永続化されない。
- Anthropic: `ai-anthropic/src/browser/anthropic-frontend-application-contribution.ts`
  - L83-84: onStart の `preferenceService.ready.then` で `manager.setApiKey(preference 値)`。preference が空だと `setApiKey(undefined)` になる。
  - L99: preference 変更時に setApiKey + updateAllModels。
  - L170: 標準モデルは `apiKey: true` (= グローバルキー)。
  - L207 `createCustomModelDescriptionsFromPreferences`: カスタムエンドポイントの `apiKey` (string | true) を description にそのまま載せる。
- OpenAI: `ai-openai/src/browser/openai-frontend-application-contribution.ts` の L42-43 / L58 / L131 / L164 / L103 が同じ構造。
- backend の manager は `_apiKey ?? process.env.ANTHROPIC_API_KEY` (OpenAI も同様)。apiKeyProvider はリクエストごとに評価される。
- Theia 1.71 に secret preference や移行ヘルパーは無い。
- ArsChat 側でキーを平文で読んでいる箇所: `arschat-providers/src/browser/provider-switch-service.ts` の `resolveCustomEndpointAuthHeader` (`/models` 取得用)。
- 秘密ではない既定値: `sk-unsloth-local` (Unsloth のシード)。移行・削除の対象外。

## 2. 設計 (変更不可の判断)

1. **保存先**: service = `arschat`、account = `anthropic` / `openai` / `custom:<endpoint id>`。
2. **新サービス `ArschatSecretStore`** (arschat-providers/src/browser/arschat-secret-store.ts)
   - `KeyStoreService` を inject した薄いラッパー。`ready(): Promise<void>` で起動時に全 account を先読みしてメモリキャッシュする。
   - `get(account)`: 同期 (キャッシュ参照)。`set` / `delete`: 非同期 (金庫 + キャッシュ)。`onDidChange` イベント。
   - 金庫への書き込みに失敗したら例外を投げる (UI でエラー表示)。
3. **注入**: Theia の 2 つの frontend contribution (Anthropic / OpenAI) を、本体を改変せず **サブクラスで rebind** する (`rebind(AnthropicFrontendApplicationContribution).to(ArschatAnthropicFrontendContribution)` のように。実際の bind 形態 (クラス自身を bind しているか、FrontendApplicationContribution の multi-bind か) は node_modules の frontend module で確認し、二重登録にならない方法を選ぶこと)。
   - グローバルキー: preference 値ではなく `secretStore.get('anthropic' | 'openai')` を `setApiKey` に渡す。preference 側にまだ値があれば (移行前) それを優先して構わないが、移行後は空になる。
   - カスタムエンドポイント: `createCustomModelDescriptionsFromPreferences` を override し、エントリに文字列 `apiKey` が無く、かつ金庫に `custom:<id>` があれば、その値を description の `apiKey` に入れる。
   - 金庫の値が変わったら (`onDidChange`) setApiKey と models 再登録をやり直す。
   - 環境変数フォールバック (ANTHROPIC_API_KEY / OPENAI_API_KEY) は manager 側の挙動のまま残す。
4. **移行** (新 contribution、起動時に 1 回、冪等)
   - preference の `ai-features.anthropic.AnthropicApiKey`、`ai-features.openAiOfficial.openAiApiKey`、customOpenAiModels と customAnthropicModels 内の文字列 `apiKey` (ただし `sk-unsloth-local` と `true` は除外) を走査する。User と Workspace の両スコープ。
   - 金庫に同じ account が既にあれば上書きしない (preference 側は消してよい)。無ければ set → get で読み戻して一致を確認 → 一致した時だけ preference から削除 (グローバルは空文字ではなく `undefined` で消す / custom はエントリから `apiKey` フィールドを除去)。不一致や例外なら preference を残し、warn ログ。
   - ログは `[arschat-secrets]` プレフィックス。キー本体は絶対にログに出さない (先頭 4 文字 + `…` まで可)。
5. **ProviderSwitchService** の `resolveCustomEndpointAuthHeader`: 文字列 apiKey が無ければ `secretStore.get('custom:<id>')` を使う。`apiKey === true` の時は preference ではなく `secretStore.get('openai')` を使う (preference に残っていればそれも可)。
6. **UI**: チャットヘッダーのターミナルボタンの隣に「API キー」ボタン。押すと Theia の `ReactDialog` (または `AbstractDialog`) で一覧を出す。
   - 行: Anthropic / OpenAI / 各カスタムエンドポイント (customEndpointProviders() の 6 種)。
   - 各行: 状態 (`保存済み` / `未設定` / `環境変数を使用中` は判別できないので出さなくてよい)、`type="password"` の入力欄、保存ボタン、削除ボタン。
   - IME 対策は不要 (password 欄) だが、入力欄は uncontrolled で作ること (docs/specs/ime-を扱う入力欄は-uncontrolled-で作る.md の規約)。
   - Theia のフォーカス依存コマンドを独自 UI から呼ばない (docs/specs/theia-のフォーカス依存コマンドは独自-ui-から呼ばない.md)。
   - 金庫が使えず in-memory にフォールバックしている可能性がある旨の注意書きは不要 (判定不能なため)。代わりに保存失敗時のエラー表示をする。
7. **autotest** `ARSCHAT_M9_AUTOTEST=1` (backend env、他 autotest と同じ流儀、未設定時は no-op):
   - (1) roundtrip: account `autotest:m9` に set → get で一致 → delete → get が undefined。
   - (2) migration: user スコープの customOpenAiModels に `{ id: 'm9-autotest', model: 'x', url: 'http://localhost:1/v1', apiKey: 'sk-m9-autotest-dummy' }` を入れて移行処理を呼ぶ → 金庫に `custom:m9-autotest` があり、preference のエントリから apiKey が消えている → 後片付けでエントリと金庫の値を消す。
   - (3) injection: 金庫に `anthropic` が無い状態で起動しても setApiKey(undefined) で落ちないこと (ログ確認のみ)。
   - `[M9][autotest]` プレフィックス、最後に SUMMARY。

## 3. テスト (jest)

arschat-chat の既存テスト (`arschat-chat-widget.test.ts` で ProviderSwitchService を直接 new している流儀) に合わせ、KeyStoreService を Map ベースでモックする。
- 移行: 冪等 (2 回呼んでも結果同じ)、読み戻し不一致なら preference を消さない、`sk-unsloth-local` と `true` を除外、User/Workspace 両スコープ。
- secretStore: ready で先読み、set/delete で onDidChange 発火、書き込み失敗で例外。
- 注入: override した `createCustomModelDescriptionsFromPreferences` が金庫の値を apiKey に入れる / 文字列 apiKey があればそちら優先。
- ProviderSwitchService の Authorization ヘッダーが金庫の値を使う。既存の 2 テスト (L750 付近の `sk-unsloth-test` と `apiKey: true`) は挙動を保って通ること。

## 4. 完了条件 (実装者が確認)

1. `npm --prefix arschat-providers run build` / `npm --prefix arschat-chat run build` が green。
2. `npm --prefix arschat-chat test` が全 green (既存テストの期待値の書き換え禁止)。
3. (アプリのバンドルは指揮側が実施。ここでは実行しない)
4. コミットしない。node_modules と lib は編集禁止。

## 5. やらないこと

- Theia 本体の改変。safeStorage など keytar 以外の仕組みの導入。
- 他 OS の実機確認。
