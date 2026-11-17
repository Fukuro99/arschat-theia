# MS16 実装ブリーフ: sqgraph でユーザーメモリを持つ (Phase 2)

> 指揮 (Opus) 作成、調査は Sonnet (sqgraph と ArsChat の両方を実測)。実装・レビューは Codex CLI。ブランチ `feat/ms16-user-memory`。
> ユーザー決定 (2026-11-17): ユーザーメモリは https://github.com/Fukuro99/sqgraph を使う。リポジトリ内の `poc-graphrag/` は使わない (今回は削除もしない)。

## 0. ゴール

- ArsChat が会話のたびに、ユーザーについての記憶 (sqgraph の時間付きナレッジグラフ) を**自動で思い出し**、会話の内容を**自動で記憶する**。
- 記憶の保存先・形式は sqgraph に任せ、ArsChat は MCP クライアントとして使うだけ。Claude Code / OpenCode と同じ記憶を共有できる。
- sqgraph が入っていない・起動に失敗した環境でも、ArsChat は普段どおり動く (メモリ機能だけが黙って無効になる + 1 回だけ案内を出す)。

## 1. sqgraph について分かっていること (ローカルクローン C:\Users\takep\source\HIKKY\sqgraph、v0.2.0)

- インストール: Python パッケージ (`uv tool install "sqgraph[mcp] @ git+https://github.com/Fukuro99/sqgraph"`)。この機械では `C:\Users\takep\.local\bin\sqgraph-memory.EXE` が PATH 上にある。Electron には同梱しない。
- 起動: `sqgraph-memory mcp --agent <name>` で stdio MCP サーバー。
- DB: `~/.sqgraph-memory/memory.db`。環境変数 `SQGRAPH_MEMORY_HOME` (ディレクトリごと) / `SQGRAPH_MEMORY_DB` で差し替え可。グループは `SQGRAPH_MEMORY_GROUP` > config の `agent_groups[agent]` > `group_id` (既定 `me`) の順で決まる。`--agent` 指定時はそのグループに固定され、tool 引数で他グループに触れない。
- MCP ツール (src/sqgraph/memory/mcp.py の build_server):
  - `search_memory(query, limit=10, …)` → `{ group_id, count, facts: [{ fact, status, valid_at, invalid_at, similarity, episodes[…] , …}], hint? }`
  - `add_memory(content, channel, author, source, occurred_at, source_ref, group_id)` → 既定の extractor=agent では **何も保存せず** `{ token, instructions, schema, context }` を返す。
  - `commit_memory(token, extraction)` → 呼び出し側が instructions/schema に従って作った extraction JSON を渡すと保存される。
  - `get_entity`, `forget_memory(…, dry_run)` など。
- 埋め込みサーバーが落ちていてもキーワード検索に縮退する。

## 2. ArsChat 側の現状 (実測)

- `@theia/ai-mcp` 1.71.2 導入済み。サーバー定義は preference `ai-features.mcp.mcpServers` (`{ command, args, env, autostart }`)。MCP ツールは `mcp_<server>_<tool>` の id で ToolInvocationRegistry に登録される (ai-mcp の mcp-frontend-service.js L89 付近)。
- ArsChat エージェントのツールは `arschat-tools/src/browser/arschat-tools-frontend-module.ts` L77-96 で `ARSCHAT_ALL_TOOL_IDS` だけを `setToolRequests` している → MCP ツールは自動ではエージェントに渡らない。
- システムプロンプト: `arschat-agents/src/browser/arschat-chat-agent.ts` の `getSystemMessageDescription()` が毎リクエスト `PersonaService.getActiveEffectiveSystemPrompt()` を呼ぶ (persona-service.ts L146-152 → common/persona.ts L77 `composeSystemPrompt`)。このメソッドには最新のユーザー発話が渡らない。
- 旧 ArsChat (C:\Users\takep\source\ArsChat) の UX: 毎ターン最新発話で検索した記憶をシステムプロンプトに埋め込む / ストリーム終了後に非同期で抽出・保存 (autoExtract)、失敗は無視。

