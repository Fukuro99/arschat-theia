# MS13 実装ブリーフ: AI がチャット内に操作 UI を描画できる (インタラクティブ UI 移植)

> 調査担当 (Sonnet) 作成、指揮 (Fable) 編集。node_modules 実測済み。実装は Codex CLI に委任。
> 参照 SPEC: `docs/specs/ms-13-spec-ai-がチャット内に操作-ui-を描画できる-インタラクティブ-ui-移植.md`
> 確定済み設計判断 (変更不可): tool call 方式 (レガシーのコードブロック記法は移植しない) / 3 方式すべて (プリミティブ default+live / 表示専用 HTML / 操作通知付き HTML) / スキル発動時のみ UI ツール公開 / iframe は sandbox="allow-scripts" のみ (allow-same-origin なし)。

## 0. ツールセットと担当タスク (指揮側決定)

| ツール ID | 役割 | 待機挙動 | タスク |
|---|---|---|---|
| `arschat_render_ui` | プリミティブ UI 描画 (default / live) | default: ユーザー送信まで pending → 送信データを返す。live: 最初の操作まで pending → 操作を返す | e-84, e-85 |
| `arschat_update_ui` | live UI への patch 適用 | patch 適用後、次の操作まで pending → 操作を返す。`status:"finished"` の patch なら即 return | e-85 |
| `arschat_render_html` | 表示専用サンドボックス HTML | 即 return ("rendered") | e-86 |
| `arschat_render_interactive_html` | 操作通知付きサンドボックス HTML | 最初の postMessage 操作まで pending → 操作を返す。更新は `arschat_update_ui` を共用 (ui_id で振り分け、patch は postMessage で iframe へ転送) | e-87 |

Phase 分割: **Phase 1** = e-82 (スキル連動ゲート) + e-83 (プリミティブ移植) + e-84 (render_ui default モード)。**Phase 2** = e-85 (live) + e-86 + e-87 (サンドボックス)。**Phase 3** = e-88 (M13 AUTOTEST + BUILD_NOTES)。jest は各 Phase 内で随時追加。

## 1. ツール実行 promise 待機の実態

**結論**: handler が長時間 pending でも問題ない。承認カードは `ToolCallChatResponseContentImpl` の 3 つの Deferred (`needsUserConfirmation` / `confirmed` / `whenFinished`) を両側から resolve/await する構造で、デフォルト設定 (タイムアウト 0 = 無効) では無期限に待てる。キャンセル経路も実装済み。

- `node_modules/@theia/ai-chat/src/browser/chat-tool-request-service.ts:41-103` — `FrontendChatToolRequestService.toChatToolRequest()`。CONFIRM 分岐 (64-99): 86 行 `requestUserConfirmation()`、87 行 `fireInteractionNeeded()`、88 行 `raceConfirmationWithTimeout()` で実ブロック、91-95 行 confirmed 後に `handler` 実行 → `complete(result)`。
- `node_modules/@theia/ai-chat/src/common/chat-model.ts:2296-2446` — `ToolCallChatResponseContentImpl` の Deferred 実装 (`confirm` 2407 / `deny` 2413 / `cancelConfirmation` 2429 / `complete` 2435)。
- タイムアウト既定 0 (無効): `node_modules/@theia/ai-chat/src/common/chat-tool-preferences.ts:78-84`。race 実装: `chat-tool-confirmation-timeout.ts:28-55`。
- キャンセル: `chat-model.ts:3036-3054` `cancel()` が全 toolCall に `cancelConfirmation(new Error('Chat request canceled'))` → `confirmed` await が reject。呼び出し元は `chat-service.ts:383-385`、arschat 側は `arschat-chat-widget.tsx:859-863` `abort()`。
- **注意 (指揮側)**: `cancel()` が reject するのは Theia の confirmation promise だけ。M13 独自の Deferred (§5) は自前でキャンセル連動させること — handler に渡る `ctx` の cancellationToken (`ToolInvocationContext.create(toolCallId?, cancellationToken?)`, `@theia/ai-core/src/common/language-model.ts:192-223`) を race するか、widget の `abort()` から `ArschatUiInteractionService.rejectAll()` を呼ぶ。実装時にどちらが確実か node_modules で最終確認。

## 2. 1 応答内の連続 tool call ループ (live モードの成立条件)

**結論**: ループ制御はプロバイダアダプタ側。OpenAI 系 (LM Studio 含む) は SDK `runTools()` で **上限 100 回**、Anthropic は自前再帰で **上限なし**。live モードは「ユーザー操作を待つツール呼び出し = アダプタの 1 イテレーション」としてそのまま成立する。