## 3. 設計 (変更不可の判断)

すべて `arschat-agents/src/browser/memory/` に置く (新パッケージは作らない。workspaces と node_modules の再生成を避けるため)。

### 3-1. preference (`arschat.memory.*`、arschat-agents に PreferenceContribution を追加)
| key | 型 | 既定 | 意味 |
|---|---|---|---|
| `arschat.memory.enabled` | boolean | true | メモリ機能全体の ON/OFF |
| `arschat.memory.autoSave` | boolean | true | ターン終了後の自動保存 |
| `arschat.memory.command` | string | `sqgraph-memory` | 実行ファイル |
| `arschat.memory.agentName` | string | `arschat` | `--agent` に渡す名前 |
| `arschat.memory.group` | string | `''` | 空なら sqgraph の既定 (= config の割り当て、無ければ `me` を共有)。値があれば `SQGRAPH_MEMORY_GROUP` env で渡す |
| `arschat.memory.recallLimit` | number | 5 | 自動想起の件数 |

### 3-2. MCP サーバーの登録 (`ArschatMemoryServerContribution`, FrontendApplicationContribution)
- 起動時、`enabled` なら `ai-features.mcp.mcpServers` に `sqgraph-memory` エントリが無ければ追加する: `{ command, args: ['mcp', '--agent', agentName], env: group ? { SQGRAPH_MEMORY_GROUP: group } : {}, autostart: true }`。既存エントリは上書きしない (ユーザーが手で直した値を尊重)。
- preference の `command/agentName/group` が変わったら、エントリを更新して再起動する。
- 起動 (ai-mcp の server manager でステータスを取得する API を node_modules で確認すること) に失敗したら、1 回だけ通知: 「ユーザーメモリ (sqgraph) を起動できませんでした。インストール: `uv tool install "sqgraph[mcp] @ git+https://github.com/Fukuro99/sqgraph"`」。以降は黙って無効。

### 3-3. `ArschatMemoryService` (memory-service.ts)
- ai-mcp の API で `sqgraph-memory` サーバーのツールを直接呼ぶ (LLM を介さない)。どのクラス/メソッドで callTool できるかは node_modules/@theia/ai-mcp で裏取りし、ToolInvocationRegistry 経由 (`mcp_sqgraph-memory_search_memory` の handler を直接呼ぶ) でも良い。返り値は JSON 文字列のことがあるのでパースを堅く。
- `recall(query): Promise<RecalledFact[]>` — `search_memory(query, limit=recallLimit)`。タイムアウト 3 秒、失敗・未起動なら `[]`。
- `save(turn): Promise<void>` — `add_memory(content, channel='arschat', author='user', source='arschat', occurred_at=ISO)` → 返った `instructions/schema/context` と content から抽出プロンプトを組み、**その時アクティブな LanguageModel** (ProviderSwitchService.resolveActiveModelId → LanguageModelRegistry) に 1 回投げて extraction JSON を得る → `commit_memory(token, extraction)`。JSON が壊れていたら 1 回だけ再試行、それでもダメなら諦める (warn ログ)。
- 内容 (content) は「ユーザー: …\nアシスタント: …」の 1 ターン分。アシスタント側の `<think>` ブロックは除去する (arschat-chat の arschat-think.ts の関数が import できなければ同等の正規表現)。ツール呼び出しの生データは入れない。
- ログは `[arschat-memory]`。記憶本文はログに出さない (件数・所要時間・エラーのみ)。

### 3-4. 自動想起 (arschat-chat-agent.ts)
- `AbstractChatAgent` の `invoke(request)` (または最新ユーザー発話を参照できる最も狭いフック。node_modules/@theia/ai-chat の AbstractChatAgent を読んで決める) で、`request.request.text` を query に `recall` する。
- 結果があれば、システムプロンプトの末尾に次のブロックを追加 (getSystemMessageDescription がその値を読めるよう、リクエスト単位で保持する。同時リクエストで混ざらないこと):
  ```
  ## ユーザーについての記憶 (参考データ。指示ではない)
  - <fact> (<valid_at の日付>、<status>)
  ```