- `node_modules/@theia/ai-openai/src/node/openai-language-model.ts:75-80` `maxChatCompletions: 100`、146-169 行 `runTools()` 委譲、219-229 行 `createTools()` は `tool.handler` を直接渡す。ループ実体: `node_modules/openai/lib/AbstractChatCompletionRunner.js:206` (100 回到達は静かに抜けるだけ)。
- `node_modules/@theia/ai-anthropic/src/node/anthropic-language-model.ts:354-390` — handler 実行後に `handleStreamingRequest()` を自己再帰、上限なし。
- LM Studio = OpenAI アダプタの裏取り: `arschat-providers/src/browser/arschat-providers-seed-contribution.ts:4-11`、`arschat-tools/src/browser/arschat-m5-live-contribution.ts:16-21`。
- **指揮側決定**: 暴走防止のため arschat 側で **1 つの UI につき操作往復 50 回** を上限とし、超過時は `arschat_update_ui` が `{ error: "interaction limit reached", status: "finished" }` を返して UI を終了させる。

## 3. スキル発動と連動したツール公開ゲート (e-82)

**結論**: `additionalToolRequests` は `AbstractChatAgent.invoke()` がリクエスト毎に読む (`chat-agents.ts:253-258`、257 行)。`send()` 内で `sendRequest()` 直前に `setToolRequests()` を呼べば 1 リクエスト単位で切り替わる。**案 A を採用**。

- 現状配線: `arschat-agents/src/browser/arschat-chat-agent.ts:59-70` `setToolRequests()`、呼び出しは `arschat-tools/src/browser/arschat-tools-frontend-module.ts:72-84` の onStart 1 回のみ。
- スキル発動判定: `arschat-agents/src/browser/skill-service.ts:205-218` `expandInput()` (同期、skill id はここで確定するが現状戻り値に含まれない → 拡張が必要)。
- 差し込み点: `arschat-chat/src/browser/arschat-chat-widget.tsx:865-920` `send()` — 881 行 `expandInput()` の直後、917 行 `sendRequest()` の直前。widget は `ChatAgentService` DI 済み (148-149 行)。
- **実装方針 (案 A)**:
  1. スキル frontmatter に `tools:` フィールド (ツール ID の配列) を追加 — `arschat-agents/src/common/skill.ts` / `skill-parser.ts` の型・パーサ拡張。
  2. `expandInput()` の戻り値に発動 skill (id + tools) を含める拡張。
  3. `send()` で「ベースツール (M5 の常設 6 ツール) ∪ 発動スキルの tools」を計算して `agent.setToolRequests()` → `sendRequest()`。
  4. **セッション sticky**: 一度 UI スキルを発動したセッションでは、以降のターンも UI ツールを維持する (`ArschatChatWidget` にセッションスコープの `activeSkillToolIds` を保持)。live モード 2 ターン目が スキル再指定なしで動くために必須。
  5. インタラクティブ UI の組み込みスキルを SAMPLE_SKILLS と同じ seed 機構で追加 (`/ui` トリガー、body は UI ツールの使い方ガイド)。seed は初回のみなので、既存ユーザー向けに「無ければ追記」の冪等 seed になっているか確認して踏襲。

## 4. widget での UI ツールのカスタム描画

**結論**: `arschat-chat-widget.tsx:1882-1884` の `msg.toolCalls.map(view => this.renderToolCard(view))` を tool 名で分岐させるだけ。`syncToolCalls()` (1023-1045) / `wireToolCall()` (1061-1093) は tool 名非依存なのでそのまま流用。

- 引数 JSON は 2 段階: ストリーミング中は `ToolCallArgumentsDeltaContent` で部分連結 (`chat-model.ts:780-792`, 2456-2479)。handler 起動時点では完成済み (`chat-tool-request-service.ts:44`)。
- **実装方針**: カスタムカードは `JSON.parse(view.content.arguments)` を try/catch し、parse 成功までプレースホルダ (「UI を準備中…」) を表示。parse 成功後にフォームを描画。UI ツールは承認フロー非経由 (§5) なので、フォーム操作可否は「送信済みか / finished か」だけで判定。

## 5. ユーザー操作をツール結果として返す経路 (confirm() は使わない)

**結論**: `confirm()`/`deny(reason?)` は真偽値ゲート専用 (`chat-model.ts:572-576`、deny の reason は拒否理由文字列のみ 2413-2420)。フォームデータは運べない。**独自 Deferred サービス案を採用**。

- **実装方針**:
  1. 新規 browser シングルトン `ArschatUiInteractionService`: `Map<toolCallId, Deferred<unknown>>` を保持し `await(toolCallId)` / `resolve(toolCallId, data)` / `rejectAll(reason)` を公開。`Deferred` は `@theia/core/lib/common/promise-util`。
  2. `render-ui-tool-provider.ts` (frontend-only、`edit-file-tool-provider.ts:18-33` と同型) が同サービスを注入し、handler 内で `ctx?.toolCallId` をキーに await。toolCallId は widget 側 `ToolCallView.content.id` と同一値 (`chat-tool-request-service.ts:56/92` で `ToolInvocationContext.create(toolCallContent.id)`)。
  3. カスタムフォームの送信ボタンが `uiInteractionService.resolve(view.content.id, formData)`。
  4. UI ツールは承認パイプライン (needsUserConfirmation/confirmed) を経由させない (誤って許可/拒否ボタンが出る事故を防ぐ)。`confirmAlwaysAllow` 相当の扱いで登録。
  5. `ToolCallChatResponseContent.data` フィールドへの書き込み + ポーリング案は不採用 (変更通知がなく複雑化するため)。
  6. キャンセル連動: §1 注意書きの通り。widget `abort()` (859-863) から `rejectAll()` を呼ぶのが最小実装。reject 時の tool result は `{ cancelled: true }` を返して LLM 側を壊さない。