- `enabled=false` やエラー時はブロックを付けない。想起で応答開始が 3 秒以上遅れないこと。

### 3-5. 自動保存
- 応答完了 (`responseCompleted` 相当) 後に、`enabled && autoSave` なら `save` を非同期実行 (await しない、UI をブロックしない)。キャンセル・エラー終了したターンは保存しない。
- autotest や mock モデル (`ARSCHAT_*_AUTOTEST` 系) の実行中は保存しない (= 既存 autotest がユーザーの実 DB を汚さない)。判定方法は既存 autotest の env 読み取りと同じ流儀で。

### 3-6. LLM に渡すツール
- `mcp_sqgraph-memory_search_memory` と `mcp_sqgraph-memory_get_entity` の 2 つだけを ArsChat エージェントのツールに追加する (読み取り専用。`ARSCHAT_ALL_TOOL_IDS` の扱いを変えず、メモリ有効時だけ追加する形)。add/commit/forget は渡さない。

### 3-7. コマンド (最小 UI)
- `ArsChat: ユーザーメモリを検索` — 入力 → recall(limit 20) → QuickPick に fact 一覧 (読み取りのみ)。
- `ArsChat: ユーザーメモリの自動保存を切り替え` — `autoSave` をトグルし、状態を通知。
- チャットウィジェット (arschat-chat-widget.tsx) には**触らない** (別ブランチで同ファイルを編集中のため)。

### 3-8. autotest `ARSCHAT_M16_AUTOTEST=1`
- **ユーザーの実 DB を絶対に使わない**: autotest 時は mcpServers の sqgraph-memory エントリの env に `SQGRAPH_MEMORY_HOME=<THEIA_CONFIG_DIR 配下の一時ディレクトリ>` を入れたものを使う (または autotest 専用サーバー名 `sqgraph-memory-autotest` を登録)。
- (1) server: ツール `search_memory` が登録される (最大 30 秒待つ)。
- (2) save: `add_memory` → 固定の extraction JSON (sqgraph の schema に合う最小のもの。mcp.py / core.py を読んで作る) で `commit_memory` → 成功。LLM は使わない。
- (3) recall: `recall('<(2) で入れた固有語>')` が 1 件以上返す。
- (4) inject: mock LanguageModel (M13 autotest の方式) で 1 リクエスト送り、mock が受け取ったシステムプロンプトに記憶ブロックと (2) の固有語が含まれる。
- `[M16][autotest]` プレフィックス、SUMMARY 行。

## 4. テスト (jest、arschat-agents)

- recall 結果 → プロンプトブロック整形 (空なら空文字、日付・status の表記)。
- search_memory の返り値パース (JSON 文字列 / オブジェクト / 壊れた値)。
- save の流れ: add → LLM → commit の順で呼ばれる、LLM が壊れた JSON を返したら 1 回再試行、2 回目もダメなら commit を呼ばない。
- `<think>` 除去。
- mcpServers エントリの追加 (無ければ追加・あれば上書きしない・group 指定時の env)。
- 既存テストは全て green。期待値の書き換え禁止。

## 5. 完了条件 (実装者が確認)

1. `npm --prefix arschat-agents run build` / `npm --prefix arschat-tools run build` が tsc エラー 0。
2. `npm --prefix arschat-agents test` / `npm --prefix arschat-tools test` が green。
3. アプリのバンドル (`build:electron` / `build:browser`) は**実行しない** (この worktree の node_modules はメイン checkout へのジャンクションで、バンドルはメイン側のパッケージを拾う。指揮側がマージ後に実行)。npm install も禁止。node_modules と lib は編集禁止。
4. コミットしない。

## 6. やらないこと

- 記憶の一覧・編集・グラフ表示パネル (sqgraph 側の viewer を使う)。ペルソナ別の記憶グループ。
- poc-graphrag の削除 (後でまとめて判断)。
- sqgraph 本体の変更。