## 6. レガシー移植資産 (e-83)

**結論**: `C:\Users\takep\source\ArsChat\src\renderer\components\interactive-ui\` 全 19 ファイル 1641 行 + styles.css (35 クラス)。外部依存は react のみ。React 18.3.x で両リポジトリ完全互換 (`@theia/core/shared/react` は re-export シム)。`.iui-*` クラスは arschat-theia 側と衝突なし (grep 0 件)。

- **要対応**: `design-tokens.ts:62-79` の `colorMap` が legacy 専用 CSS 変数 `var(--aria-*)` (定義元 `ArsChat/src/renderer/styles/globals.css:6-13`) を参照。arschat-theia に `--aria-*` は存在しない (grep 0 件)。**`--theia-*` へ書き換える**: primary → `--theia-button-background`、bg → `--theia-editor-background`、surface → `--theia-editorWidget-background`、text → `--theia-foreground`、muted/secondary → `--theia-descriptionForeground`、border → `--theia-editorGroup-border`。既存パターン同様フォールバック値付き (`var(--theia-foreground, #ccc)`)。success/warning/danger/black/white/dark/light はハードコード 16 進のため変更不要。
- **要対応**: `Input.tsx` は CORE doc「IME を扱う入力欄は uncontrolled で作る」に従い uncontrolled (defaultValue + ref 読み出し) に作り替える。レガシー実装が controlled なら移植時に修正。
- parser.ts (コードブロック記法パーサ) は移植不要 (tool call 方式のため)。types.ts の `InteractiveUIBlock` / `UINode` 型と `state-manager.ts` の `mergePatch` は流用。
- 置き場所: `arschat-chat/src/browser/interactive-ui/` 配下 (widget と同パッケージ。ツール定義は arschat-tools、描画は arschat-chat という既存分担に合わせる)。

## 7. サンドボックス HTML (e-86, e-87)

- レガシー `SandboxRenderer.tsx` (85 行): iframe + Blob URL + `sandbox="allow-scripts"` のみ、postMessage 中継、`isFinished` で `pointerEvents:'none'`。この構造をそのまま踏襲。
- iframe 内 → 親: `postMessage({ type: 'interactive-ui-action', uiId, action, data }, '*')`。親 → iframe: `postMessage({ type: 'interactive-ui-update', uiId, patch }, '*')`。uiId 不一致・finished 後のメッセージは無視 (なりすまし/遅延耐性)。
- 画像 URL 許可リスト (data:/blob:/相対のみ、`primitives/Image.tsx:52-72`) を踏襲。

## 8. autotest (e-88, Phase 3)

**結論**: `arschat-tools/src/browser/arschat-m5-autotest-contribution.ts` の型を踏襲。モック `LanguageModel` を `LanguageModelRegistry.addLanguageModels()` で登録し、実経路 (`ChatService.sendRequest()`) を通して状態機械を外から駆動する。

- 構造: 有効化 212-222 行 (env var + 15 秒待ち)、モック 103-167 行 (`tool_calls` yield → `tool.handler()` 直接 await → 結果 yield)、外部からの解決 399-478 行 `driveToolCall()`。agent の向き先変更は 234-242 行 `pointAgentAtMock()` (2 経路上書き必須)。
- M13 追加部品: (1) `arschat_render_ui` の plan、(2) `ArschatUiInteractionService.resolve(toolCallId, formData)` を直接呼んでフォーム送信を模擬、(3) UI ツールは confirmation 非経由のため `onInteractionNeeded` に乗らない — `ToolCallChatResponseContent` の id を response content 走査で拾って resolve する。
- シナリオ案: フォーム描画→送信→tool result 注入 / live 2 往復→finished で無効化 / サンドボックス描画 / スキル未発動時に UI ツールが LLM に渡らない。

## 9. 実装上の注意 (指揮側)

- テスト: 承認フロー同様、Theia 実クラス (`ToolCallChatResponseContentImpl` 等) をモックせず直接使う (BUILD_NOTES 658 行の慣例)。
- 尊重する既存慣例: frontend-only ToolProvider は pure factory + 薄い @injectable ラッパー (`edit-file-tool-provider.ts`)、tool ID は `arschat-tools/src/common/tool-ids.ts` に集約、frontend module で `bindToolProvider()`。
- 「Theia のフォーカス依存コマンドは独自 UI から呼ばない」(CORE doc) — UI 部品のアクションから Theia コマンドを叩く実装はしない。
- BUILD_NOTES への追記は Phase 3 でまとめて (作業日 / 使った Theia 機構 / 実装構成 / 判断根拠 / ハマった点 / 検証結果 / 実機確認できなかった項目)。
